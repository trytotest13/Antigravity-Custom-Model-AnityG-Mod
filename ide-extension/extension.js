'use strict';
/**
 * AnityG Mod - Model Manager (IDE extension).
 *
 * Bridges the gap the new Antigravity IDE 2.5.x packaging created: the mod is an
 * external proxy, so its add-model UI (the dashboard at /dashboard) never shows up
 * inside the IDE. This extension puts a launcher where the user already looks:
 *   - status bar button "AnityG Models"
 *   - command palette: "AnityG Mod: Add / Manage Custom Models (Dashboard)"
 *   - keybinding Ctrl+Alt+M
 * and keeps the proxy alive by starting it on IDE launch when it's not running.
 */
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const HOME = process.env.USERPROFILE || process.env.HOME || '';
const DATA_DIR = path.join(HOME, '.gemini', 'antigravity');
const PORT_FILE = path.join(DATA_DIR, 'active_port');
const DEFAULT_PORT = '50999';

/** Absolute path of the mod folder, written by deploy-ide.ps1 / installer. */
function modDir() {
  const marker = path.join(__dirname, 'moddir.txt');
  try {
    const v = fs.readFileSync(marker, 'utf8').trim();
    return v && fs.existsSync(path.join(v, 'proxy-standalone.js')) ? v : null;
  } catch {
    return null;
  }
}

function readPort() {
  try {
    const v = fs.readFileSync(PORT_FILE, 'utf8').trim();
    return /^\d+$/.test(v) ? v : DEFAULT_PORT;
  } catch {
    return DEFAULT_PORT;
  }
}

/** The proxy's base URL (port can change if 50999 is busy). */
function baseUrl() {
  return 'http://127.0.0.1:' + readPort();
}

