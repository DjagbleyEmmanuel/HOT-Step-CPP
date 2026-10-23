// Mount at /api/settings/backup, after the JSON body parser.
// POST /export: download JSON; POST /preview: validate without writing; POST /import: confirmed replacement.
import { Router, type RequestHandler } from 'express';
import type Database from 'better-sqlite3';
import { getDb } from '../db/database.js';
import { getUserId } from './auth.js';
import { BackupValidationError, exportSettingsBackup, importSettingsBackup, previewSettingsBackup } from '../services/settingsBackup.js';

export function createSettingsBackupRouter(database: () => Database.Database = getDb, authorized = getUserId) {
  const router = Router();
  router.use((req, res, next) => {
    if (!authorized(req)) { res.status(401).json({ error: 'Unauthorized' }); return; }
    next();
  });
  const handle = (action: 'export' | 'preview' | 'import'): RequestHandler => (req, res) => {
      try {
        if (action === 'export') {
          const data = exportSettingsBackup(database(), req.body?.app);
          res.setHeader('Content-Disposition', 'attachment; filename="hotstep-settings-backup.json"');
          res.json(data);
        } else if (action === 'preview') {
          res.json(previewSettingsBackup(database(), req.body?.backup));
        } else {
          if (req.body?.confirmed !== true) {
            res.status(400).json({ error: 'Confirm replacement before importing this backup.' }); return;
          }
          res.json({ app: importSettingsBackup(database(), req.body?.backup) });
        }
      } catch (error) {
        const invalid = error instanceof BackupValidationError;
        if (!invalid) console.error('[SettingsBackup]', error);
        res.status(invalid ? 400 : 500).json({ error: invalid ? error.message : 'Backup operation failed. No import changes were saved.' });
      }
  };
  router.post('/export', handle('export'));
  router.post('/preview', handle('preview'));
  router.post('/import', handle('import'));
  return router;
}

export default createSettingsBackupRouter();
