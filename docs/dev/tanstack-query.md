# TanStack Query — audit, status, and migration plan

Pinned to `@tanstack/react-query` ^5.104.3, audited against `ui/`.
This page is the **decision record and worklist** for the TanStack Query
integration. It records what is shipped, what is still open, and the rules the
implementation follows.

Companion documents (they own the detail, this page does not repeat it):

- [ui/src/queries/README.md](../../ui/src/queries/README.md) — layer map:
  file-by-file roles, per-area resource manifests, current usage inventory.
- [ui-server-state.md](ui-server-state.md) — policy contract: what is server
  state, what is client state, key schema, consumer manifest.
- [architecture.md — UI server-state integration audit](architecture.md#ui-server-state-integration-audit)
  — per-path dispositions and area owners (R1–R6 request model).

## Status at a glance

| Phase | Scope | Status |
|---|---|---|
| **P1** — deprecation sweep | Rename all `fetchQuery` → `queryClient.query()`; ESLint guard | **Done.** Zero non-test `fetchQuery`; rule at `eslint.config.js:23–29` |
| **P2** — transport + write foundation | One axios transport, one global error notifier, `writeAndInvalidate` / `useUpload`, one invalidation owner | **Done.** `tauri`-free JSON + upload traffic on `apiClient`; SSE stays on fetch |
| **P3** — component mutations | `useMutation` at the named write sites; double-toast sweep; nuke invalidation | **Done per exit criteria.** All named sites converted; no `toast.error` outside the interceptor |
| **P3.1** — mutation consistency | Legacy studios still using hand-rolled `try/catch` write handlers | **Done.** Lyric Studio CRUD, prompt/preset writes, song deletes converted; job-orchestration flows intentionally stay imperative |
| **P4** — `useQuery` conversions | Storm poll + control POSTs, remaining timers | **Done.** Snapshot poll, preview/scan conversions, and the six storm control/stop POSTs now use `apiClient`; the stream POST stays raw |
| **P5** — env form refactor | `useEnvSettingsForm` over `useQuery` | **Open.** SettingsPanel still uses `queryClient.query()` in a callback |
| **P6** — composers + dedup | One key composer per entity, duplicate factories, doc-only sanctions | **Mostly done.** F4 #3–#11 and #13 closed; #12 key remains util-local; #14–#16 are documented sanctions |
| **P7** — structural | Training SSE second owner, audio-queue executor state | **Deferred.** Needs an owner design before code |

**Verification (2026-10-24):** P1–P3 exit criteria re-checked against the code.
`tsc -b` clean; UI suite **372 pass / 2 pre-existing `.css` failures / 1 skip**;
targeted ESLint found only pre-existing `no-explicit-any`/React-compiler
findings in the touched files; `node tools/docs/check-docs.mjs` → `ok`.
The last P3 stragglers were fixed in this pass: both `extract-kick` POSTs and
the quit/restart calls in `App.tsx` now go through `apiClient` / `shutdownApi`,
and `shutdownApi.quit` / `adapterApi.scan` are silent so their inline-error
consumers do not double-toast. The P3.1 consistency pass converted the
remaining Lyric Studio CRUD handlers to `useMutation`; only long-lived
job/stream flows remain imperative by design (table below).

### Phase history (compressed)

- **2026-10-20** — audit written; F1–F5 recorded.
- **2026-10-21** — P1 shipped (`tanstack-p1-fetchquery`): 73 sites renamed,
  guard rule added.
- **2026-10-21** — P2 shipped (`tanstack-p2-fetchquery`): axios transport,
  global interceptor, `queries/writes.ts`, `queries/invalidation.ts`, upload
  collapse.
- **2026-10-22** — P3 shipped (`tanstack-p3-mutations`): named component
  mutations, double-toast sweep, i18n `api.error.*` copy.
- **2026-10-22** — post-P3 write-site audit (R1–R8) closed the remaining
  component mutations, corrected SongBuilder's optimistic write, and retired
  `runCommand` in favour of `trainingWritePlan`.
- **2026-10-23 / 24** — point-in-time read/write/imperative-surface audits
  completed and retired. All findings fixed; the audit files are deleted.

## Current architecture

```
[ UI components ]      consume query state, trigger mutations
       ↕
[ TanStack Query ]     caching, dedup, retry, isPending/isError
       ↕                queryManager for invalidation
[ Axios transport ]    one instance; request interceptor (auth),
       ↕                response interceptor (global catch + toasts)
[ REST API ]
```

| Concern | Owner | Rule |
|---|---|---|
| HTTP config, auth, timeouts | Axios instance + request interceptor | Bearer comes from the auth session accessor; fetchers do not thread `token`. Slow routes pass `SLOW_ROUTE_TIMEOUT_MS` (300 s) instead of the 60 s default |
| Caching, dedup, retry, status | TanStack Query (`contract.ts`) | staleTime 30 s, gcTime 5 min, focus refetch off, retry ≤ 2 for network/5xx only, mutation retry off |
| Error notification | Axios response interceptor | The one error notifier. Query-layer callbacks never toast |
| Success notification | Mutation `onSuccess` / handler | Contextual only; no toast when an inline result line or state change is the feedback |
| Cache coherence | `queryManager` (`queries/invalidation.ts`) | Only file that calls `invalidateQueries`; writes name events or exact keys |

### Error notification (interceptor filters)

The interceptor normalizes every failure to `ApiError`, logs once, and toasts
unless a filter says otherwise:

1. **Method filter** — GET errors never toast; reads surface inline `isError`.
   This is the storm guard (a failing 1.5 s poll toasts zero times).
2. **URL patterns** — `IGNORED_URL_PATTERNS` for endpoints that are never
   user-facing even as commands (health probes, analytics).
3. **Per-request escape** — `X-Skip-Global-Error`, set by
   `apiClient.*(..., { silent: true })`.

Status mapping: no response → "server unreachable"; 401 → one deduped
`toast.warn` while AuthProvider re-authenticates; 403/404/5xx → translated
`api.error.*` messages; otherwise the server's `error` field. Aborts are never
errors — no log, no toast. Uploads stay on XHR (only XHR reports upload
progress), but route failures through the same handler and now set
`xhr.timeout`.

**Guardrail:** a component that renders its own error line makes its request
silent; a request that stays non-silent must not also render a failure toast.

### Cache coherence

`queryManager` is the single invalidation entry point. Its event map covers
cross-cutting writes; parameterized writes pass exact keys/prefixes to the same
object:

```ts
queryManager.events: {
  'song:written':                 c => queryManager.songs.views(c),
  'sidecars:changed':             c => queryManager.sidecars.all(c),
  'cover-lyrics:lireek-purged':   c => queryManager.coverLyrics.lireek(c),
}
```

Two write paths use it:

- Components/stores that dirty the cache: `writeAndInvalidate(client, fn, plan)`
  or `useMutation` + `invalidateEvents`/`queryManager`.
- Stores owning a **non-cache projection** (`postProcessStore` run dock,
  `compareStore` sessions): deliberate direct commands tracked in store state.

`useCoverArtGeneration` is the reference pattern for a hook that owns a
mutation lifecycle; single-use commands stay inline as one `useMutation` per
command.

## Inventory (non-test grep, 2026-10-24)

| API | Count | Note |
|---|---|---|
| `useQuery` | 118 sites / 78 files | Declarative reads — the norm |
| `useQueries` | 3 sites / 3 files | Worker dispatch, worker list, curated profile |
| `useMutation` | 108 calls / 42 files | Named writes carry a pending/error lifecycle |
| `queryClient.fetchQuery` | 0 | Renamed by P1; ESLint guard prevents regressions |
| `prefetchQuery` / `ensureQueryData` | 0 / 0 | Not used |
| `getQueryData` | 1 (`queries/sseBridge.ts`) | Diff detection in the SSE bridge |
| `setQueryData` | 18 calls / 10 files | SSE writes and deliberate in-place patches |
| `useQueryClient` | 45 calls / 43 files | Mostly to invoke `queryManager` |
| `invalidateQueries` | only `queries/invalidation.ts` | One owner by construction |

**Query consistency:** every `useQuery` goes through an options factory,
including the 53 sites that spread one into an object for a local override
(`enabled`, `retry`, `refetchInterval`). The sole inline `queryKey` is the
sanctioned SSE cache slot in `useDownloadStream.ts` (F4#14). No component
builds a key or fetcher inline.

**Mutation consistency:** all 108 sites are `useMutation` with a service or
transport call in `mutationFn`. Pending state derives from `isPending` rather
than hand-rolled booleans. Long-lived job/stream flows stay imperative by
design — see the consistency follow-up. Invalidation APIs split between
`invalidateEvents` (named events, stores/cross-cutting writes),
`queryManager.invalidate` (parameterized keys — still the majority, P6 target),
and `trainingWritePlan` (training commands). That split is intentional and
documented; P6's composer work reduces the parameterized calls over time.

## Conventions

### `useQuery` vs `useMutation`

| Situation | Tool |
|---|---|
| Data is displayed, polled, shared, or must survive remount | `useQuery` over the owning factory |
| One-shot read that seeds a form/wizard and must not be background-refetched | imperative `query()` with `staleTime: 0` (existing pattern) |
| Read whose answer only seeds a panel and writes no server state (folder scan) | `useMutation` — a command, not an observed feed |
| A write drives visible pending/error/success state and dirties cached resources | `useMutation` in the component |
| A write from a zustand store or other non-React code | `writeAndInvalidate` (`queries/writes.ts`) |
| Queryable POST (idempotent, body in the key) | stays a query — F4#15, never a mutation |

### Structural rules

1. **One owner per resource.** Reads go through the owning area/entity options
   factory; no inline key+fn in components.
2. **Writes declare effects, not mechanics.** Name events or exact keys; the
   manager resolves them.
3. **Optimistic updates only with rollback.** Song writes patch rows, then
   invalidate. No new optimistic write without an `onError` restore.
4. **SSE and mutations share one path.** `bridgeEvents` maps to the same
   invalidation surface, so server-side and local changes cannot drift.
5. **Errors have one notifier** (the interceptor); success is contextual.
6. **One job-follow loop.** Workflow SSE goes through `followWorkflowJob`
   (`queries/workflowFollow.ts`): abort plumbing, auth-epoch guard and coalesced
   invalidation live there. Areas pass extra keys; none copies the loop.

### Hook placement

The default is **factory in the component**: an area exports an options factory
and the component calls `useQuery(factory(...))`. Named hooks are optional —
they exist when the query lifecycle or derived state is shared, or when the hook
owns non-query work (SSE slot, `setQueryData` bookkeeping).

| Location | Contents |
|---|---|
| `queries/<area>/` | Key composer, options factories, and shared hooks (`useRunJob`, `useJobSelection`, `useReferenceTracks`, `useVram`). Hooks that own a `queryKey` or a mutation lifecycle live here |
| `hooks/` | Generic React hooks, or cross-area wrappers that delegate to a factory (`usePluginRegistry`, `useCapabilities`, `useStreamAudio`). No inline keys |
| `components/**/useX.ts` | Single-consumer wrappers over an area factory (`useModelRegistry`, `useYue2Status`, `useDownloadStream`'s SSE slot). Move to `queries/<area>/` when a second consumer appears |
| `queries/writes.ts` | Cross-area write helpers (`writeAndInvalidate`, `useUpload`) |
| `queries/invalidation.ts` | The global `queryManager` — all invalidation |

Components never build a key or `queryFn` inline; they either call a factory or
consume one of these hooks.

### P3 decisions

1. **Hook extraction threshold:** a named hook only when its lifecycle state is
   reused or the component would hold more than one concern; single-use
   commands stay inline as one `useMutation`.
2. **No success toast** where an inline result line or state change is the
   feedback; `toast.success` only where nothing else tells the user it worked.
3. **Single-use API wrappers** are inlined into the mutation body rather than
   broken out as one-call functions.
4. **Bare handlers in JSX** (`onClick={fn}`); per-invocation side effects may
   use the `mutate(vars, { onSuccess })` form when they depend on the call's
   arguments (seed refresh, reference selection).

## Open work

### Consistency follow-up (closed 2026-10-24)

P3's exit criteria passed, but a broader consistency pass found older studios
still using the pre-P3 shape: manual `await service(...)` handlers with
`try/catch` and local success toasts instead of `useMutation`. P3.1 converted
those that are ordinary CRUD commands. Pending state now derives from
`isPending`, and each converted site keeps its existing notifier (the
interceptor, or an inline line where the sheet owns the message).

| Area | Writes | Outcome |
|---|---|---|
| `lyric-studio/LyricStudioV2.tsx` | artist/album CRUD, image refresh/set, song remove/edit/add, lyrics fetch (12) | **Converted.** Fetch progress derives from the mutation's `variables`, so the label always names the request in flight |
| `lyric-studio/PromptEditor.tsx`, `PresetSettingsModal.tsx` | prompt save/reset, preset upsert/delete (4) | **Converted.** Prompt endpoints are `silent: true` because the sheet's own toast is the sole notifier |
| `lyric-studio/WrittenSongsTab.tsx`, `ProfilesTab.tsx`, `RecordingsTab.tsx` | generation delete + metadata patch, profile delete, recording delete (4) | **Converted** |
| `shared/UnifiedRecentSongs.tsx` | single-song delete (1) | **Converted** to the same pattern as `SongList` |
| `lyric-studio/QueuePanel.tsx` | batch submit, render submit, bulk preset loop (3) | **Stays imperative.** Job start/follow: `isPending` would stay true for the whole batch and the loop reports per-item progress |
| `cover-studio/CoverStudio.tsx` | analyze, caption, transcribe, score approve, render start, job cancels (14) | **Stays imperative.** Multi-step job orchestration guarded by request refs; cancels belong to the follow effect's cleanup, not a user command |
| `insta-gen/InstaGenPanel.tsx` | document update (1) | **Stays imperative.** Step inside the preview → edit → approve job flow |
| `repaint-studio/RepaintStudio.tsx`, `stem-builder/StemBuilder.tsx`, `model-manager/ModelManagerModal.tsx` | cancel calls inside job-follow effects (5) | **Stay plain calls.** Lifecycle cleanup, not user-facing commands |

**Rule going forward:** a write that starts or follows a long-lived job stays
imperative with its own request/progress state; a write that is a single
request and dirties cached resources goes through `useMutation`.

### P5 — `useEnvSettingsForm`

`SettingsPanel` still loads env + GPUs with `queryClient.query()` in a
callback and mirrors them into local state. The target hook observes
`envOptions()` via `useQuery`, seeds the draft only while clean (a refetch
while dirty updates `original`, so external edits surface as new diffs), and
saves through `queryManager.env.values`; `isPending` replaces `envLoading`.
Exit: draft-safety tests green and the SettingsPanel manifest row updated.

### P6 — remaining composer work

- `utils/yue2CaptionSource.ts` builds its key inline with `serverKey(...)`.
  Single caller; error is surfaced. Accept as util-local or move to a factory
  when the area next changes.
- F4#14/#15/#16 are documented sanctions, not code work: SSE cache slot,
  queryable POST, side-effect-only query subscriptions.

### P7 — deferred structural work

| Site | Issue | Needs |
|---|---|---|
| `training-studio/useTrainingStream.ts` + `trainingStore.ts` | SSE writes a second copy of the job resource that the query layer also owns | Owner design → `setQueryData`/invalidate (sseBridge style) |
| `stores/audioGenQueueStore.ts` | ~100 lines of executor state around reads already in the cache | Dynamic `refetchInterval` + separated executor |

### Residuals and sanctioned exceptions

- **Sidecar text reads** stay on raw fetch: `utils/wordLrcUtils.ts:57`,
  `utils/lrcUtils.ts:222`, `queries/shell-queue/lyrics.ts:32` (`.score.abc`).
  Text payloads, read through the shared sidecar keys, outside the JSON/upload
  transport.
- **XHR upload timeout** — closed: `httpClient.upload` now sets `xhr.timeout`
  to `SLOW_ROUTE_TIMEOUT_MS` and routes the timeout through the normal failure
  path.
- **Double-toast sweep** — closed by P3 plus the post-P3 audit.
- **Keep as-is:** media blobs (`StemMixer`, `useAbEngine`, `useStreamAudio`),
  blob downloads (`downloadTrack`, App `export-zip`), the App health probe,
  log streams (`useEventSource`), live-note and curated-profile SSE, and the
  download-progress bridge. All are stream/media transports, not JSON reads.
- **Storm stream POST** stays raw (`/generate/storm/stream` is a streaming
  body); its control/stop siblings go through the transport.

## Closed findings (F1–F5)

### P4 closure (2026-10-24)

The six raw storm control/stop POSTs moved to `apiClient(... { silent: true })`:
`storm/DriftPanel.tsx` (debounced pressure, pull-now, pull restore) and
`hooks/useStreamAudio.ts` (resume gate, stop, `sendControl`). They are
high-frequency commands where a dropped tick is replaced by the next one, so
they stay silent rather than toasting per failure. `/generate/storm/stream`
remains a raw fetch because it is a streaming body.

Other P4 conversions landed earlier: DriftPanel snapshot poll, `vstChainStore`
`openGuis` observer, `NewDatasetWizard` scan query. `CoverArtPromptModal`'s
preview was resolved in P3 as a one-shot form-seeding read (`apiClient.post` in
the open handler), not a `useQuery`.

| Finding | Resolution |
|---|---|
| **F1** — `fetchQuery` deprecated, 73 sites | Renamed to `queryClient.query()`; ESLint `no-restricted-syntax` rule added. Replacement is behavior-identical (`query()` builds the query, fetches only when stale, forces `retry: false`) |
| **F2** — writes had no mutation lifecycle | All component writes converted; store writes standardized on `writeAndInvalidate`; `runCommand` deleted in favour of `trainingWritePlan` |
| **F3** — reads/timers bypassing the cache | Upload blocks collapsed onto `useUpload`; polls moved to `refetchInterval`/`pollWhile`; post-process status is a query; preview/scan converted. P7 rows remain |
| **F4** — anti-pattern ledger | #1–#6, #8–#11, #13 closed. #7 closed (services call the shared factories). #12 key is util-local (error surfaced). #14/#15/#16 are documented sanctions |
| **F5** — no global HTTP error handling | Axios transport + one response interceptor; GET silent, `IGNORED_URL_PATTERNS`, silent escape, abort handling, status-mapped i18n copy |

### F4 references

| # | Site | Status |
|---|---|---|
| 12 | `utils/yue2CaptionSource.ts` | Error surfaced to caller; key remains util-local (one caller) |
| 14 | `components/model-manager/useDownloadStream.ts` | Sanctioned: disabled query as an SSE cache slot |
| 15 | `services/yue2CoverApi.ts` queryable POST | Sanctioned: idempotent, body in key; bounded key cardinality is a watch item |
| 16 | `BackendToggle.tsx`, `MonitorBar.tsx` | Sanctioned: side-effect-only subscriptions; lifetime tied to mount |

## Verification

```bash
cd ui && npx tsc -b
cd ui && ../server/node_modules/.bin/tsx --test "src/**/*.test.ts"
node tools/docs/check-docs.mjs
make dev   # manual: UI :3000, API :3001
```

Exit-criteria greps (from `ui/`):

```bash
grep -rn "fetchQuery" src --include="*.ts" --include="*.tsx" | grep -v "\.test\."          # empty
grep -rn "fetch(" src/services --include="*.ts"                                            # transport internals + SSE only
grep -rn "\.invalidateQueries(" src --include="*.ts" --include="*.tsx" | grep -v "\.test\." # queries/invalidation.ts only
grep -rn "new FormData(" src/services --include="*.ts"                                     # httpClient.upload only
grep -rn "queryKey:" src/components --include="*.tsx" | grep -v "Options()"                # only the F4#14 SSE slot
```

Expected UI suite: 372 pass, 2 pre-existing `.css` import failures, 1 skip.

## Cross-references

- [ui-server-state.md](ui-server-state.md) — policy contract and consumer
  manifest.
- [ui/src/queries/README.md](../../ui/src/queries/README.md) — layer map and
  per-area manifests.
- [architecture.md — UI server-state integration audit](architecture.md#ui-server-state-integration-audit)
  — per-path dispositions; P4 adds the DriftPanel row.
- [config.md](config.md) — env keys edited by the settings form, with defaults
  and restart-required flags.
