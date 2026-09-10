/**
 * Auto Smart Router.
 *
 * Provides the virtual "Auto (Smart Router)" model: when the IDE routes a
 * request to it, the proxy inspects the Gemini request (images, code, math,
 * length, tool calls) and picks the best user-configured custom model for the
 * job, with a fallback chain and local context compression when no window fits.
 *
 * Classification is a weighted multi-signal score, not a first-match regex:
 * strong signals (fenced code blocks, error traces, tool calls) dominate,
 * soft signals (code keywords, file paths, reasoning phrases) accumulate, and
 * the winner's score is explainable in the reason string the proxy logs.
 *
 * This module is intentionally Electron-free so it can be unit-tested
 * directly. Type-only import of CustomModel keeps the runtime dependency
 * graph one-way (proxy -> autoRouter).
 */

import type { CustomModel } from '../proxy';
import { detectModelCapabilities, healthKey } from './modelUtils';
import { smartHealth } from './smartHealth';

// ─── Constants ────────────────────────────────────────────────────────────

export const AUTO_EXTERNAL_NAME = 'auto-router';
export const AUTO_DISPLAY_NAME = 'Auto (Smart Router)';

const IMAGE_FLAT_TOKENS = 1100; // safe overestimate per image part
const ANSWER_HEADROOM = 2048; // room for the model's reply
const CHARS_PER_TOKEN = 4; // rough average for code+prose
const MAX_CHAIN = 4;

// Task -> name hints, most-specific first. Matched against externalModelName +
// displayName (lowercased) of the configured models. Index i earns
// TASK_BASE - i * TASK_STEP points, so earlier (more specific) hints win.
const FAMILY_HINTS: Record<string, string[]> = {
  code: ['deepseek', 'coder', 'codestral', 'qwen3', 'claude', 'gpt-4o', 'llama-3.3', 'gemini'],
  reasoning: ['r1', 'reasoner', 'o1-', 'o3-', 'thinking', 'deepseek', 'claude', 'gemini', 'gpt-4o', 'qwen3'],
  vision: ['gemini', 'gpt-4o', 'claude', 'vision', 'llava', 'pixtral'],
  long: ['gemini', 'gpt-4o', 'claude', 'llama-3.3', 'deepseek'],
  quick: ['mini', 'flash', 'nano', 'haiku', '8b', '3b', 'small', 'lite'],
  // Balanced chat: no single family dominates; deepseek demoted from 1st so
  // generic chat rotates among claude/gpt/gemini instead of always DeepSeek.
  chat: ['claude', 'gpt-4o', 'gemini', 'deepseek', 'llama', 'qwen'],
};

const TASK_BASE = 60;
const TASK_STEP = 10;
const THINKING_BONUS = 8; // reward real reasoning models for brainy tasks
const HEALTH_WEIGHT = 12; // points lost per unit of breaker penalty
const WASTE_STEP = 200_000; // 1 point lost per 200k tokens of unused window
const WASTE_CAP = 10;

// Tie rotation (Part 6): candidates within this epsilon of the top score are
// "equivalent" and the winner rotates among them. Clear winners stay fixed.
const TIE_EPSILON = 12;
let tieRotationCursor = 0;

// Name-based reasoner detection: the provider-based isThinking flag marks
// every openai/anthropic/openrouter model as thinking, so it differentiates
// nothing. Real reasoners carry the name signal.
const REASONER_PATTERN = /r1|reasoner|o1-|o3-|thinking|deepseek-r/i;

