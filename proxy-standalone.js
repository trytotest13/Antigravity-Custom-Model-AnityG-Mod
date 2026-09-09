// AnityG-Mod standalone proxy launcher (new "Antigravity IDE" 2.5.x, no Electron).
// The new IDE reads its Cloud Code endpoint from the `jetski.cloudCodeUrl`
// setting and passes it to the language server via --cloud_code_endpoint,
// so no binary patch / asar repack is needed: point the setting at this
// proxy and it intercepts v1internal:* like the old in-app proxy did.
//
// dist/proxy.js imports 'electron' (app.getPath) and 'electron-log'.
// Under plain Node we shim both via Module._load before requiring it.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const home = os.homedir();
const electronStub = {
  app: {
    isPackaged: true,
    getPath: (name) => {
      if (name === 'home') return home;
      if (name === 'userData') return path.join(home, '.gemini', 'antigravity');
      if (name === 'logs') return path.join(home, '.gemini', 'antigravity', 'logs');
      return home;
    },
  },
  // cryptoStore only uses safeStorage; report unavailable -> base64 fallback.
  safeStorage: { isEncryptionAvailable: () => false },
};
const logStub = {
  info: (...a) => console.log('[proxy]', ...a),
  warn: (...a) => console.warn('[proxy]', ...a),
  error: (...a) => console.error('[proxy]', ...a),
  debug: (...a) => console.debug('[proxy]', ...a),
};

const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return electronStub;
  if (request === 'electron-log' || request === 'electron-log/main')
    return { __esModule: true, default: logStub, ...logStub };
  return origLoad.call(this, request, ...rest);
};

const proxy = require('./dist/proxy.js');

function writePortFile(port) {
  try {
    const dir = path.join(home, '.gemini', 'antigravity');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'active_port'), String(port));
  } catch (e) {
    console.error('[proxy] could not write active_port file:', e.message);
  }
}

proxy
  .startProxy()
  .then((port) => {
    console.log(`[proxy] listening on http://127.0.0.1:${port} (set jetski.cloudCodeUrl to this)`);
    writePortFile(port);
  })
  .catch((e) => {
    console.error('[proxy] failed to start:', e);
    process.exit(1);
  });

process.on('SIGINT', () => proxy.stopProxy().then(() => process.exit(0)));
process.on('SIGTERM', () => proxy.stopProxy().then(() => process.exit(0)));
