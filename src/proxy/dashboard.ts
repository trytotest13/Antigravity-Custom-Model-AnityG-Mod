/**
 * Model Dashboard: a small web UI served by the proxy at /dashboard.
 *
 * The old Antigravity app had Settings -> Add Model; the new "Antigravity
 * IDE" 2.5.x packaging has no such UI, so the proxy serves one: list / add /
 * test / delete custom models in the browser, no JSON editing required.
 *
 * This module is intentionally Electron-free so it can be unit-tested
 * directly. File persistence stays in proxy.ts (cryptoStore lives there).
 */

import * as registry from './registry';

// ─── Provider presets ─────────────────────────────────────────────────────

export interface ProviderPreset {
  id: string;
  label: string;
  url: string;
  needsKey: boolean;
  keyHint: string;
}

export const PROVIDERS: ProviderPreset[] = [
  { id: 'openai', label: 'OpenAI (ChatGPT)', url: 'https://api.openai.com/v1/chat/completions', needsKey: true, keyHint: 'sk-...' },
  { id: 'anthropic', label: 'Anthropic (Claude)', url: 'https://api.anthropic.com/v1/messages', needsKey: true, keyHint: 'sk-ant-...' },
  { id: 'google', label: 'Google AI Studio (Gemini)', url: 'https://generativelanguage.googleapis.com/v1beta', needsKey: true, keyHint: 'AIza...' },
  { id: 'openrouter', label: 'OpenRouter', url: 'https://openrouter.ai/api/v1/chat/completions', needsKey: true, keyHint: 'sk-or-v1-...' },
  { id: 'ollama', label: 'Ollama (Local)', url: 'http://localhost:11434/v1/chat/completions', needsKey: false, keyHint: 'no key needed' },
  { id: 'free-router', label: 'Free Router (Local Gateway)', url: 'http://127.0.0.1:8787/v1', needsKey: false, keyHint: 'no key needed' },
  { id: 'custom', label: 'Custom (OpenAI-compatible)', url: '', needsKey: true, keyHint: "provider's API key" },
];

/** Provider ids accepted from the dashboard form (schemaValidator allows more; these are the ones we preset). */
const PRESET_IDS = new Set(PROVIDERS.map((p) => p.id));

// ─── Shape helpers ────────────────────────────────────────────────────────

export interface SafeModel {
  name: string;
  displayName: string;
  description: string;
  provider: string;
  apiUrl: string;
  externalModelName: string;
  keyMasked: string;
}

/** Strips the API key before sending a model to the browser. */
export function sanitizeModel(m: {
  name?: string;
  displayName?: string;
  description?: string;
  provider?: string;
  apiUrl?: string;
  externalModelName?: string;
  apiKey?: string;
}): SafeModel {
  return {
    name: m.name || '',
    displayName: m.displayName || m.name || '',
    description: m.description || '',
    provider: m.provider || 'custom',
    apiUrl: m.apiUrl || '',
    externalModelName: m.externalModelName || '',
    keyMasked: maskKey(m.apiKey || ''),
  };
}

export function maskKey(key: string): string {
  if (!key) return '';
  if (key === 'none' || key.startsWith('fallback:')) return '(none)';
  if (key.length <= 10) return '••••••';
  return key.slice(0, 6) + '…' + key.slice(-4);
}

