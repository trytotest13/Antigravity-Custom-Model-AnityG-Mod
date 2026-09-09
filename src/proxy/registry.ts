/**
 * Provider Translator Registry.
 * Static map of translator modules with a unified interface for request/response mapping.
 *
 * To add a new provider:
 *   1. Create a file in ./translators/ named <provider>.ts
 *   2. Export: mapGeminiTo<Provider>, map<Provider>ToGemini, map<Provider>ChunkToGemini
 *   3. Register it in `translators` below + `providerFamily`.
 */

import log from 'electron-log';
import * as openai from './translators/openai';
import * as anthropic from './translators/anthropic';
import * as google from './translators/google';
import * as ollama from './translators/ollama';

// ─── Types ────────────────────────────────────────────────────────────────

export interface TranslatorModule {
  mapGeminiToOpenAI?: (body: unknown, modelName: string) => unknown;
  mapOpenAIToGemini?: (res: unknown, modelName: string) => unknown;
  mapOpenAIChunkToGemini?: (chunk: unknown, modelName: string) => unknown | null;
  mapGeminiToAnthropic?: (body: unknown, modelName: string) => unknown;
  mapAnthropicToGemini?: (res: unknown, modelName: string) => unknown;
  mapAnthropicChunkToGemini?: (chunk: unknown, modelName: string) => unknown | null;
  mapGeminiToGoogle?: (body: unknown, modelName: string) => unknown;
  mapGoogleToGemini?: (res: unknown, modelName: string) => unknown;
  mapGoogleChunkToGemini?: (chunk: unknown, modelName: string) => unknown | null;
  getGoogleApiUrl?: (baseUrl: string, modelName: string, isStream: boolean) => string;
  [key: string]: unknown;
}

export interface ProviderHeaders {
  'Content-Type': string;
  Authorization?: string;
  'x-api-key'?: string;
  'anthropic-version'?: string;
  'x-goog-api-key'?: string;
  'HTTP-Referer'?: string;
  'X-Title'?: string;
  [key: string]: string | undefined;
}

// ─── Registry State ───────────────────────────────────────────────────────

const translators = new Map<string, TranslatorModule>([
  ['openai', openai as unknown as TranslatorModule],
  ['ollama', ollama as unknown as TranslatorModule],
  ['anthropic', anthropic as unknown as TranslatorModule],
  ['google', google as unknown as TranslatorModule],
]);

// Single source of truth for transport compatibility.
export type ProviderFamily = 'openai' | 'anthropic' | 'google' | 'unknown';

export function providerFamily(provider: string): ProviderFamily {
  switch (provider) {
    case 'openai':
    case 'ollama':
    case 'openrouter':
    case 'custom':
    case 'groq':
    case 'mistral':
    case 'cerebras':
    case 'nvidia':
    case 'opencode':
    case 'codestral':
      return 'openai';
    case 'anthropic':
    case 'deepseek':
    case 'kimi':
    case 'fireworks':
    case 'lmstudio':
    case 'llamacpp':
    case 'wafer':
    case 'zai':
      return 'anthropic';
    case 'google':
      return 'google';
    default:
      return 'unknown';
  }
}

// ─── Public API ───────────────────────────────────────────────────────────

export function getTranslator(provider: string): TranslatorModule | null {
  if (provider === 'ollama') return translators.get('ollama') || null;
  const family = providerFamily(provider);
  if (family === 'openai') return translators.get('openai') || null;
  if (family === 'anthropic') return translators.get('anthropic') || null;
  if (family === 'google') return translators.get('google') || null;
  return translators.get('openai') || null;
}

