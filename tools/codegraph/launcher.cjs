#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const binary = path.join(__dirname, 'node_modules', '@colbymchenry', 'codegraph', 'npm-shim.js');
const graphDir = path.join(root, '.codegraph');
const marker = path.join(graphDir, 'wrapper-sync.json');
const lock = path.join(graphDir, 'codegraph.lock');
const environment = {
  ...process.env,
  DO_NOT_TRACK: '1',
  CODEGRAPH_TELEMETRY: '0',
  CODEGRAPH_NO_DOWNLOAD: '1',
};
const readCommands = new Set(['query', 'explore', 'context', 'node', 'files', 'callers', 'callees', 'impact', 'affected']);
const lockError = /LockUnavailableError|could not acquire the file lock|rebuild of this index is in progress|could not open the rebuilt index/i;

function run(file, args, options = {}) {
  const result = spawnSync(file, args, {
    cwd: root,
    env: environment,
    encoding: 'utf8',
    windowsHide: true,
    ...options,
  });
  if (result.error) throw result.error;
  return result;
}

function git(args, options = {}) {
  const result = run('git', args, options);
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
  return result.stdout;
}

function fingerprint() {
  const hash = crypto.createHash('sha256');
  hash.update(git(['rev-parse', 'HEAD']).trim());
  // The status text alone does not change when an already-dirty file is edited again.
  const status = git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all', '--', '.', ':(exclude).scratch/**']);
  hash.update(status);
  const records = status.split('\0');
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    const name = record.slice(3);
    hash.update(name);
    const file = path.join(root, name);
    if (!fs.existsSync(file)) hash.update('<missing>');
    else if (fs.lstatSync(file).isSymbolicLink()) hash.update(fs.readlinkSync(file));
    else if (fs.statSync(file).isFile()) hash.update(fs.readFileSync(file));
    else hash.update('<directory>');
    if (record[0] === 'R' || record[1] === 'R' || record[0] === 'C' || record[1] === 'C') i++;
  }
  return hash.digest('hex');
}

function synced(freshness) {
  try {
    const state = JSON.parse(fs.readFileSync(marker, 'utf8'));
    return state.version === 1 && state.fingerprint === freshness;
  } catch {
    return false;
  }
}

function markSynced(freshness) {
  const temp = `${marker}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ version: 1, fingerprint: freshness }) + '\n');
  try {
    fs.renameSync(temp, marker);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForLock() {
  for (let attempt = 0; fs.existsSync(lock); attempt++) {
    if (attempt >= 20) throw new Error('index busy, use grep (codegraph lock did not clear)');
    pause(250);
  }
}

function sync() {
  for (let attempt = 0; attempt < 5; attempt++) {
    waitForLock();
    const freshness = fingerprint();
    if (synced(freshness) && fs.existsSync(path.join(graphDir, 'codegraph.db'))) return;
    const result = run(process.execPath, [binary, 'sync', root, '--quiet']);
    if (result.status === 0) {
      const after = fingerprint();
      if (freshness === after) {
        markSynced(after);
        return;
      }
      continue;
    }
    const message = `${result.stderr}\n${result.stdout}`;
    if (!lockError.test(message)) {
      process.stderr.write(message || 'codegraph sync failed\n');
      process.exit(result.status || 1);
    }
    pause(250 * (attempt + 1));
  }
  throw new Error('index busy or files kept changing; use grep');
}

try {
  if (!fs.existsSync(binary)) throw new Error('codegraph is not installed; run npm ci in tools/codegraph');
  const args = process.argv.slice(2);
  const command = args.find(arg => readCommands.has(arg) || arg === 'sync');
  if (command === 'sync') sync();
  else {
    if (readCommands.has(command) && !args.some(arg => arg === '--help' || arg === '-h')) sync();
    const result = run(process.execPath, [binary, ...args], { stdio: 'inherit' });
    process.exit(result.status ?? 1);
  }
} catch (error) {
  process.stderr.write(`cg: ${error.message}\n`);
  process.exit(1);
}
