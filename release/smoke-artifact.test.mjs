import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runCommand, smokeArtifact, smokeEngine, writeStubs } from './smoke-artifact.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, 'out');
fs.mkdirSync(out, { recursive: true });

function fixture(t) {
  const root = fs.mkdtempSync(path.join(out, 'artifact-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Real child processes exercise HTTP errors, crashes, hangs and cleanup without
// a GPU, native compiler or release archive. Full archive runs are separate.
const engineFixture = `
import fs from 'node:fs';
import http from 'node:http';
const [mode, pidFile, requestsFile, ...args] = process.argv.slice(2);
fs.writeFileSync(pidFile, String(process.pid));
if (mode === 'exit') process.exit(13);
if (mode === 'hang') { setInterval(() => {}, 1000); }
else {
  const port = Number(args[args.indexOf('--port') + 1]);
  http.createServer((req, res) => {
    fs.appendFileSync(requestsFile, req.url + '\\n');
    if (mode === 'bad-props' && req.url === '/props') res.writeHead(500);
    if (mode === 'stalled-props' && req.url === '/props') return;
    res.end('{}');
  }).listen(port, '127.0.0.1');
}
`;

for (const mode of ['pass', 'exit', 'hang', 'bad-props', 'stalled-props']) {
  test(`engine ${mode}: result and child cleanup`, { timeout: 15000 }, async t => {
    const root = fixture(t);
    const script = path.join(root, 'engine.mjs');
    const pidFile = path.join(root, 'pid');
    const requests = path.join(root, 'requests');
    const models = path.join(root, 'models');
    writeStubs(models);
    fs.writeFileSync(script, engineFixture);
    const run = smokeEngine(process.execPath, root, models, process.env, path.join(root, 'engine.log'),
      mode === 'hang' ? 1000 : 7000, [script, mode, pidFile, requests]);
    if (mode === 'pass') {
      await run;
      assert.deepEqual(fs.readFileSync(requests, 'utf8').trim().split('\n'), ['/health', '/health', '/props', '/plugins', '/props']);
    } else {
      await assert.rejects(run, mode === 'exit' ? /Engine exited/ : mode === 'hang' ? /Timed out/ : mode === 'bad-props' ? /HTTP 500/ : /abort|timeout/i);
    }
    assert.equal(alive(Number(fs.readFileSync(pidFile, 'utf8'))), false, 'engine process must be reaped');
    assert.ok(fs.existsSync(path.join(root, 'engine.log')), 'retain failure logs');
  });
}

test('failed command preserves exit code and output', { timeout: 15000 }, async t => {
  const root = fixture(t);
  const log = path.join(root, 'failure.log');
  await assert.rejects(runCommand(process.execPath, ['-e', 'console.error("bundle boot failed"); process.exit(13)'], {}, 3000, log), /exited 13/);
  assert.match(fs.readFileSync(log, 'utf8'), /bundle boot failed/);
});

test('Windows timeout kills the child and grandchild', { skip: process.platform !== 'win32', timeout: 15000 }, async t => {
  const root = fixture(t);
  const pidFile = path.join(root, 'pids');
  const script = `const fs = require('node:fs'); const { spawn } = require('node:child_process');
    const nested = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    fs.writeFileSync(process.argv[1], JSON.stringify([process.pid, nested.pid])); setInterval(() => {}, 1000);`;
  await assert.rejects(runCommand(process.execPath, ['-e', script, pidFile], {}, 1500, path.join(root, 'tree.log')), /Timed out/);
  for (const pid of JSON.parse(fs.readFileSync(pidFile, 'utf8'))) assert.equal(alive(pid), false, `PID ${pid} survived timeout`);
});

test('archive rejects checkout extraction and missing packaged runtime', { skip: process.platform !== 'win32', timeout: 20000 }, async t => {
  const root = fixture(t);
  const source = path.join(root, 'source');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'README.txt'), 'incomplete release fixture');
  const zip = path.join(root, 'broken.zip');
  await runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference = "Stop"; Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory($env:SMOKE_SOURCE, $env:SMOKE_ZIP)'],
  { env: { ...process.env, SMOKE_SOURCE: source, SMOKE_ZIP: zip } }, 10000, path.join(root, 'zip.log'));
  await assert.rejects(smokeArtifact(zip, { outputParent: root }), /outside the checkout/);
  // The gate chooses its own unique external directory; locate it from its log.
  let evidence;
  const original = console.log;
  console.log = value => { if (value.startsWith('smoke-artifact: evidence ')) evidence = value.slice('smoke-artifact: evidence '.length); };
  try {
    await assert.rejects(smokeArtifact(zip), /missing runtime\/node.exe/);
    const result = JSON.parse(fs.readFileSync(path.join(evidence, 'result.json'), 'utf8'));
    assert.equal(path.basename(result.root), 'HOT Step smoke');
    assert.ok(fs.existsSync(path.join(evidence, 'HOT Step smoke', 'README.txt')));
    assert.equal(result.status, 'fail');
  } finally {
    console.log = original;
    if (evidence) fs.rmSync(evidence, { recursive: true, force: true });
  }
});