export function slugifyModelId(id: string): string {
  return id
    .trim()
    .toLowerCase()
    .replace(/^models\//, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export interface NewModel {
  name: string;
  displayName: string;
  description: string;
  provider: string;
  apiKey: string;
  apiUrl: string;
  externalModelName: string;
}

/**
 * Validates the dashboard form payload and fills provider defaults.
 * Returns { model } on success or { error } with a user-facing message.
 */
export function normalizeModelInput(body: unknown): { model?: NewModel; error?: string } {
  if (!body || typeof body !== 'object') return { error: 'Request body must be a JSON object.' };
  const b = body as Record<string, unknown>;
  const provider = String(b.provider || '').trim();
  if (!PRESET_IDS.has(provider)) return { error: 'Pick a provider from the list.' };

  const id = String(b.id || '').trim();
  if (!id) return { error: 'Model Name / ID is required.' };

  let apiKey = String(b.apiKey || '').trim();
  const preset = PROVIDERS.find((p) => p.id === provider)!;
  if (preset.needsKey && !apiKey) return { error: 'API Key is required for ' + preset.label + '.' };
  if (!preset.needsKey) apiKey = apiKey || 'none';

  let apiUrl = String(b.apiUrl || '').trim() || preset.url;
  if (!apiUrl) return { error: 'API URL is required for Custom / Other providers.' };
  if (!/^https?:\/\//i.test(apiUrl)) return { error: 'API URL must start with http:// or https://.' };

  const slug = slugifyModelId(id);
  if (!slug) return { error: 'Model Name / ID must contain letters or numbers.' };

  const displayName = String(b.displayName || '').trim() || id;
  return {
    model: {
      name: 'models/' + slug,
      displayName,
      description: 'Added via dashboard (' + preset.label + ')',
      provider,
      apiKey,
      apiUrl,
      externalModelName: id.trim(),
    },
  };
}

// ─── Connection test ──────────────────────────────────────────────────────

/** Same URL fix-ups handleCustomModelRequest applies before dialing a provider. */
export function resolveProviderUrl(provider: string, baseUrl: string, modelName: string, isStream: boolean): string {
  if (provider === 'google' || provider === 'ollama') {
    return registry.getProviderUrl(baseUrl, modelName, isStream, provider);
  }
  return registry.withChatCompletions(baseUrl);
}

export interface TestResult {
  ok: boolean;
  status?: number;
  latencyMs: number;
  message: string;
}

/** Sends a tiny "ping" generation through the real translator for this provider. */
export async function testModelConnection(input: {
  provider: string;
  apiKey: string;
  apiUrl: string;
  externalModelName: string;
}): Promise<TestResult> {
  const provider = input.provider === 'custom' || input.provider === 'openrouter' || input.provider === 'free-router' ? 'openai' : input.provider;
  const pingBody = {
    contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: pong' }] }],
    generationConfig: { maxOutputTokens: 16 },
  };
  const payload = JSON.stringify(registry.translateRequest(provider, pingBody, input.externalModelName));
  const headers = registry.getProviderHeaders(provider, input.apiKey || 'none') as Record<string, string>;
  const urlStr = resolveProviderUrl(provider, input.apiUrl, input.externalModelName, false);

  const started = Date.now();
  try {
    const res = await fetch(urlStr, {
      method: 'POST',
      headers,
      body: payload,
      signal: AbortSignal.timeout(20_000),
    });
    const latencyMs = Date.now() - started;
    const body = await res.text();
    if (res.ok) {
      let reply = '';
      try {
        reply = extractReplyText(provider, JSON.parse(body) as Record<string, unknown>);
      } catch {
        /* keep empty reply */
      }
      return {
        ok: true,
        status: res.status,
        latencyMs,
        message: reply ? 'Connected (' + latencyMs + ' ms) - model replied: ' + reply : 'Connected (' + latencyMs + ' ms)',
      };
    }
    return { ok: false, status: res.status, latencyMs, message: 'HTTP ' + res.status + ': ' + extractError(body) };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - started, message: (err as Error).message };
  }
}

function extractReplyText(provider: string, parsed: Record<string, unknown>): string {
  if (provider === 'anthropic') {
    const content = parsed.content as { type?: string; text?: string }[] | undefined;
    const text = (content || []).find((c) => c.type === 'text')?.text;
    return (text || '').slice(0, 80);
  }
  const choices = parsed.choices as { message?: { content?: string } }[] | undefined;
  return ((choices && choices[0]?.message?.content) || '').slice(0, 80);
}

function extractError(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
    if (typeof parsed.error === 'string') return parsed.error.slice(0, 200);
    if (parsed.error?.message) return parsed.error.message.slice(0, 200);
    if (parsed.message) return parsed.message.slice(0, 200);
  } catch {
    /* not JSON */
  }
  return body.slice(0, 200) || '(empty response)';
}

// ─── Dashboard HTML ───────────────────────────────────────────────────────

