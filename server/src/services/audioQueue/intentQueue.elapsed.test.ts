// intentQueue.elapsed.test.ts — elapsedSeconds is computed authoritatively by
// the server's own follow() loop, never inferred from a client's poll
// cadence. A client (ui/src/stores/audioGenQueueStore.ts) used to run its own
// timer against whatever status it happened to observe, which missed a job
// that started and finished between two of its polls (F19 review). The
// server's follow() loop runs on its own fixed interval regardless of any
// browser being open, so it cannot miss a transition the way a client can —
// see intentQueue.test.ts for the harness shape this borrows.
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { AudioIntentQueue, ensureAudioQueueSchema, type AudioQueueDeps } from './intentQueue.js';

type Job = { status: string; error?: string; result?: unknown };

/** Same harness shape as intentQueue.test.ts, but with a clock the test
 *  drives directly instead of one keyed to submit() calls — elapsedSeconds
 *  needs distinct timestamps across ticks that don't submit anything new. */
function harness(db = new Database(':memory:')) {
  const jobs = new Map<string, Job>();
  let next = 0;
  let time = 1000;
  const deps: AudioQueueDeps = {
    db,
    submit: async () => { const jobId = `job-${++next}`; jobs.set(jobId, { status: 'pending' }); return { ok: true, jobId }; },
    getJob: id => jobs.get(id),
    cancelJob: id => { const j = jobs.get(id); if (!j) return false; j.status = 'cancelled'; return true; },
    activeEngine: () => 'yue2',
    isEngine: id => ['ace', 'minimax-m3', 'yue2'].includes(id),
    now: () => time,
  };
  return { db, deps, jobs, queue: new AudioIntentQueue(deps), advance: (ms: number) => { time += ms; } };
}

const req = (extra: Record<string, unknown> = {}) => ({ caption: 'c', lyrics: 'l', seed: 1, expectedBackend: 'yue2', ...extra });

test('elapsedSeconds is null while queued, counts up once running, freezes on success', async () => {
  const h = harness();
  const item = h.queue.enqueue({ idempotencyKey: 'a', request: req() }, 'u').item;
  await h.queue.tick(); // claims + submits -> job-1, status 'pending'
  assert.equal(h.queue.get(item.id).elapsedSeconds, null, 'still queued at the engine, not generating yet');

  h.jobs.get('job-1')!.status = 'lm_running';
  h.advance(2000);
  await h.queue.tick(); // follow() sees it running for the first time -> started_at set here
  assert.equal(h.queue.get(item.id).elapsedSeconds, 0, 'just started; no real time has passed yet');

  h.advance(5000);
  assert.equal(h.queue.get(item.id).elapsedSeconds, 5, 'live count reflects real time since the engine actually started');

  h.jobs.get('job-1')!.status = 'succeeded';
  h.jobs.get('job-1')!.result = { audioUrls: ['/a.wav'] };
  h.advance(3000);
  await h.queue.tick(); // follow() detects success and freezes elapsedSeconds here
  const frozen = h.queue.get(item.id).elapsedSeconds;
  assert.equal(frozen, 8, 'frozen at the moment of success: 5000 + 3000ms of real generation');

  h.advance(60_000);
  assert.equal(h.queue.get(item.id).elapsedSeconds, frozen, 'a completed row must not keep counting up forever');
});

test('a job the engine never reports as queued still gets a sane elapsedSeconds, not null', async () => {
  // The race the client-side fix could not close: job.status is already
  // terminal the very first time anything looks at it, so there is no
  // 'running' observation to start a clock from. Falls back to the
  // submission timestamp rather than losing the badge entirely.
  const h = harness();
  const item = h.queue.enqueue({ idempotencyKey: 'a', request: req() }, 'u').item;
  await h.queue.tick(); // submits -> job-1, 'pending'
  h.jobs.get('job-1')!.status = 'succeeded';
  h.jobs.get('job-1')!.result = { audioUrls: ['/a.wav'] };
  h.advance(4000);
  await h.queue.tick();
  assert.equal(h.queue.get(item.id).elapsedSeconds, 4, 'falls back to time since submission, not null');
});

test('elapsedSeconds freezes on cancel mid-run, and retry clears it for the new attempt', async () => {
  const h = harness();
  const item = h.queue.enqueue({ idempotencyKey: 'a', request: req() }, 'u').item;
  await h.queue.tick();
  h.jobs.get('job-1')!.status = 'synth_running';
  h.advance(1000);
  await h.queue.tick(); // starts the clock
  h.advance(6000);
  h.queue.cancel(item.id);
  assert.equal(h.queue.get(item.id).status, 'cancelled');
  const frozen = h.queue.get(item.id).elapsedSeconds;
  assert.equal(frozen, 6, 'frozen at cancel time');
  h.advance(60_000);
  assert.equal(h.queue.get(item.id).elapsedSeconds, frozen, 'a cancelled row must not keep counting either');

  h.queue.retry(item.id);
  assert.equal(h.queue.get(item.id).elapsedSeconds, null, 'a fresh attempt starts with a clean clock, not the last attempt\'s frozen time');
});

test('ensureAudioQueueSchema adds started_at/elapsed_seconds to a database that predates them', () => {
  const db = new Database(':memory:');
  // Build the pre-F19 table by hand, missing the two new columns.
  db.exec(`CREATE TABLE audio_intents (
    id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL, status TEXT NOT NULL,
    engine TEXT NOT NULL, request TEXT NOT NULL, request_hash TEXT NOT NULL, meta TEXT, job_id TEXT,
    attempt INTEGER NOT NULL DEFAULT 1, previous_job_ids TEXT NOT NULL DEFAULT '[]', waiting TEXT,
    cancel_requested INTEGER NOT NULL DEFAULT 0, error TEXT, result TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`);
  db.prepare(`INSERT INTO audio_intents (id, idempotency_key, user_id, status, engine, request, request_hash, created_at, updated_at)
    VALUES ('old-1', 'k1', 'u', 'succeeded', 'ace', '{}', 'h', 1, 1)`).run();
  ensureAudioQueueSchema(db); // must not throw, and must not drop the pre-existing row
  const cols = (db.prepare(`SELECT name FROM pragma_table_info('audio_intents')`).all() as { name: string }[]).map(c => c.name);
  assert.ok(cols.includes('started_at') && cols.includes('elapsed_seconds'));
  assert.equal((db.prepare(`SELECT COUNT(*) AS c FROM audio_intents`).get() as { c: number }).c, 1);
  // Re-running on an already-migrated database must stay a no-op, not error.
  ensureAudioQueueSchema(db);
});
