#!/usr/bin/env node
// daw-contract-stub.mjs - teeth check for daw-contract-test.mjs.
// Serves a fake /api/v1/daw whose /status renames non_turbo_available to
// nonTurboAvailable. The contract test must FAIL against it.
//   node server/scripts/daw-contract-stub.mjs [--port 3911]
//   node server/scripts/daw-contract-test.mjs --base http://127.0.0.1:3911 --quick

import http from 'http';

const i = process.argv.indexOf('--port');
const port = i >= 0 ? Number(process.argv[i + 1]) : 3911;
const send = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

http.createServer((req, res) => {
  const url = req.url || '';
  if (url === '/api/v1/daw/status') {
    return send(res, 200, {
      api: 1, ace_server_alive: true, ready: false, boot_status: 'stub', version: 'stub',
      loaded_model: null, dit_models: [], nonTurboAvailable: false, capabilities: null,
    });
  }
  if (url === '/api/v1/daw/generate') return send(res, 400, { api: 1, error: { code: 'unsupported_mode', message: 'stub' } });
  return send(res, 404, { api: 1, error: { code: 'not_found', message: 'stub' } });
}).listen(port, '127.0.0.1', () => console.log(`stub on http://127.0.0.1:${port}`));
