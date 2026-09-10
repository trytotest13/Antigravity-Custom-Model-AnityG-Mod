/**
 * Rotation regression tests (Parts 16-19, 25).
 * Drives the real handleCustomModelRequest with a mocked http module and a
 * fake ServerResponse, asserting retry-vs-switch behavior end to end.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type http from 'http';

vi.mock('electron', () => ({ app: { getPath: () => process.cwd() } }));
vi.mock('electron-log', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../cryptoStore', () => ({
  encryptModels: (m: unknown[]) => m,
  decryptModels: (m: unknown[]) => m,
}));

type Responder = () => {
  status: number;
  body: string;
  headers?: Record<string, string>;
  destroy?: boolean;
};

let responder: Responder = () => ({ status: 200, body: '{}' });
const dials: { url: string; body: string }[] = [];

vi.mock('http', async () => {
  const actual = await vi.importActual<typeof import('http')>('http');
  return {
    ...actual,
    default: actual,
    request: (url: URL, _opts: unknown, cb: (res: unknown) => void) => {
      const listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
      const req = {
        wrote: '' as string,
        write(b: string) { this.wrote += b; return this; },
        end(b?: string) {
          if (b) this.wrote += b;
          dials.push({ url: String(url), body: this.wrote });
          const r = responder();
          // Network failure: no response ever arrives, only the request error.
          if (r.destroy) {
            setImmediate(() => (listeners['error'] || []).forEach((f) => f(new Error('ECONNREFUSED'))));
            return;
          }
          const res = {
            statusCode: r.status,
            headers: r.headers ?? {},
            on(ev: string, fn: (c?: Buffer) => void) {
              if (ev === 'data') fn(Buffer.from(r.body));
              if (ev === 'end') fn();
              return this;
            },
          };
          cb(res);
        },
        setTimeout(_ms: number, _fn: () => void) { return this; },
        destroy() { return this; },
        on(ev: string, fn: (e?: Error) => void) { (listeners[ev] ||= []).push(fn as never); return this; },
      };
      return req;
    },
  };
});

vi.mock('https', async () => {
  const actual = await vi.importActual<typeof import('https')>('https');
  const httpMod = await import('http');
  return { ...actual, default: actual, request: (httpMod as unknown as { request: unknown }).request };
});

import { handleCustomModelRequest } from '../proxy';
import { smartHealth } from '../proxy/smartHealth';
import { healthKey } from '../proxy/modelUtils';

const OK = JSON.stringify({ choices: [{ message: { content: 'pong' } }] });

function mk(name: string, provider = 'openai'): import('../proxy').CustomModel {
  return {
    name: 'models/' + name,
    displayName: name,
    description: '',
    provider,
    apiKey: 'none',
    apiUrl: 'http://127.0.0.1:1/v1/chat/completions',
    externalModelName: name,
    maxRetries: 0,
    timeout: 5000,
  };
}

function fakeRes(): http.ServerResponse {
  const out = {
    headersSent: false,
    statusCode: 200,
    chunks: [] as string[],
    ended: false,
    writeHead(code: number) { this.headersSent = true; this.statusCode = code; return this; },
    write(c: string) { this.chunks.push(String(c)); return true; },
    end(c?: string) { if (c) this.chunks.push(String(c)); this.ended = true; },
    on(_ev: string, _fn: () => void) { return this; },
    once(_ev: string, _fn: () => void) { return this; },
    emit(_ev: string) { return true; },
  };
  return out as unknown as http.ServerResponse;
}

function flush(): Promise<void> {
  return new Promise((r) => setImmediate(() => setImmediate(() => r())));
}

beforeEach(() => {
  dials.length = 0;
  responder = () => ({ status: 200, body: OK });
  smartHealth.clear();
});

afterEach(() => { vi.useRealTimers(); });

describe('rotation (Part 16-18)', () => {
  it('429 on A -> B receives the SAME original body and its response reaches the client', async () => {
    const A = mk('model-a');
    const B = mk('model-b');
    responder = () => {
      if (dials.length <= 1) return { status: 429, body: '{"error":{"message":"rate limit"}}' };
      return { status: 200, body: OK };
    };
    const body = { contents: [{ role: 'user', parts: [{ text: 'original request' }] }] };
    const res = fakeRes();
    handleCustomModelRequest(res, A, body as never, false, 0, [B]);
    await flush();
    expect(dials.length).toBe(2);
    expect(dials[1].body).toContain('original request');
    expect(res.statusCode).toBe(200);
    expect(res.chunks.join('')).toContain('pong');
  });

  it.each([401, 403, 404])('%s on A -> A dialed exactly once, B attempted', async (status) => {
    const A = mk('model-a');
    const B = mk('model-b');
    responder = () => ({ status, body: '{"error":{}}' });
    const res = fakeRes();
    handleCustomModelRequest(res, A, { contents: [] } as never, false, 0, [B]);
    await flush();
    expect(dials.length).toBe(2);
    expect(dials[0].body).toContain('model-a');
    expect(dials[1].body).toContain('model-b');
  });

  it('503 with maxRetries>0 -> retries A, then falls back to B', async () => {
    const A = { ...mk('model-a'), maxRetries: 1 };
    const B = mk('model-b');
    responder = () => ({ status: 503, body: '{"error":{}}' });
    const res = fakeRes();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      handleCustomModelRequest(res, A, { contents: [] } as never, false, 0, [B]);
      // Advance past the exponential backoff delay so the scheduled retry runs.
      await vi.advanceTimersByTimeAsync(2000);
      await flush();
      expect(dials.filter((d) => d.body.includes('model-a')).length).toBe(2);
      expect(dials.some((d) => d.body.includes('model-b'))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('hard-quota body on 500 -> skips retry budget, switches immediately', async () => {
    const A = { ...mk('model-a'), maxRetries: 3 };
    const B = mk('model-b');
    responder = () => ({ status: 500, body: '{"error":{"message":"quota exceeded for this project"}}' });
    const res = fakeRes();
    handleCustomModelRequest(res, A, { contents: [] } as never, false, 0, [B]);
    await flush();
    expect(dials.filter((d) => d.body.includes('model-a')).length).toBe(1);
    expect(dials.some((d) => d.body.includes('model-b'))).toBe(true);
  });

  it('ECONNREFUSED on A -> B receives the same request (Part 18)', async () => {
    const A = mk('model-a');
    const B = mk('model-b');
    responder = () => ({ status: 200, body: OK, destroy: true });
    const res = fakeRes();
    handleCustomModelRequest(res, A, { contents: [{ role: 'user', parts: [{ text: 'same body' }] }] } as never, false, 0, [B]);
    await flush();
    expect(dials.some((d) => d.body.includes('model-b'))).toBe(true);
    expect(dials.find((d) => d.body.includes('model-b'))!.body).toContain('same body');
  });

  it('plain 400 -> fails fast, does NOT burn the chain', async () => {
    const A = mk('model-a');
    const B = mk('model-b');
    responder = () => ({ status: 400, body: '{"error":{"message":"bad request"}}' });
    const res = fakeRes();
    handleCustomModelRequest(res, A, { contents: [] } as never, false, 0, [B]);
    await flush();
    expect(dials.length).toBe(1);
    expect(res.statusCode).toBe(400);
  });

  it('all models fail -> final error lists every attempt (Part 25)', async () => {
    const A = mk('model-a');
    const B = mk('model-b');
    responder = () => ({ status: 401, body: '{"error":{}}' });
    const res = fakeRes();
    handleCustomModelRequest(res, A, { contents: [] } as never, false, 0, [B]);
    await flush();
    const out = res.chunks.join('');
    expect(out).toContain('All configured AI providers failed');
    expect(out).toContain('model-a');
    expect(out).toContain('model-b');
    expect(out).not.toContain('apiKey');
  });
});

describe('streaming rotation (Part 19)', () => {
  it('429 before headers -> B stream reaches the client', async () => {
    const A = mk('model-a');
    const B = mk('model-b');
    responder = () => {
      if (dials.length <= 1) return { status: 429, body: '{"error":{"message":"rate limit"}}' };
      return { status: 200, body: 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n' };
    };
    const res = fakeRes();
    handleCustomModelRequest(res, A, { contents: [] } as never, true, 0, [B]);
    await flush();
    expect(dials.length).toBe(2);
    expect(res.statusCode).toBe(200);
    expect(res.chunks.join('')).toContain('data:');
  });

  it('partial output then death -> no second dial, no concatenation', async () => {
    const A = mk('model-a');
    const B = mk('model-b');
    responder = () => ({ status: 200, body: OK, destroy: true });
    const res = fakeRes();
    handleCustomModelRequest(res, A, { contents: [] } as never, true, 0, [B]);
    // Simulate headers already sent (partial output streamed) before the error lands.
    (res as unknown as { headersSent: boolean }).headersSent = true;
    await flush();
    expect(dials.length).toBe(1); // B never dialed
  });
});

describe('Free Router (Part 20)', () => {
  it('online -> OpenAI-family translation and success', async () => {
    const FR = mk('free-best', 'free-router');
    responder = () => ({ status: 200, body: OK });
    const res = fakeRes();
    handleCustomModelRequest(res, FR, { contents: [] } as never, false, 0, []);
    await flush();
    expect(res.statusCode).toBe(200);
    expect(res.chunks.join('')).toContain('pong');
  });

  it('offline (ECONNREFUSED) -> no crash, error surfaces', async () => {
    const FR = mk('free-best', 'free-router');
    responder = () => ({ status: 200, body: OK, destroy: true });
    const res = fakeRes();
    handleCustomModelRequest(res, FR, { contents: [] } as never, false, 0, []);
    await flush();
    expect((res as unknown as { ended: boolean }).ended).toBe(true);
  });
});

describe('cooldown-aware switching (free-router rule 9)', () => {
  it('breaker-open fallback is skipped: A 401 -> B (open) skipped -> C dialed', async () => {
    const A = mk('model-a');
    const B = mk('model-b');
    const C = mk('model-c');
    for (let i = 0; i < 3; i++) smartHealth.reportFailure(healthKey(B));
    responder = () => ({ status: 401, body: '{"error":{}}' });
    const res = fakeRes();
    handleCustomModelRequest(res, A, { contents: [] } as never, false, 0, [B, C]);
    await flush();
    expect(dials.some((d) => d.body.includes('model-b'))).toBe(false);
    expect(dials.some((d) => d.body.includes('model-c'))).toBe(true);
  });

  it('ALL remaining fallbacks on cooldown -> dialed anyway instead of giving up', async () => {
    const A = mk('model-a');
    const B = mk('model-b');
    for (let i = 0; i < 3; i++) smartHealth.reportFailure(healthKey(B));
    responder = () => ({ status: 401, body: '{"error":{}}' });
    const res = fakeRes();
    handleCustomModelRequest(res, A, { contents: [] } as never, false, 0, [B]);
    await flush();
    expect(dials.some((d) => d.body.includes('model-b'))).toBe(true);
  });
});

describe('empty-stream rotation (free-router rule 11)', () => {
  const STREAM_OK = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n';

  it('200 stream that closes with NO content -> rotates to B instead of shipping an empty stream', async () => {
    const A = mk('model-a');
    const B = mk('model-b');
    responder = () => {
      if (dials.length <= 1) return { status: 200, body: '' };
      return { status: 200, body: STREAM_OK };
    };
    const res = fakeRes();
    handleCustomModelRequest(res, A, { contents: [] } as never, true, 0, [B]);
    await flush();
    expect(dials.length).toBe(2);
    expect(dials[1].body).toContain('model-b');
    expect(res.statusCode).toBe(200);
    expect(res.chunks.join('')).toContain('data:');
  });

  it('200 stream with no fallback left -> valid empty SSE completion, not a broken stream', async () => {
    const A = mk('model-a');
    responder = () => ({ status: 200, body: '' });
    const res = fakeRes();
    handleCustomModelRequest(res, A, { contents: [] } as never, true, 0, []);
    await flush();
    expect(dials.length).toBe(1);
    expect(res.statusCode).toBe(200);
    expect((res as unknown as { ended: boolean }).ended).toBe(true);
    expect(res.chunks.join('')).toContain('finishReason');
  });

  it('stream 429 with Retry-After: 5 -> same-model retry waits 5s, not 1s', async () => {
    const A = { ...mk('model-a'), maxRetries: 2 };
    responder = () => {
      if (dials.length <= 1) {
        return { status: 429, body: '{"error":{"message":"rate limit"}}', headers: { 'retry-after': '5' } };
      }
      return { status: 200, body: STREAM_OK };
    };
    const res = fakeRes();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      handleCustomModelRequest(res, A, { contents: [] } as never, true, 0, []);
      await vi.advanceTimersByTimeAsync(1000);
      expect(dials.length).toBe(1); // 1s elapsed - Retry-After says wait 5s
      await vi.advanceTimersByTimeAsync(4500);
      expect(dials.length).toBe(2); // 5.5s total - retry fired
      await flush();
      expect(res.statusCode).toBe(200);
      expect(res.chunks.join('')).toContain('data:');
    } finally {
      vi.useRealTimers();
    }
  });
});