function reachable(url, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get(url + '/api/models', { timeout: timeoutMs || 1500 }, (res) => {
      res.resume();
      resolve(!!res.statusCode && res.statusCode < 500);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

async function proxyUp() {
  const candidates = new Set([readPort(), DEFAULT_PORT]);
  for (const p of candidates) {
    if (await reachable('http://127.0.0.1:' + p)) return true;
  }
  return false;
}

/** Spawn the standalone proxy detached, logging where deploy-ide.ps1 logs. */
function startProxyProcess() {
  const dir = modDir();
  if (!dir) return false;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const out = fs.openSync(path.join(DATA_DIR, 'proxy.log'), 'a');
    const err = fs.openSync(path.join(DATA_DIR, 'proxy.err.log'), 'a');
    const child = spawn('node', ['proxy-standalone.js'], {
      cwd: dir,
      detached: true,
      stdio: ['ignore', out, err],
      windowsHide: true,
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** Wait until the proxy answers /api/models (re-reading active_port). */
async function waitUntilUp(ms) {
  const deadline = Date.now() + (ms || 20000);
  while (Date.now() < deadline) {
    if (await proxyUp()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

let panel = null;

function dashboardHtml(url) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none';
               frame-src ${url} https://*.vscode-cdn.net;
               style-src ${url} https://*.vscode-cdn.net 'unsafe-inline';
               script-src https://*.vscode-cdn.net 'unsafe-inline';">
<style>
  html, body { height: 100%; margin: 0; padding: 0; background: var(--vscode-editor-background, #1e1e1e); display: flex; flex-direction: column; }
  .bar { display: flex; justify-content: flex-end; align-items: center; gap: 8px; padding: 4px 8px; box-sizing: border-box;
         background: var(--vscode-panel-background, #181818); border-bottom: 1px solid var(--vscode-panel-border, #333); }
  .bar .url { margin-right: auto; font-family: var(--vscode-font-family); font-size: 11px; color: var(--vscode-descriptionForeground, #9ca3af);
              user-select: all; }
  .bar button { background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff); border: none;
                padding: 3px 10px; cursor: pointer; font-family: var(--vscode-font-family); font-size: 12px; border-radius: 2px; }
  .bar button:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
  iframe { border: 0; width: 100%; flex: 1; }
</style>
</head>
<body>
  <div class="bar">
    <span class="url">${url}/dashboard</span>
    <button id="ext">Open in browser &#8599;</button>
    <button id="reload">Reload</button>
  </div>
  <iframe id="frame" src="${url}/dashboard"
          sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-modals"></iframe>
  <script>
    const vscode = acquireVsCodeApi();
    document.getElementById('ext').addEventListener('click', () => vscode.postMessage({ cmd: 'openExternal' }));
    document.getElementById('reload').addEventListener('click', () => {
      document.getElementById('frame').src = document.getElementById('frame').src;
      vscode.postMessage({ cmd: 'refresh' });
    });
  </script>
</body>
</html>`;
}

async function openDashboard() {
  if (panel) {
    panel.reveal(vscode.ViewColumn.Active);
    return;
  }
  let up = await waitUntilUp(2000);
  if (!up && startProxyProcess()) {
    up = await waitUntilUp(20000);
  }
  const url = baseUrl();
  if (!up) {
    const pick = await vscode.window.showErrorMessage(
      `AnityG proxy is not reachable at ${url}. Run install.bat in the mod folder (or "node proxy-standalone.js" by hand), then try again.`,
      'Open in Browser Anyway'
    );
    if (pick === 'Open in Browser Anyway') {
      vscode.env.openExternal(vscode.Uri.parse(url + '/dashboard'));
    }
    refreshStatus();
    return;
  }
  // asExternalUri resolves port mapping under remote/wsl; local desktop is a no-op.
  let target = vscode.Uri.parse(url);
  try {
    target = await vscode.env.asExternalUri(target);
  } catch {
    /* keep plain url */
  }
  panel = vscode.window.createWebviewPanel(
    'anitygDashboard',
    'AnityG - Add / Manage Models',
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  panel.webview.html = dashboardHtml(target.toString().replace(/\/$/, ''));
  panel.webview.onDidReceiveMessage((m) => {
    if (m && m.cmd === 'openExternal') {
      vscode.env.openExternal(vscode.Uri.parse(url + '/dashboard'));
    }
  });
  panel.onDidDispose(() => {
    panel = null;
  });
  refreshStatus();
}

let statusItem = null;

function setStatus(icon, tooltip, running) {
  if (!statusItem) return;
  statusItem.text = `${icon} AnityG Models`;
  statusItem.tooltip = tooltip;
  statusItem.command = 'anitygModels.openDashboard';
  statusItem.backgroundColor = running
    ? undefined
    : new vscode.ThemeColor('statusBarItem.warningBackground');
}

async function refreshStatus() {
  const up = await proxyUp();
  setStatus(
    up ? '$(plug)' : '$(debug-disconnect)',
    up
      ? 'AnityG Mod proxy running - click to add / manage custom models (Ctrl+Alt+M)'
      : 'AnityG Mod proxy is NOT running - click to try starting it and open the dashboard',
    up
  );
}

function activate(context) {
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusItem.name = 'AnityG Models';
  setStatus('$(sync~spin)', 'AnityG Mod: checking proxy…', true);
  statusItem.show();

  context.subscriptions.push(
    statusItem,
    vscode.commands.registerCommand('anitygModels.openDashboard', openDashboard),
    vscode.commands.registerCommand('anitygModels.startProxy', async () => {
      if (await proxyUp()) {
        vscode.window.showInformationMessage('AnityG proxy is already running at ' + baseUrl());
        return;
      }
      if (!startProxyProcess()) {
        vscode.window.showErrorMessage(
          'Could not start the AnityG proxy: mod folder not found (re-run install.bat).'
        );
        return;
      }
      const up = await waitUntilUp(20000);
      if (up) vscode.window.showInformationMessage('AnityG proxy started at ' + baseUrl());
      else vscode.window.showErrorMessage('AnityG proxy failed to start - check proxy.err.log in %USERPROFILE%\\.gemini\\antigravity');
      refreshStatus();
    })
  );

  // Auto-start the proxy on IDE launch (survives reboots without install.bat),
  // then keep the status icon in sync.
  (async () => {
    const up = await proxyUp();
    if (!up && modDir()) {
      startProxyProcess();
      await waitUntilUp(20000);
    }
    refreshStatus();
    const timer = setInterval(refreshStatus, 30000);
    context.subscriptions.push({ dispose: () => clearInterval(timer) });
  })();
}

module.exports = { activate };