// Strong code signals: essentially unambiguous on their own. One pattern per
// signal - countMatches weighs per pattern, so alternatives must be split out.
const CODE_STRONG: RegExp[] = [
  /```/, // fenced code block
  /\btraceback\b/i,
  /\bstack\s?trace\b|\bstacktrace\b/i,
  /\b(?:TypeError|ReferenceError|SyntaxError|NameError|KeyError|IndexError|AttributeError)\b/,
  /\bNullPointerException\b|\bSegmentationFault\b|\bpanic:/,
  /\b(?:compile|compilation|build|lint)\s+(?:error|failed|fails)\b/i,
];

// Soft code signals: each adds weight; a single one is suggestive, several are sure.
const CODE_SOFT: RegExp[] = [
  /\b(?:function|method|class|variable|array)\b/i,
  /\b(?:api|endpoint|regex|script|library|framework|compiler|runtime|snippet|algorithm)\b/i,
  /\b(?:debug|refactor|implement|optimize)\b/i,
  /\bfix(?:es|ing)?\b/i,
  /\bunit\s?tests?\b|\btest\s+cases?\b/i,
  /\b(?:def |class |import |export |const |let |var |async |await )\b/,
  /\b(?:#include|public |private |fn |func |package )\b/,
  /=>/,
  /;\s*$|\{\s*$/m,
  /\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|py|java|c|cpp|h|go|rs|rb|php|cs|swift|kt|sql|sh|yml|yaml|json)\b/i,
  /\b(?:src|lib|app|components?|utils?|tests?|services?|controllers?)\/[\w/.-]+\.\w+/i,
];

// Reasoning / math signals: prefer models that think.
const REASONING_SOFT: RegExp[] = [
  /\bstep[- ]by[- ]step\b/i,
  /\b(?:derive|proof|prove)\b/i,
  /\bexplain\s+why\b/i,
  /\b(?:reason|think)\s+(?:this\s+)?(?:through|it\s+through)\b/i,
  /\bwork\s+through\b/i,
  /\b(?:calculate|compute|solve)\b/i,
  /\b(?:equation|theorem|probability|permutation|combinatoric(?:s)?)\b/i,
  /\b(?:time|space)\s+complexity\b|\bbig[- ]?o\b/i,
  /\btrade[- ]?offs?\b/i,
  /\barchitecture\b/i,
  /\bdesign\s+(?:decision|pattern|review)\b/i,
  /\bpros\s+and\s+cons\b/i,
  /\broot\s+cause\b/i,
  /\d+\s*[+\-*/^]\s*\d+/,
  /\\frac|\\int|\\sum|\\lim/,
];

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
      'Routes each request to the best model you configured (vision / code / reasoning / long context / quick), with automatic fallback.',
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

function allParts(body: AutoGeminiBody): AutoGeminiPart[] {
  const parts: AutoGeminiPart[] = [];
  if (body.systemInstruction?.parts) parts.push(...body.systemInstruction.parts);
  for (const c of body.contents || []) {
    if (c.parts) parts.push(...c.parts);
  }
  return parts;
}

function allText(body: AutoGeminiBody): string {
  return allParts(body)
    .map((p) => (typeof p.text === 'string' ? p.text : ''))
    .join(' ');
}

function hasImages(body: AutoGeminiBody): boolean {
  return allParts(body).some((p) => {
    if (p.inlineData) return true;
    const mime = (p.fileData?.mimeType || '').toLowerCase();
    return mime.startsWith('image/');
  });
}

function hasToolCalls(body: AutoGeminiBody): boolean {
  return allParts(body).some((p) => 'functionCall' in p || 'functionResponse' in p);
}

function countMatches(text: string, patterns: RegExp[]): number {
  let hits = 0;
  for (const re of patterns) {
    if (re.test(text)) hits++;
  }
  return hits;
}

export interface RequestClass {
  task: 'vision' | 'code' | 'reasoning' | 'long' | 'quick' | 'chat' | 'forced';
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

  // Weighted signals: tool calls are agent traffic (always code-shaped);
  // fenced blocks / error traces are decisive; keywords only suggest.
  let codeScore = countMatches(text, CODE_STRONG) * 3 + countMatches(text, CODE_SOFT) * 1.5;
  if (hasToolCalls(body)) codeScore += 3;
  const reasoningScore = countMatches(text, REASONING_SOFT) * 1.5;
  const len = text.length;

  if (codeScore >= 3) {
    const why: string[] = [];
    if (hasToolCalls(body)) why.push('tool call in request');
    if (/```/.test(text)) why.push('code block');
    if (countMatches(text, CODE_STRONG) > 0) why.push('error/trace patterns');
    if (why.length === 0) why.push(`${countMatches(text, CODE_SOFT)} code signals`);
    return { task: 'code', reason: 'code detected (' + why.join(', ') + ')' };
  }
  if (reasoningScore >= 3) return { task: 'reasoning', reason: 'reasoning/math request' };
  if (len > 8000) return { task: 'long', reason: 'long input (>8k chars)' };
  if (len < 200) return { task: 'quick', reason: 'short input' };
  if (codeScore >= 1.5) return { task: 'code', reason: 'code keywords detected' };
  return { task: 'chat', reason: 'general chat' };
}

// ─── Model ranking ────────────────────────────────────────────────────────

function nameOf(m: CustomModel): string {
  return (m.externalModelName + ' ' + m.displayName).toLowerCase();
}

function capOf(m: CustomModel): { maxTokens: number; supportsImages: boolean; isThinking: boolean } {
  const cap = detectModelCapabilities(m, true);
  return { maxTokens: cap.maxTokens, supportsImages: cap.supportsImages, isThinking: cap.isThinking };
}

/**
 * Additive routing score for one model against one task. Higher wins.
 * The `bits` describe what earned the points, for the reason string.
 */
