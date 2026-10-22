'use strict';
// Regression: a cleaner holding the reclaim mutex blocks a second cleaner, so
// a live lock written after the first cleaner's unlink survives.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-lock-'));
fs.mkdirSync(path.join(root, 'tools/codegraph'), { recursive: true });
fs.mkdirSync(path.join(root, '.codegraph'));
fs.copyFileSync(path.join(__dirname, 'launcher.cjs'), path.join(root, 'tools/codegraph/launcher.cjs'));
const lock = path.join(root, '.codegraph/codegraph.lock');
const src = fs.readFileSync(path.join(root, 'tools/codegraph/launcher.cjs'), 'utf8');
// Run only clearStaleLock from the launcher source.
const run = () => spawnSync(process.execPath, ['-e', `
  const fs=require('fs'); const lock=${JSON.stringify(lock)};
  ${src.slice(src.indexOf('function clearStaleLock'), src.indexOf('function waitForLock'))}
  clearStaleLock();`], { encoding: 'utf8' });

const dead = spawnSync(process.execPath, ['-e', '']).pid;
fs.writeFileSync(lock, String(dead));
run();
assert(!fs.existsSync(lock), 'dead lock removed');

fs.writeFileSync(lock, String(process.pid));
run();
assert(fs.existsSync(lock), 'live lock kept');

// Interleaving: a cleaner that claims a lock which is live (replaced after another
// cleaner's unlink) must put it back untouched.
fs.writeFileSync(lock, String(process.pid));
run(); run(); run();
assert.strictEqual(fs.readFileSync(lock, 'utf8'), String(process.pid), 'live lock restored intact');
assert.deepStrictEqual(fs.readdirSync(path.dirname(lock)).filter(f => f.endsWith('.claim')), [], 'no claim files left');

// Many cleaners racing on one dead lock: it ends up gone and nothing is left behind.
fs.writeFileSync(lock, String(dead));
const racers = Array.from({ length: 8 }, () => new Promise(r => require('node:child_process').execFile(process.execPath, ['-e', `
  const fs=require('fs'); const lock=${JSON.stringify(lock)};
  ${src.slice(src.indexOf('function clearStaleLock'), src.indexOf('function waitForLock'))}
  clearStaleLock();`], r)));
Promise.all(racers).then(() => {
  assert(!fs.existsSync(lock), 'dead lock gone after race');
  assert.deepStrictEqual(fs.readdirSync(path.dirname(lock)), [], 'no leftovers');
  fs.rmSync(root, { recursive: true });
  console.log('stale-lock: ok');
});
