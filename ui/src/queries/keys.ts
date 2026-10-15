// keys.ts — the canonical query key schema.
//
// Every key is a fixed five-slot tuple:
//
//   ['hs', resource, scope, id, filters]
//
// - resource: a shared name below, or `<area>/<name>` for an area's own data.
// - scope: where the data lives. `api` is always the client's base. `session`
//   appears only on keys whose request carries the bearer token: an opaque
//   counter, never the token. `worker` (training: null = this PC) and
//   `backend` (generation engine) appear only when the data differs by them;
//   shared local resources omit both.
// - id: the single item, or null for a list/snapshot.
// - filters: normalized query parameters ({} when none).
//
// A queryFn reads its target back from its own key with scopeOf(), never from
// a mutable global, so a request always goes where its cache entry says.
// Prefix matching works per slot: ['hs', 'songs'] is every songs list,
// ['hs', 'training-data/datasets', { worker: 'A' }] every dataset list on A.

import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { apiClient } from '../services/httpClient';

export type Area = 'training-data' | 'training-runs' | 'global-models' | 'cover-lyrics' | 'studios' | 'shell-queue';

/** Resources more than one area reads. Any area may query one directly with
 *  its canonical key and canonical read below, so no area waits on another's
 *  hooks. The cached value is that read's result exactly; reshape it with
 *  `select`, never inside the queryFn. The owner area is the one that changes
 *  the read or the shape (docs/dev/ui-server-state.md). */
export const SHARED = {
  /** `songApi.list(token)`: `{ songs: Song[] }`, normalized. Auth. Owner: shell-queue. */
  songs: 'songs',
  /** `songApi.get(id)`: `{ song: Song }`, normalized. Auth. Owner: shell-queue. */
  song: 'song',
  /** `apiClient.get('/plugins')`: the raw registry JSON. Owner: global-models. */
  plugins: 'plugins',
  /** `apiClient.get('/capabilities?backend=<id>')`: raw JSON. Owner: global-models. */
  capabilities: 'capabilities',
  /** `apiClient.get('/logs/vram')`: raw JSON. Owner: global-models. */
  vram: 'vram',
  /** `apiClient.get('/logs/models-loaded')`: raw `{ loaded }`. Owner: global-models. */
  loadedModels: 'loaded-models',
} as const;
export type SharedResource = typeof SHARED[keyof typeof SHARED];
export type Resource = SharedResource | `${Area}/${string}`;

export interface KeyScope {
  api: string;
  session?: number;
  worker?: string | null;
  backend?: string;
}
export type Filters = Record<string, unknown>;
export type ServerKey = readonly ['hs', Resource, KeyScope, string | number | null, Filters];

// ── Auth session epoch ───────────────────────────────────────────────────

let sessionEpoch = 0;
let sessionToken: string | null = null;

/** The current session's epoch; changes whenever the bearer token does. */
export const getSessionEpoch = () => sessionEpoch;

/** Called by AuthProvider whenever its token changes. Bumps the epoch and
 *  cancels and drops every auth-scoped query of the old one, so no request
 *  made with a previous token can land in the new session's cache. Public
 *  keys (no `session`) are left alone. */
export function startAuthSession(client: QueryClient, token: string | null): number {
  if (token === sessionToken) return sessionEpoch;
  const old = sessionEpoch;
  sessionToken = token;
  sessionEpoch += 1;
  const filter = { queryKey: ['hs'] as const, predicate: (q: { queryKey: QueryKey }) => scopeOf(q.queryKey)?.session === old };
  void client.cancelQueries(filter);
  client.removeQueries(filter);
  return sessionEpoch;
}

// ── Factory ──────────────────────────────────────────────────────────────

/** Drops undefined/'' values and sorts keys, so equal requests share a key. */
export function normalizeFilters(filters: Filters = {}): Filters {
  const out: Filters = {};
  for (const k of Object.keys(filters).sort()) {
    const v = filters[k];
    if (v !== undefined && v !== '') out[k] = v;
  }
  return out;
}

export interface KeyParts {
  /** Include the session epoch; set for anything fetched with the token. */
  auth?: boolean;
  /** The training target the request goes to (null = this PC). Pass the
   *  value captured when scheduling, never a global read later. */
  worker?: string | null;
  backend?: string;
  id?: string | number | null;
  filters?: Filters;
}

export function serverKey(resource: Resource, parts: KeyParts = {}): ServerKey {
  const scope: KeyScope = { api: apiClient.baseUrl };
  if (parts.auth) scope.session = sessionEpoch;
  if (parts.worker !== undefined) scope.worker = parts.worker;
  if (parts.backend !== undefined) scope.backend = parts.backend;
  return ['hs', resource, scope, parts.id ?? null, normalizeFilters(parts.filters)];
}

/** Prefix for invalidating or cancelling a resource, optionally narrowed by
 *  scope fields (`{ worker: 'A' }`) and id. */
export function resourceKey(resource: Resource, scope?: Partial<KeyScope>, id?: string | number): QueryKey {
  if (id !== undefined) return ['hs', resource, scope ?? {}, id];
  return scope ? ['hs', resource, scope] : ['hs', resource];
}

/** The scope captured in a key, or undefined for a key not built here. */
export function scopeOf(key: QueryKey): KeyScope | undefined {
  return key[0] === 'hs' && key[2] && typeof key[2] === 'object' ? key[2] as KeyScope : undefined;
}

// ── Shared resource keys ─────────────────────────────────────────────────

export const sharedKeys = {
  songs: () => serverKey(SHARED.songs, { auth: true }),
  song: (id: string) => serverKey(SHARED.song, { auth: true, id }),
  plugins: () => serverKey(SHARED.plugins),
  capabilities: (backend: string) => serverKey(SHARED.capabilities, { backend }),
  vram: () => serverKey(SHARED.vram),
  loadedModels: () => serverKey(SHARED.loadedModels),
};