function scoreFor(
  m: CustomModel,
  task: string,
  need: number,
): { score: number; bits: string[] } {
  const n = nameOf(m);
  const cap = capOf(m);
  const hints = FAMILY_HINTS[task] || [];
  const bits: string[] = [];
  let score = 0;

  // 1. Task-family name fit: 60 for the most-specific hint, sliding to 0.
  const QUICK_HINTS = new Set(['mini', 'flash', 'nano', 'haiku', '8b', '3b', 'small', 'lite']);
  for (let i = 0; i < hints.length; i++) {
    if (n.includes(hints[i])) {
      score += TASK_BASE - i * TASK_STEP;
      bits.push(QUICK_HINTS.has(hints[i]) ? 'fast model' : `${hints[i]} family`);
      break;
    }
  }

  // 2. Actual capability: real reasoners (by name, not provider) get extra
  //    credit on brainy tasks. Provider flags mark everything thinking, which
  //    made the bonus universal and useless for ranking.
  if ((task === 'code' || task === 'reasoning' || task === 'long') && REASONER_PATTERN.test(n)) {
    score += THINKING_BONUS;
    bits.push('reasoner');
  }

  // 3. Health: the breaker's penalty (failures, slow EWMA) pulls a model down.
  score -= smartHealth.penalty(healthKey(m)) * HEALTH_WEIGHT;

  // 4. Right-sizing: a window much bigger than needed is a mild negative so
  //    cheap/small models win ties, but it can never beat task fit.
  const waste = Math.max(0, cap.maxTokens - need);
  score -= Math.min(WASTE_CAP, waste / WASTE_STEP);

  return { score, bits };
}

/** Normalizes a forced #model: tag for forgiving matching (case, prefixes, separators). */
function normalizeTag(tag: string): string {
  return tag
    .toLowerCase()
    .replace(/^models\//, '')
    .replace(/[_\s]+/g, '-');
}

function matchForced(models: CustomModel[], tag: string): CustomModel | undefined {
  const t = normalizeTag(tag);
  return models.find((m) => {
    const ext = normalizeTag(m.externalModelName);
    const full = normalizeTag(nameOf(m));
    const nm = normalizeTag(m.name);
    return ext === t || full.includes(t) || nm.endsWith('/' + t);
  });
}

/**
 * Ranks the configured models for this request and returns the fallback chain.
 * The first entry is the primary pick; the rest are tried on failure.
 */
export function pickChain(models: CustomModel[], body: AutoGeminiBody): CustomModel[] {
  return explainRoute(models, body).chain;
}

interface RouteExplanation {
  chain: CustomModel[];
  reason: string;
}

function explainRoute(models: CustomModel[], body: AutoGeminiBody): RouteExplanation {
  const cls = classifyRequest(body);

  if (cls.task === 'forced' && cls.forcedModel) {
    const hit = matchForced(models, cls.forcedModel);
    return { chain: hit ? [hit] : [], reason: `${cls.reason} ${cls.forcedModel}` };
  }

  const need = estimateTokens(body);
  let cands = models.filter((m) => !isAutoModel(m));

  // Hard requirement: vision tasks only go to models that can see.
  if (cls.task === 'vision') {
    const seers = cands.filter((m) => capOf(m).supportsImages);
    if (seers.length > 0) cands = seers;
  }

  if (cands.length === 0) return { chain: [], reason: cls.reason };

  // Prefer models whose window actually fits; fall back to everyone only if
  // nothing does (planAutoRoute will compress and re-pick in that case).
  const fitting = cands.filter((m) => capOf(m).maxTokens >= need);
  const pool0 = fitting.length > 0 ? fitting : cands;
  // Breaker is advisory: skip open models unless that would leave nothing to try.
  const usable = pool0.filter((m) => !smartHealth.isOpen(healthKey(m)));
  const pool = usable.length > 0 ? usable : pool0;

  const scored = pool.map((m) => ({ m, ...scoreFor(m, cls.task, need) }));
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      capOf(a.m).maxTokens - capOf(b.m).maxTokens ||
      a.m.displayName.localeCompare(b.m.displayName),
  );

  // Tie rotation (Part 6): near-equal candidates take turns winning so the
  // same model doesn't monopolize chat traffic. A clear winner (gap > epsilon
  // over the runner-up) keeps position 0 deterministically.
  const top = scored[0].score;
  const tiedCount = scored.filter((s) => top - s.score <= TIE_EPSILON).length;
  let rotated = 0;
  if (tiedCount > 1) {
    rotated = tieRotationCursor % tiedCount;
    tieRotationCursor = (tieRotationCursor + 1) % tiedCount;
    const [winner] = scored.splice(rotated, 1);
    scored.unshift(winner);
  }

  const chain = scored.slice(0, MAX_CHAIN).map((s) => s.m);
  const win = scored[0];
  const why = win.bits.length > 0 ? ` (${win.bits.slice(0, 3).join(', ')})` : '';
  const tieNote = tiedCount > 1 ? ` [rotated among ${tiedCount} near-tied]` : '';
  return { chain, reason: `${cls.reason}; ${win.m.displayName}${why}${tieNote}` };
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

  let picked = explainRoute(models, work);

  // Nothing fits any window -> compress older turns locally and retry.
  const biggest = Math.max(0, ...models.filter((m) => !isAutoModel(m)).map((m) => capOf(m).maxTokens));
  if (picked.chain.length > 0 && tokens > biggest) {
    work = compressContents(work);
    tokens = estimateTokens(work);
    compressed = true;
    picked = explainRoute(models, work);
  }

  return {
    chain: picked.chain,
    task: cls.task,
    reason: `${picked.reason}${compressed ? ' + compressed context' : ''}`,
    tokens,
    compressed,
    body: work,
  };
}