export function translateRequest(provider: string, geminiBody: unknown, modelName: string): unknown {
  const t = getTranslator(provider);
  const family = providerFamily(provider);

  if (family === 'google') return geminiBody;
  if (family === 'openai') return t?.mapGeminiToOpenAI ? t.mapGeminiToOpenAI(geminiBody, modelName) : geminiBody;
  if (family === 'anthropic')
    return t?.mapGeminiToAnthropic ? t.mapGeminiToAnthropic(geminiBody, modelName) : geminiBody;

  // Generic: try mapGeminiTo<Provider> convention
  const fnName = `mapGeminiTo${provider.charAt(0).toUpperCase() + provider.slice(1)}`;
  if (t && typeof t[fnName] === 'function') {
    return (t[fnName] as (...args: unknown[]) => unknown)(geminiBody, modelName);
  }

  log.warn(`[TranslatorRegistry] No request translator for provider "${provider}", passing through`);
  return geminiBody;
}

export function translateResponse(provider: string, providerRes: unknown, modelName: string): unknown {
  const t = getTranslator(provider);
  const family = providerFamily(provider);

  if (family === 'google') return providerRes;
  if (family === 'openai') return t?.mapOpenAIToGemini ? t.mapOpenAIToGemini(providerRes, modelName) : providerRes;
  if (family === 'anthropic')
    return t?.mapAnthropicToGemini ? t.mapAnthropicToGemini(providerRes, modelName) : providerRes;

  const fnName = `map${provider.charAt(0).toUpperCase() + provider.slice(1)}ToGemini`;
  if (t && typeof t[fnName] === 'function') {
    return (t[fnName] as (...args: unknown[]) => unknown)(providerRes, modelName);
  }

  log.warn(`[TranslatorRegistry] No response translator for provider "${provider}", passing through`);
  return providerRes;
}

export function translateStreamChunk(provider: string, chunk: unknown, modelName: string): unknown {
  const t = getTranslator(provider);
  const family = providerFamily(provider);

  if (family === 'google') return t?.mapGoogleChunkToGemini ? t.mapGoogleChunkToGemini(chunk, modelName) : null;
  if (family === 'openai') return t?.mapOpenAIChunkToGemini ? t.mapOpenAIChunkToGemini(chunk, modelName) : null;
  if (family === 'anthropic')
    return t?.mapAnthropicChunkToGemini ? t.mapAnthropicChunkToGemini(chunk, modelName) : null;

  const fnName = `map${provider.charAt(0).toUpperCase() + provider.slice(1)}ChunkToGemini`;
  if (t && typeof t[fnName] === 'function') {
    return (t[fnName] as (...args: unknown[]) => unknown)(chunk, modelName);
  }

  return null;
}

export function getProviderHeaders(provider: string, apiKey: string): ProviderHeaders {
  const headers: ProviderHeaders = { 'Content-Type': 'application/json' };
  if (!apiKey || apiKey === 'none') return headers;

  const family = providerFamily(provider);
  if (provider === 'anthropic' || family === 'anthropic') {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2025-04-01';
  } else if (family === 'google') {
    headers['x-goog-api-key'] = apiKey;
  } else if (provider === 'openrouter') {
    headers['Authorization'] = `Bearer ${apiKey}`;
    headers['HTTP-Referer'] = 'https://antigravity.google';
    headers['X-Title'] = 'Antigravity';
  } else if (provider !== 'ollama') {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }
  return headers;
}

export function supportsStreaming(provider: string): boolean {
  return providerFamily(provider) !== 'unknown';
}

// ─── URL Helpers ──────────────────────────────────────────────────────────

export function getProviderUrl(
  baseUrl: string,
  modelName: string,
  isStream: boolean,
  translator: TranslatorModule | null,
): string {
  // Google AI Studio: dynamic streaming vs non-streaming URL
  if (translator && typeof translator['getGoogleApiUrl'] === 'function') {
    return (translator['getGoogleApiUrl'] as (...args: unknown[]) => string)(baseUrl, modelName, isStream);
  }
  // Ollama: normalize to standard /v1/chat/completions endpoint
  if (translator && typeof translator['getOllamaApiUrl'] === 'function') {
    return (translator['getOllamaApiUrl'] as (...args: unknown[]) => string)(baseUrl);
  }
  return baseUrl;
}
