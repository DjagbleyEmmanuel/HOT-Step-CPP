#!/usr/bin/env node
// daw-contract-stub.mjs - teeth check for daw-contract-test.mjs.
// Serves a fake /api/v1/daw whose /status renames non_turbo_available to
// nonTurboAvailable. The contract test must FAIL against it.
//   node server/scripts/daw-contract-stub.mjs [--port 3911]
//   node server/scripts/daw-contract-test.mjs --base http://127.0.0.1:3911 --quick
// --ok serves a well-formed /status instead (used by the HOT-STEP LINK heartbeat test).

import http from 'http';

const i = process.argv.indexOf('--port');
const port = i >= 0 ? Number(process.argv[i + 1]) : 3911;
const ok = process.argv.includes('--ok');
const send = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

http.createServer((req, res) => {
  const url = req.url || '';
  if (url === '/api/v1/daw/status' && ok) {
    const e = { base_s: 5, per_take_s: 2, per_audio_s: 0.1, cold_load_s: 10, source: 'default' };
    return send(res, 200, {
      api: 1, ace_server_alive: true, ready: true, boot_status: 'stub', version: 'stub',
      loaded_model: 'stub-model', dit_models: [], non_turbo_available: true, base_available: true,
      capabilities: null, eta_by_backend: { ace_turbo: e, ace_base: e, sa3: e, yue2: e },
    });
  }
  if (url === '/api/v1/daw/status') {
    return send(res, 200, {
      api: 1, ace_server_alive: true, ready: false, boot_status: 'stub', version: 'stub',
      loaded_model: null, dit_models: [], nonTurboAvailable: false, capabilities: null,
    });
  }
  if (url === '/api/v1/daw/generate') return send(res, 400, { api: 1, error: { code: 'unsupported_mode', message: 'stub' } });
  return send(res, 404, { api: 1, error: { code: 'not_found', message: 'stub' } });
}).listen(port, '127.0.0.1', () => console.log(`stub on http://127.0.0.1:${port}`));
