import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const directory = fs.mkdtempSync(path.resolve('.test-settings-backup-'));
process.env.DATA_DIR = directory;
const express = (await import('express')).default;
const database = await import('../db/database.js');
const auth = (await import('./auth.js')).default;
const backup = (await import('./settingsBackup.js')).default;
const service = await import('../services/settingsBackup.js');
const rows = await import('../db/lireekDb.js');

const appSettings = {
  coResident: false, cacheLmCodes: true, speculativeDecoding: true, downloadFormat: 'flac',
  downloadMp3Bitrate: 192, downloadOpusBitrate: 192, downloadVersion: 'mastered', downloadIncludeLatent: false,
  triggerUseFilename: false, triggerPlacement: 'prepend', discoKickExtract: false,
  parallelWhisper: false, parallelQualityEval: false, parallelCoverArt: false, generationTimeoutMinutes: 30,
};

test('settings backup validates, previews and atomically restores only the exported data', async t => {
  database.initDb();
  const db = database.getDb();
  const app = express();
  app.use(express.json());
  app.use('/auth', auth);
  app.use('/backup', backup);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const { token } = await (await fetch(`${base}/auth/auto`)).json() as { token: string };
    const post = async (action: string, body: unknown, authenticated = true) => {
      const response = await fetch(`${base}/backup/${action}`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
    const artist = rows.getOrCreateArtist('Backup fixture');
    const collection = rows.saveLyricsSet(artist.id, 'Collection', 1, [{ title: 'Track', lyrics: 'Original lyrics' }]);
    const profile = rows.saveProfile(collection.id, 'fixture', 'model', { themes: ['night'] });
    const generation = rows.saveGeneration({ profileId: profile.id, provider: 'fixture', model: 'model', lyrics: 'Original lyrics' });
    db.prepare('INSERT INTO audio_generations (generation_id, hotstep_job_id, audio_url) VALUES (?, ?, ?)')
      .run(generation.id, 'fixture-job', '/audio/fixture.wav');
    rows.upsertPreset(collection.id, { adapterPath: 'fixture.safetensors' });
    rows.setSetting('fixture.preference', 'original');
    const usersBefore = db.prepare('SELECT * FROM users').all();
    db.prepare("INSERT INTO songs (id, user_id, title, audio_url) SELECT 'backup-library-sentinel', id, 'Library fixture', '/audio/fixture.wav' FROM users LIMIT 1").run();
    const songsBefore = db.prepare('SELECT * FROM songs').all();
    const exported = await post('export', { app: appSettings });
    assert.equal(exported.status, 200, JSON.stringify(exported.body));
    const file = JSON.parse(JSON.stringify(exported.body));

    await t.test('round trip includes the actual migrated schema and leaves users alone', async () => {
      rows.setSetting('fixture.preference', 'changed');
      rows.getOrCreateArtist('Replacement fixture');
      const result = await post('import', { backup: file, confirmed: true });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.deepEqual(result.body.app, appSettings);
      const again = (await post('export', { app: result.body.app })).body;
      assert.deepEqual(again.settings, file.settings);
      assert.deepEqual(again.lyricStudio, file.lyricStudio);
      assert.deepEqual(db.prepare('SELECT * FROM users').all(), usersBefore);
      assert.deepEqual(db.prepare('SELECT * FROM songs').all(), songsBefore);
    });
    await t.test('preview reports replacement counts without writing', async () => {
      rows.getOrCreateArtist('Current extra fixture');
      const result = await post('preview', { backup: file });
      assert.equal(result.status, 200);
      assert.equal(result.body.current.artists, 2);
      assert.equal(result.body.incoming.artists, 1);
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM artists').get() as { n: number }).n, 2);
    });
    await t.test('missing confirmation cannot overwrite', async () => {
      assert.equal((await post('import', { backup: file })).status, 400);
    });
    await t.test('unknown versions and wrong shapes give a clear 400', async () => {
      const version = await post('preview', { backup: { ...file, version: 99 } });
      assert.equal(version.status, 400);
      assert.match(version.body.error, /Unsupported backup version 99/);
      for (const bad of [null, [], {}, { ...file, settings: [] }, { ...file, lyricStudio: {} },
        { ...file, settings: { ...file.settings, app: { ...appSettings, cacheLmCodes: 'yes' } } }]) {
        assert.equal((await post('import', { backup: bad, confirmed: true })).status, 400);
      }
    });
    await t.test('broken relationships and duplicate IDs are rejected before replacement', async () => {
      const bad = structuredClone(file);
      bad.lyricStudio.profiles[0].lyrics_set_id = 999;
      assert.equal((await post('import', { backup: bad, confirmed: true })).status, 400);
      const duplicate = structuredClone(file);
      duplicate.lyricStudio.artists.push(duplicate.lyricStudio.artists[0]);
      assert.equal((await post('preview', { backup: duplicate })).status, 400);
      const badJson = structuredClone(file);
      badJson.lyricStudio.profiles[0].profile_data = 'invalid json';
      assert.equal((await post('preview', { backup: badJson })).status, 400);
    });
    await t.test('constraint failure rolls back all deletions and settings changes', () => {
      const bad = structuredClone(file);
      bad.lyricStudio.artists.push({ ...bad.lyricStudio.artists[0], id: 999 });
      const before = service.exportSettingsBackup(db, appSettings);
      assert.throws(() => service.importSettingsBackup(db, bad), /UNIQUE/);
      const after = service.exportSettingsBackup(db, appSettings);
      assert.deepEqual(after.settings, before.settings);
      assert.deepEqual(after.lyricStudio, before.lyricStudio);
    });
    await t.test('all operations require the current local auth session', async () => {
      for (const action of ['export', 'preview', 'import']) {
        assert.equal((await post(action, { app: appSettings, backup: file, confirmed: true }, false)).status, 401);
      }
    });
    await t.test('a later parent generation restores with deferred foreign keys', () => {
      const data = structuredClone(file);
      data.lyricStudio.generations.push({ ...data.lyricStudio.generations[0], id: 999 });
      data.lyricStudio.generations[0].parent_generation_id = 999;
      service.importSettingsBackup(db, data);
      assert.equal((db.prepare('SELECT parent_generation_id FROM generations WHERE id = ?').get(generation.id) as { parent_generation_id: number }).parent_generation_id, 999);
      assert.deepEqual(db.pragma('foreign_key_check'), []);
    });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    database.closeDb();
    // This test creates this exact directory beneath its working directory.
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
