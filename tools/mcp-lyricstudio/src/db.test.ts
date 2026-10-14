import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import Database from 'better-sqlite3';
import { getDb, initDb } from './db.js';

const packageDir = fileURLToPath(new URL('../', import.meta.url));

function scratch(t: test.TestContext): string {
  const dir = mkdtempSync(path.join(packageDir, '.db-test-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(packageDir));
    assert.ok(path.basename(dir).startsWith('.db-test-'));
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('missing HOTSTEP_DB exits with guidance and creates no database', t => {
  const dir = scratch(t);
  const dbPath = path.join(dir, 'missing.db');
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: packageDir,
    env: { ...process.env, HOTSTEP_DB: dbPath },
    encoding: 'utf8',
    timeout: 15_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes(dbPath));
  assert.match(result.stderr, /not found/i);
  assert.match(result.stderr, /HOTSTEP_DB/);
  assert.equal(existsSync(dbPath), false);
  assert.deepEqual(readdirSync(dir), []);
});

test('existing HOTSTEP_DB opens with its data and connection pragmas', t => {
  const dir = scratch(t);
  const dbPath = path.join(dir, 'existing.db');
  const fixture = new Database(dbPath);
  fixture.exec('CREATE TABLE marker (value TEXT); INSERT INTO marker VALUES (\'existing\')');
  fixture.close();
  const previous = process.env.HOTSTEP_DB;
  t.after(() => {
    if (previous === undefined) delete process.env.HOTSTEP_DB;
    else process.env.HOTSTEP_DB = previous;
  });
  process.env.HOTSTEP_DB = dbPath;
  initDb();
  try {
    assert.deepEqual(getDb().prepare('SELECT value FROM marker').get(), { value: 'existing' });
    assert.equal(getDb().pragma('journal_mode', { simple: true }), 'wal');
    assert.equal(getDb().pragma('foreign_keys', { simple: true }), 1);
  } finally {
    getDb().close();
  }
});