export function buildDashboardHtml(): string {
  const providerOptions = PROVIDERS.map((p) => '<option value="' + p.id + '">' + p.label + '</option>').join('');
  const defaultUrls = JSON.stringify(Object.fromEntries(PROVIDERS.map((p) => [p.id, p.url])));
  const needsKey = JSON.stringify(Object.fromEntries(PROVIDERS.map((p) => [p.id, p.needsKey])));
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AnityG-Mod - Custom Models</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px 16px; background: #141414; color: #e8e8e8;
         font: 14px/1.5 system-ui, sans-serif; }
  .wrap { max-width: 720px; margin: 0 auto; }
  h1 { font-size: 20px; font-weight: 600; }
  .sub { color: #9a9a9a; margin: 0 0 20px; }
  .card { background: #1f1f1f; border: 1px solid #2e2e2e; border-radius: 12px;
          padding: 14px 16px; margin-bottom: 10px; display: flex; align-items: center; gap: 14px; }
  .card .info { flex: 1; min-width: 0; }
  .card .name { font-weight: 600; }
  .badge { font-size: 10px; font-weight: 700; padding: 2px 8px;
           border-radius: 999px; text-transform: uppercase; background: #333; color: #ccc; }
  .card .url { color: #8a8a8a; font-size: 12px; white-space: nowrap; overflow: hidden;
               text-overflow: ellipsis; margin-top: 2px; }
  .card .key { color: #777; font-size: 11px; margin-top: 2px; }
  button { background: #2e2e2e; color: #e8e8e8; border: 1px solid #3d3d3d; border-radius: 8px;
           padding: 7px 12px; cursor: pointer; font-size: 13px; }
  button:hover { background: #3a3a3a; }
  button.primary { background: #e8e8e8; color: #141414; border-color: #e8e8e8; font-weight: 600; }
  .card .actions { display: flex; gap: 8px; align-items: center; flex-shrink: 0; }
  .empty { text-align: center; color: #777; padding: 32px 0; }
  .panel { background: #1b1b1b; border: 1px solid #2e2e2e; border-radius: 12px; padding: 20px; margin-top: 18px; }
  .panel h2 { margin: 0 0 14px; font-size: 15px; }
  label { display: block; font-size: 12px; color: #a8a8a8; margin: 12px 0 4px; }
  input, select { width: 100%; background: #262626; color: #eee; border: 1px solid #3a3a3a;
                  border-radius: 8px; padding: 9px 10px; font-size: 13px; }
  .row { display: flex; gap: 10px; margin-top: 18px; }
  .spacer { flex: 1; }
  #testResult { font-size: 13px; margin-top: 12px; min-height: 18px; }
  .ok { color: #34d399; } .bad { color: #f87171; }
  #status { font-size: 13px; margin: 10px 0; min-height: 18px; }
  .hint { color: #8a8a8a; font-size: 12px; margin-top: 6px; }
  .toggle-card { background: #1b1b1b; border: 1px solid #2e2e2e;
                 border-radius: 12px; padding: 16px 18px; margin: 14px 0 18px; display: flex;
                 align-items: center; gap: 14px; }
  .toggle-card .t-info { flex: 1; min-width: 0; }
  .toggle-card .t-title { font-weight: 600; font-size: 14px; }
  .toggle-card .t-sub { color: #8a8a8a; font-size: 12px; margin-top: 2px; }
  .test-status { font-size: 12px; font-weight: 600; }
  .test-status.pass { color: #34d399; } .test-status.fail { color: #f87171; } .test-status.none { display: none; }
</style>
</head>
<body>
<div class="wrap">
  <h1><span class="dot"></span> Custom AI Models</h1>
  <p class="sub">Served by the AnityG-Mod local proxy. Saved models appear in the IDE model picker within a few seconds - no JSON editing needed.</p>
  <div id="status"></div>
  <div class="toggle-card" id="toggleCard">
    <div class="t-info">
      <div class="t-title">⚡ Auto Rotation / Smart Router
        <span class="t-state on" id="autoState">ON</span>
      </div>
      <div class="t-sub">When ON, failed requests automatically rotate to the next model and the "Auto (Smart Router)" entry picks the best model per request. When OFF, requests dial the selected model directly with no rotation.</div>
    </div>
    <button id="autoToggle" class="on" aria-live="polite">Turn OFF</button>
  </div>
  <div id="list"><div class="empty">Loading…</div></div>

  <div class="panel">
    <h2>Add Custom AI Model</h2>
    <label>API Provider</label>
    <select id="provider">${providerOptions}</select>
    <label>Model Name / ID <b>*</b></label>
    <input id="id" placeholder="e.g. gpt-4o">
    <label>Friendly Display Name</label>
    <input id="displayName" placeholder="e.g. GPT-4o (OpenAI)">
    <label>API Key <b id="keyReq">*</b></label>
    <input id="apiKey" type="password" placeholder="Enter API key" autocomplete="off">
    <label>API URL <b>*</b></label>
    <input id="apiUrl" placeholder="https://…">
    <div class="row">
      <button id="testBtn">✓ Test Connection</button>
      <div class="spacer"></div>
      <button id="saveBtn" class="primary">Save Model</button>
    </div>
    <div id="testResult"></div>
    <p class="hint">The API URL is prefilled per provider - only change it for gateways or self-hosted endpoints.</p>
  </div>
</div>
<script>
(function () {
  var URLS = ${defaultUrls};
  var NEEDS_KEY = ${needsKey};
  var provider = document.getElementById('provider');
  var idEl = document.getElementById('id');
  var nameEl = document.getElementById('displayName');
  var keyEl = document.getElementById('apiKey');
  var urlEl = document.getElementById('apiUrl');
  var keyReq = document.getElementById('keyReq');
  var list = document.getElementById('list');
  var status = document.getElementById('status');
  var testResult = document.getElementById('testResult');
  var testStatuses = {};

  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

  function applyProvider() {
    var p = provider.value;
    urlEl.value = URLS[p] || '';
    keyEl.placeholder = NEEDS_KEY[p] === false ? 'no key needed' : 'Enter API key';
    keyReq.style.display = NEEDS_KEY[p] === false ? 'none' : 'inline';
  }
  provider.addEventListener('change', applyProvider);
  applyProvider();

  function load() {
    fetch('/api/models').then(function (r) { return r.json(); }).then(function (data) {
      if (!data.models || !data.models.length) {
        list.innerHTML = '<div class="empty">No models yet - add your first one below.</div>';
        return;
      }
      list.innerHTML = data.models.map(function (m) {
        var ts = testStatuses[m.name];
        var statusHtml = '';
        if (ts === 'pass') statusHtml = '<span class="test-status pass">Pass</span>';
        else if (ts === 'fail') statusHtml = '<span class="test-status fail">Fail</span>';
        else statusHtml = '<span class="test-status none"></span>';
        return '<div class="card" data-name="' + esc(m.name) + '">' +
          '<div class="info"><div class="name"><span class="dot" style="width:7px;height:7px;border-radius:50%;background:#22c55e"></span>' +
          esc(m.displayName) + ' <span class="badge ' + esc(m.provider) + '">' + esc(m.provider) + '</span></div>' +
          '<div class="url">' + esc(m.apiUrl) + '</div>' +
          '<div class="key">' + esc(m.externalModelName) + (m.keyMasked ? ' · key ' + esc(m.keyMasked) : '') + '</div></div>' +
          '<div class="actions">' +
          '<button class="reuse r" data-name="' + esc(m.name) + '" data-provider="' + esc(m.provider) + '" data-url="' + esc(m.apiUrl) + '" data-extname="' + esc(m.externalModelName) + '" data-display="' + esc(m.displayName) + '"><svg viewBox="0 0 24 24"><path d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z"/></svg>Reuse Info</button>' +
          '<button class="t" data-name="' + esc(m.name) + '">Test</button>' +
          statusHtml +
          '<button class="danger d" data-name="' + esc(m.name) + '">Delete</button>' +
          '</div></div>';
      }).join('');
    }).catch(function (e) {
      list.innerHTML = '<div class="empty bad">Failed to load: ' + esc(e.message) + '</div>';
    });
  }

  function note(msg, cls) { status.innerHTML = '<span class="' + (cls || '') + '">' + esc(msg) + '</span>'; }

  // ── Auto Rotation / Smart Router master switch ──
  var autoToggle = document.getElementById('autoToggle');
  var autoState = document.getElementById('autoState');
  function renderAutoState(on) {
    autoToggle.textContent = on ? 'Turn OFF' : 'Turn ON';
    autoToggle.className = on ? 'on' : 'off';
    autoState.textContent = on ? 'ON' : 'OFF';
    autoState.className = 't-state ' + (on ? 'on' : 'off');
  }
  function loadAutoState() {
    fetch('/api/router/status').then(function (r) { return r.json(); }).then(function (s) {
      renderAutoState(!!s.autoRouter);
    }).catch(function () { /* leave default ON */ });
  }
  autoToggle.addEventListener('click', function () {
    var turningOn = autoToggle.className === 'off';
    autoToggle.disabled = true;
    note(turningOn ? 'Enabling Auto Rotation…' : 'Disabling Auto Rotation…');
    fetch('/api/router/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: turningOn }) }).then(function (r) { return r.json(); }).then(function (s) {
        autoToggle.disabled = false;
        if (s.error) { note('Toggle failed: ' + s.error, 'bad'); return; }
        renderAutoState(!!s.autoRouter);
        note('Auto Rotation / Smart Router is now ' + (s.autoRouter ? 'ON' : 'OFF') + '.', s.autoRouter ? 'ok' : 'bad');
        load();
      }).catch(function (e) {
        autoToggle.disabled = false;
        note('Toggle failed: ' + e.message, 'bad');
      });
  });
  loadAutoState();

  list.addEventListener('click', function (ev) {
    var name = ev.target && ev.target.getAttribute ? ev.target.getAttribute('data-name') : null;
    if (!name) return;
    if (ev.target.classList.contains('d')) {
      if (!confirm('Delete model "' + name + '" from the IDE picker?')) return;
      fetch('/api/models/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name }) }).then(function (r) { return r.json(); }).then(function (res) {
          if (res.error) { note('Delete failed: ' + res.error, 'bad'); return; }
          note('Deleted ' + name + '. It disappears from the picker on the IDE\u2019s next refresh.');
          load();
        });
    } else if (ev.target.classList.contains('t')) {
      note('Testing ' + name + '…');
      fetch('/api/models/test', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name }) }).then(function (r) { return r.json(); }).then(function (res) {
          testStatuses[name] = res.ok ? 'pass' : 'fail';
          note(name + ': ' + res.message, res.ok ? 'ok' : 'bad');
          load();
        });
    } else if (ev.target.classList.contains('r') || (ev.target.parentElement && ev.target.parentElement.classList.contains('r'))) {
       var btn = ev.target.classList.contains('r') ? ev.target : ev.target.parentElement;
       var p = btn.getAttribute('data-provider') || 'custom';
       var u = btn.getAttribute('data-url') || '';
       var ext = btn.getAttribute('data-extname') || '';
       var disp = btn.getAttribute('data-display') || '';
       var modelName = btn.getAttribute('data-name') || '';
       provider.value = p;
       applyProvider();
       idEl.value = ext;
       nameEl.value = disp;
       urlEl.value = u;
       keyEl.value = '';
       document.querySelector('.panel').scrollIntoView({ behavior: 'smooth' });
       note('Loading API key for "' + disp + '"…', 'ok');
       fetch('/api/models/key', { method: 'POST', headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({ name: modelName }) }).then(function (r) { return r.json(); }).then(function (res) {
           if (res.apiKey) {
             keyEl.value = res.apiKey;
             note('Pre-filled form with all info from "' + disp + '" - ready to save.', 'ok');
           } else {
             keyEl.focus();
             note('Pre-filled form from "' + disp + '" - enter your API key and save.', 'ok');
           }
         }).catch(function () {
           keyEl.focus();
           note('Pre-filled form from "' + disp + '" - could not fetch key, enter it manually.', 'ok');
         });
    }
  });

  document.getElementById('testBtn').addEventListener('click', function () {
    testResult.innerHTML = '<span class="hint">Testing…</span>';
    fetch('/api/models/test', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: provider.value, id: idEl.value, apiKey: keyEl.value, apiUrl: urlEl.value,
        displayName: nameEl.value }) }).then(function (r) { return r.json(); }).then(function (res) {
        testResult.innerHTML = '<span class="' + (res.ok ? 'ok' : 'bad') + '">' + esc(res.message) + '</span>';
      }).catch(function (e) {
        testResult.innerHTML = '<span class="bad">' + esc(e.message) + '</span>';
      });
  });

  document.getElementById('saveBtn').addEventListener('click', function () {
    fetch('/api/models', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: provider.value, id: idEl.value, apiKey: keyEl.value, apiUrl: urlEl.value,
        displayName: nameEl.value }) }).then(function (r) { return r.json(); }).then(function (res) {
        if (res.error) { note(res.error, 'bad'); return; }
        note('Saved "' + res.saved + '" - it appears in the IDE picker within a few seconds.');
        idEl.value = ''; nameEl.value = ''; keyEl.value = '';
        testResult.innerHTML = '';
        load();
      }).catch(function (e) { note('Save failed: ' + e.message, 'bad'); });
  });

  load();
})();
</script>
</body>
</html>`;
}
