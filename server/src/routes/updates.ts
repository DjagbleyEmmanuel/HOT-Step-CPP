// updates.ts — in-app update notices (no download or install).
//   GET  /api/updates/status  cached state, never calls GitHub
//   POST /api/updates/check   refresh now (once a minute), optional { channel }
// Types: contracts/updates.ts.

import { Router } from 'express';
import type { Request } from 'express';
import { updates } from '../services/updates/index.js';
import type { UpdatesCheckRequest, UpdatesCheckResponse, UpdatesStatusResponse } from '../contracts/updates.js';

const router = Router();

// The API is open to any page on localhost (cors()), so a POST that changes
// state must come from this app: a cross-site Origin is refused.
const sameOrigin = (req: Request) => {
  const origin = req.get('origin');
  if (!origin) return true;
  try { return new URL(origin).host === req.get('host'); } catch { return false; }
};

router.get('/status', (_req, res) => {
  res.json(updates.status() satisfies UpdatesStatusResponse);
});

router.post('/check', async (req, res) => {
  if (!sameOrigin(req)) { res.status(403).json({ error: 'Cross-origin request refused' }); return; }
  const { channel } = (req.body ?? {}) as UpdatesCheckRequest;
  if (channel !== undefined && channel !== 'release' && channel !== 'master') { res.status(400).json({ error: 'channel must be "release" or "master"' }); return; }
  res.json(await updates.check({ manual: true, channel }) satisfies UpdatesCheckResponse);
});

export default router;
