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
  ${src.slice(src.indexOf('const reclaim'), src.indexOf('function waitForLock'))}
  clearStaleLock();`], { encoding: 'utf8' });

const dead = spawnSync(process.execPath, ['-e', '']).pid;
fs.writeFileSync(lock, String(dead));
run();
assert(!fs.existsSync(lock), 'dead lock removed');

fs.writeFileSync(lock, String(process.pid));
run();
assert(fs.existsSync(lock), 'live lock kept');

// Interleaving: another cleaner is mid-recovery (mutex held) while a live lock sits there.
fs.writeFileSync(lock, String(dead));
fs.writeFileSync(lock + '.reclaim', '');
run();
assert(fs.existsSync(lock), 'second cleaner must not touch the lock while the mutex is held');
fs.unlinkSync(lock + '.reclaim');
run();
assert(!fs.existsSync(lock) && !fs.existsSync(lock + '.reclaim'), 'recovers and releases mutex');
fs.rmSync(root, { recursive: true });
console.log('stale-lock: ok');
