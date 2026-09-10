/**
 * End-to-end rotation test over REAL sockets (no http-module mocks).
 *
 * Starts the actual proxy server with Electron/electron-log stubbed and the
 * home directory pointed at a throwaway temp dir, plus three real mock
 * upstream servers. IDE-shaped requests then go through the whole path:
 * server -> model match -> rotation chain -> upstream dial -> client response.
 * Nothing here touches the user's real ~/.gemini/antigravity config.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const h = vi.hoisted(() => ({ home: '' }));

vi.mock('electron', async () => {
  const fsMod = await import('fs');
  const osMod = await import('os');
  const pathMod = await import('path');
  h.home = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'anityg-e2e-'));
  return {
    app: {
      isPackaged: true,
      getPath: (name: string) => (name === 'home' ? h.home : pathMod.join(h.home, name)),
    },
    safeStorage: { isEncryptionAvailable: () => false },
  };
});
vi.mock('electron-log', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// cryptoStore pulls electron via CJS require(), which vi.mock('electron')
// cannot intercept. Plain (non-encrypted) keys pass through unchanged in the
// real implementation too, so a passthrough mock is faithful.
vi.mock('../cryptoStore', () => ({
  encryptModels: (m: unknown[]) => m,
  decryptModels: (m: unknown[]) => m,
  backupFile: () => {},
  encryptString: (s: string) => s,
  decryptString: (s: string) => s,
}));

import { startProxy, stopProxy, getProxyPort } from '../proxy';
import { smartHealth } from '../proxy/smartHealth';

// ─── Mock upstreams ───────────────────────────────────────────────────────

type Handler = (res: http.ServerResponse) => void;

interface Upstream {
  name: string;
  port: number;
  state: { dials: number; handler: Handler };
  server: http.Server;
}

const okJson = (name: string): Handler => (res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content: 'pong-' + name } }] }));
};
const sse = (name: string): Handler => (res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'pong-' + name } }] }) + '\n\n');
  res.end();
};
const status = (code: number): Handler => (res) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'upstream ' + code } }));
};
const sseEmpty: Handler = (res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.end();
};

function makeUpstream(name: string, handler: Handler): Upstream {
  const state = { dials: 0, handler };
  const server = http.createServer((req, res) => {
    state.dials++;
    // Drain the request body, then answer.
    req.resume();
    req.on('end', () => state.handler(res));
  });
  return { name, port: 0, state, server };
}

const upA = makeUpstream('model-a', okJson('model-a'));
const upB = makeUpstream('model-b', okJson('model-b'));
const upC = makeUpstream('model-c', okJson('model-c'));
const upstreams = [upA, upB, upC];

function modelCfg(name: string, port: number) {
  return {
    name: 'models/' + name,
    displayName: name,
    description: 'e2e test model',
    provider: 'openai',
    apiKey: 'test-key-' + name,
    apiUrl: `http://127.0.0.1:${port}/v1/chat/completions`,
    externalModelName: name,
    maxRetries: 0,
    timeout: 5000,
  };
}

beforeAll(async () => {
  await Promise.all(
    upstreams.map(
      (u) =>
        new Promise<void>((resolve) => {
          u.server.listen(0, '127.0.0.1', () => {
            u.port = (u.server.address() as import('net').AddressInfo).port;
            resolve();
          });
        }),
    ),
  );

  const geminiDir = path.join(h.home, '.gemini', 'antigravity');
  fs.mkdirSync(geminiDir, { recursive: true });
  fs.writeFileSync(
    path.join(geminiDir, 'custom_models.json'),
    JSON.stringify({ models: [modelCfg('model-a', upA.port), modelCfg('model-b', upB.port), modelCfg('model-c', upC.port)] }),
    'utf-8',
  );

  await startProxy();
}, 15_000);

afterAll(async () => {
  await stopProxy();
  await Promise.all(upstreams.map((u) => new Promise<void>((r) => u.server.close(() => r()))));
  fs.rmSync(h.home, { recursive: true, force: true });
});

beforeEach(() => {
  smartHealth.clear();
  upstreams.forEach((u) => {
    u.state.dials = 0;
    u.state.handler = okJson(u.name);
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────

function post(urlPath: string, body: unknown): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: '127.0.0.1',
        port: getProxyPort(),
        path: urlPath,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
      },
      (res) => {
        let out = '';
        res.on('data', (c: Buffer) => (out += c.toString('utf-8')));
        res.on('end', () => resolve({ status: res.statusCode || 0, text: out }));
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}

const chatBody = { contents: [{ role: 'user', parts: [{ text: 'hello there' }] }] };

// ─── Tests ────────────────────────────────────────────────────────────────

// The real IDE dials /v1internal:*generateContent (lowercase g, as the proxy
// matches it) with the model named in the JSON body: { model, request }.
function cloudPost(model: string, stream: boolean, body: unknown): Promise<{ status: number; text: string }> {
  const action = stream ? 'streamGenerateContent' : 'generateContent';
  return post(`/v1internal:${action}`, { model, request: body });
}

describe('proxy end-to-end rotation (real sockets)', () => {
  it('non-stream: 429 -> 401 down the chain -> fallback answers the client', async () => {
    upA.state.handler = status(429);
    upB.state.handler = status(401);
    // upC keeps the default 200 "pong-model-c"

    const r = await cloudPost('custom-openai-model-a', false, chatBody);
    expect(r.status).toBe(200);
    expect(r.text).toContain('pong-model-c');
    expect(upA.state.dials).toBe(1);
    expect(upB.state.dials).toBe(1);
    expect(upC.state.dials).toBe(1);
  }, 15_000);

  it('stream: 200-but-empty stream from primary -> fallback SSE reaches the client', async () => {
    upA.state.handler = sseEmpty;
    upB.state.handler = sse('model-b');

    const r = await cloudPost('custom-openai-model-a', true, chatBody);
    expect(r.status).toBe(200);
    expect(r.text).toContain('data:');
    expect(r.text).toContain('pong-model-b');
    expect(upA.state.dials).toBe(1);
    expect(upB.state.dials).toBe(1);
    expect(upC.state.dials).toBe(0);
  }, 15_000);

  it('stream: fast-fail statuses rotate before anything is committed', async () => {
    upA.state.handler = status(503);
    upB.state.handler = sse('model-b');

    const r = await cloudPost('custom-openai-model-a', true, chatBody);
    expect(r.status).toBe(200);
    expect(r.text).toContain('pong-model-b');
    expect(upA.state.dials).toBe(1);
    expect(upC.state.dials).toBe(0);
  }, 15_000);

  it('Auto (Smart Router): virtual model serves the request through exactly one upstream', async () => {
    const r = await cloudPost('custom-auto-router', false, chatBody);
    expect(r.status).toBe(200);
    expect(r.text).toMatch(/pong-model-(a|b|c)/);
    const totalDials = upstreams.reduce((n, u) => n + u.state.dials, 0);
    expect(totalDials).toBe(1);
  }, 15_000);

  it('Auto (Smart Router) toggle OFF -> clear actionable error, no upstream dials', async () => {
    const settingsPath = path.join(h.home, '.gemini', 'antigravity', 'router_settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ autoRouter: false }), 'utf-8');
    try {
      const r = await cloudPost('custom-auto-router', false, chatBody);
      expect(r.status).toBe(400);
      expect(r.text).toContain('turned OFF');
      const totalDials = upstreams.reduce((n, u) => n + u.state.dials, 0);
      expect(totalDials).toBe(0);
    } finally {
      fs.rmSync(settingsPath, { force: true });
    }
  }, 15_000);
});
