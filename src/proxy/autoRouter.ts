/**
 * Auto Smart Router.
 *
 * Provides the virtual "Auto (Smart Router)" model: when the IDE routes a
 * request to it, the proxy inspects the Gemini request (images, code, length,
 * tags) and picks the best user-configured custom model for the job, with a
 * fallback chain and local context compression when no window fits.
 *
 * This module is intentionally Electron-free so it can be unit-tested
 * directly. Type-only import of CustomModel keeps the runtime dependency
 * graph one-way (proxy -> autoRouter).
 */

import type { CustomModel } from '../proxy';
import { detectModelCapabilities } from './modelUtils';
import { smartHealth } from './smartHealth';

// ─── Constants ────────────────────────────────────────────────────────────

export const AUTO_EXTERNAL_NAME = 'auto-router';
export const AUTO_DISPLAY_NAME = 'Auto (Smart Router)';

const IMAGE_FLAT_TOKENS = 1100; // safe overestimate per image part
const ANSWER_HEADROOM = 2048; // room for the model's reply
const CHARS_PER_TOKEN = 4; // rough average for code+prose
const MAX_CHAIN = 4;

const CODE_PATTERN =
  /```|\b(?:class|def|function|import|export|const|traceback|exception|compile|refactor|regex|stacktrace)\b|=>|;/i;

// Task -> name hints, first match wins. Matched against externalModelName +
// displayName (lowercased) of the configured models.
const FAMILY_HINTS: Record<string, string[]> = {
  code: ['deepseek', 'coder', 'codestral', 'qwen3', 'claude', 'gpt-4o', 'llama-3.3', 'gemini'],
  vision: ['gemini', 'gpt-4o', 'claude', 'vision', 'llava', 'pixtral'],
  long: ['gemini', 'gpt-4o', 'claude', 'llama-3.3', 'deepseek'],
  quick: ['mini', 'flash', 'nano', 'haiku', '8b', '3b', 'small', 'lite'],
  chat: ['deepseek', 'claude', 'gpt-4o', 'llama', 'qwen', 'gemini'],
};

// ─── Types ────────────────────────────────────────────────────────────────

export interface AutoGeminiPart {
  text?: string;
  inlineData?: { mimeType?: string; data?: string };
  fileData?: { mimeType?: string; fileUri?: string };
  thought?: boolean;
  [key: string]: unknown;
}

export interface AutoGeminiBody {
  systemInstruction?: { parts?: AutoGeminiPart[] };
  contents?: { parts?: AutoGeminiPart[]; role?: string }[];
}

export interface RoutePlan {
  chain: CustomModel[];
  task: string;
  reason: string;
  tokens: number;
  compressed: boolean;
  body: AutoGeminiBody;
}

// ─── Virtual model ────────────────────────────────────────────────────────

export function buildAutoModel(): CustomModel {
  return {
    name: 'models/' + AUTO_EXTERNAL_NAME,
    displayName: AUTO_DISPLAY_NAME,
    description:
      'Routes each request to the best model you configured (vision / code / long context / quick), with automatic fallback.',
    provider: 'custom',
    apiKey: 'none',
    apiUrl: 'http://127.0.0.1/' + AUTO_EXTERNAL_NAME,
    externalModelName: AUTO_EXTERNAL_NAME,
  };
}

export function isAutoModel(m: CustomModel): boolean {
  return m.provider === 'custom' && m.externalModelName === AUTO_EXTERNAL_NAME;
}

// ─── Token estimation ─────────────────────────────────────────────────────

function partTokens(p: AutoGeminiPart): number {
  if (typeof p.text === 'string') return Math.ceil(p.text.length / CHARS_PER_TOKEN);
  const mime = (p.inlineData?.mimeType || p.fileData?.mimeType || '').toLowerCase();
  if (p.inlineData || mime.startsWith('image/')) return IMAGE_FLAT_TOKENS;
  return 0;
}

export function estimateTokens(body: AutoGeminiBody): number {
  let total = 0;
  if (body.systemInstruction?.parts) {
    for (const p of body.systemInstruction.parts) total += partTokens(p);
  }
  for (const c of body.contents || []) {
    for (const p of c.parts || []) total += partTokens(p);
  }
  return total + ANSWER_HEADROOM;
}

// ─── Task classification ──────────────────────────────────────────────────

function allText(body: AutoGeminiBody): string {
  const parts: string[] = [];
  if (body.systemInstruction?.parts) {
    for (const p of body.systemInstruction.parts) {
      if (typeof p.text === 'string') parts.push(p.text);
    }
  }
  for (const c of body.contents || []) {
    for (const p of c.parts || []) {
      if (typeof p.text === 'string') parts.push(p.text);
    }
  }
  return parts.join(' ');
}

function hasImages(body: AutoGeminiBody): boolean {
  const check = (p: AutoGeminiPart): boolean => {
    if (p.inlineData) return true;
    const mime = (p.fileData?.mimeType || '').toLowerCase();
    return mime.startsWith('image/');
  };
  if (body.systemInstruction?.parts?.some(check)) return true;
  for (const c of body.contents || []) {
    if ((c.parts || []).some(check)) return true;
  }
  return false;
}

export interface RequestClass {
  task: 'vision' | 'code' | 'long' | 'quick' | 'chat' | 'forced';
  reason: string;
  forcedModel?: string;
}

export function classifyRequest(body: AutoGeminiBody): RequestClass {
  const text = allText(body);

  const forced = text.match(/#model:(\S+)/);
  if (forced) return { task: 'forced', reason: 'tag #model:', forcedModel: forced[1] };
  if (text.includes('#:code')) return { task: 'code', reason: 'tag #:code' };
  if (text.includes('#:vision')) return { task: 'vision', reason: 'tag #:vision' };

  if (hasImages(body)) return { task: 'vision', reason: 'image part in request' };
  if (CODE_PATTERN.test(text)) return { task: 'code', reason: 'code patterns detected' };
  if (text.length > 8000) return { task: 'long', reason: 'long input (>8k chars)' };
  if (text.length < 200) return { task: 'quick', reason: 'short input' };
  return { task: 'chat', reason: 'default' };
}

// ─── Model ranking ────────────────────────────────────────────────────────

function nameOf(m: CustomModel): string {
  return (m.externalModelName + ' ' + m.displayName).toLowerCase();
}

function capOf(m: CustomModel): { maxTokens: number; supportsImages: boolean } {
  const cap = detectModelCapabilities(m, true);
  return { maxTokens: cap.maxTokens, supportsImages: cap.supportsImages };
}

/** Earliest matching hint wins (hints are ordered most-specific first). */
function taskScore(m: CustomModel, task: string): number {
  const n = nameOf(m);
  const hints = FAMILY_HINTS[task] || [];
  for (let i = 0; i < hints.length; i++) {
    if (n.includes(hints[i])) return i;
  }
  return hints.length; // no hint match -> worst score
}

export function pickChain(models: CustomModel[], body: AutoGeminiBody): CustomModel[] {
  const cls = classifyRequest(body);

  if (cls.task === 'forced' && cls.forcedModel) {
    const tag = cls.forcedModel.toLowerCase();
    const hit = models.find(
      (m) =>
        m.externalModelName.toLowerCase() === tag ||
        nameOf(m).includes(tag) ||
        m.name.toLowerCase().endsWith('/' + tag),
    );
    return hit ? [hit] : [];
  }

  const need = estimateTokens(body);
  let cands = models.filter((m) => !isAutoModel(m));

  if (cls.task === 'vision') {
    const seers = cands.filter((m) => capOf(m).supportsImages);
    if (seers.length > 0) cands = seers;
  }

  if (cands.length === 0) return [];

  const fitting = cands.filter((m) => capOf(m).maxTokens >= need);
  const pool0 = fitting.length > 0 ? fitting : cands;
  // Breaker is advisory: skip open models unless that would leave nothing to try.
  const usable = pool0.filter((m) => !smartHealth.isOpen(m.name));
  const pool = usable.length > 0 ? usable : pool0;

  const waste = (m: CustomModel): number => capOf(m).maxTokens - need;
  const byFit = (a: CustomModel, b: CustomModel): number =>
    taskScore(a, cls.task) - taskScore(b, cls.task) ||
    smartHealth.penalty(a.name) - smartHealth.penalty(b.name) ||
    waste(a) - waste(b) ||
    a.displayName.localeCompare(b.displayName);

  return [...pool].sort(byFit).slice(0, MAX_CHAIN);
}

// ─── Local compression (last resort, no extra API call) ───────────────────

export function compressContents(body: AutoGeminiBody, keepRecent = 6): AutoGeminiBody {
  const contents = body.contents || [];
  if (contents.length <= keepRecent + 1) return body;

  const old = contents.slice(0, contents.length - keepRecent);
  const recent = contents.slice(contents.length - keepRecent);

  const lines: string[] = [];
  for (const c of old) {
    const text = (c.parts || [])
      .map((p) => (typeof p.text === 'string' ? p.text : ''))
      .join(' ')
      .slice(0, 400);
    lines.push(`${c.role || 'user'}: ${text}`);
  }
  const digest: { role: string; parts: AutoGeminiPart[] } = {
    role: 'user',
    parts: [
      {
        text:
          `[Compressed earlier conversation (${old.length} turns) - decisions, ` +
          `files and errors above were condensed]\n` +
          lines.join('\n'),
      },
    ],
  };

  return { ...body, contents: [digest, ...recent] };
}

// ─── Full plan ────────────────────────────────────────────────────────────

export function planAutoRoute(models: CustomModel[], body: AutoGeminiBody): RoutePlan {
  const cls = classifyRequest(body);
  let work = body;
  let tokens = estimateTokens(work);
  let compressed = false;

  let chain = pickChain(models, work);

  // Nothing fits any window -> compress older turns locally and retry.
  const biggest = Math.max(0, ...models.filter((m) => !isAutoModel(m)).map((m) => capOf(m).maxTokens));
  if (chain.length > 0 && tokens > biggest) {
    work = compressContents(work);
    tokens = estimateTokens(work);
    compressed = true;
    chain = pickChain(models, work);
  }

  return {
    chain,
    task: cls.task,
    reason: `${cls.reason}${compressed ? ' + compressed context' : ''}`,
    tokens,
    compressed,
    body: work,
  };
}
