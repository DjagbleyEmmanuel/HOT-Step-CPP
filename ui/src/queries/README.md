# TanStack Query — layer map and integration audit

Audited **2026-10-23** against `ui/src`, with `@tanstack/react-query` `^5.104.3`.
This README describes the server-state layer in `queries/`, records where the
app actually uses TanStack Query, and lists the places where the integration is
still incomplete or inconsistent. [Section 7](#7-remediation-status-2026-10-23)
records the first fix pass; the findings in section 4 keep their original
evidence and carry a status line.

It complements, and does not replace:

- [`docs/dev/tanstack-query.md`](../../../docs/dev/tanstack-query.md) — the
  migration worklist and the phase history (P1–P7).
- [`docs/dev/ui-server-state.md`](../../../docs/dev/ui-server-state.md) — the
  policy contract: what is server state, what is client state, and who owns
  each resource.
- `queries/<area>/README.md` — per-area resource manifests.

---

## 1. Where TanStack Query is used

### Foundation

| File | Role |
|---|---|
| `client.ts` | The one HMR-stable `QueryClient`. `staleTime` 30 s, `gcTime` 5 min, window-focus refetch off, reconnect refetch on, retry ≤ 2 for network/5xx, mutation retry off. Mounted once in `main.tsx` above `AuthProvider`. |
| `contract.ts` | Project policy: retry predicate, abort detection, `pollWhile()` (1.5 s active, doubling to 30 s while failing). |
| `keys.ts` | Five-slot key schema `['hs', resource, scope, id, filters]`, `serverKey`/`resourceKey`/`scopeOf`, the auth session epoch (`startAuthSession`), shared-resource keys, `SONG_VIEWS`. |
| `invalidation.ts` | The **only** file in the app that calls `invalidateQueries`. Exposes `queryManager` groups, an event map, and `invalidateEvents`. |
| `writes.ts` | `writeAndInvalidate(client, fn, plan)` for non-React stores, and `useUpload()` — the shared upload mutation. |
| `sseBridge.ts` | Maps SSE frames to coalesced invalidations, validated in-place `setQueryData` updates, and a `once` ledger. |
| `client.ts` + `keys.ts` + `AuthContext.tsx` | Session epoch changes drop every auth-scoped query of the previous token. |
| `wait.ts` | `waitForSnapshot(key, read, active)` / `waitForQuery(options, active)` — the one non-React waiter: attaches a `QueryObserver` to canonical keys, polls with `pollWhile`, guards the auth epoch and suppresses duplicate deliveries (unless `deliverRepeats` opts back in for per-tick cancellation checks). Re-exported by the studio/service import paths. |
| `workflowFollow.ts` | `followWorkflowJob(id, handlers, opts, extraKeys)` — the one job-follow implementation: abort plumbing, auth-epoch guard, 50 ms coalesced invalidation of the job replay, its document, and every song view; areas add their own extra keys. |

### Resource slices

`queries/` is split into area folders, each holding options factories, read
helpers and (occasionally) hooks:

| Area | Covers |
|---|---|
| `shell-queue/` | App shell, library, songs, queue, settings, lyrics sidecars, preferences, file browse |
| `global-models/` | Models, adapters, plugins, VRAM, backends, capabilities, presets |
| `studios/` | Extraction, separation, workflow, song-builder, inspire/assistant, MIDI |
| `cover-lyrics/` | Lyric Studio (lireek), cover workflows, sidecar snapshots |
| `training-data/` | Datasets, samples, preparation, training reads |
| `training-runs/` | Jobs, review, scores, ladder, workers, status polls, run SSE |

### Actual usage (non-test, current)

| API | Calls / files | Notes |
|---|---|---|
| `useQuery` | **118** calls in **78** files | The established read mechanism. Most declare `{ ...factoryOptions(), enabled }` inline in components. |
| `useQueries` | **3** | `CuratedProfileModal`, `WorkersPanel`, `TrainingWorkerBar`. |
| `useMutation` | **108** calls in **42** files | Writes with a visible pending/error lifecycle. |
| `queryClient.query(...)` | **66** | Imperative one-shot reads / form seeding / store and service reads. No `fetchQuery` remains (ESLint guard in `ui/eslint.config.js`). |
| `useQueryClient()` | **45** files | Mostly to call `queryManager` invalidation helpers. |
| `setQueryData` | **18** | In-place patches and SSE updates. |
| `invalidateQueries` | **1 call site** | `queries/invalidation.ts` only; other grep hits are comments. |
| `queryOptions(...)` | **~90** | Area slices plus the generic `localOptions`/`snapshotOptions` helpers. |
| Query-layer tests | **13** files | Keys, contract, SSE bridge, each area, training hooks. |

---

## 2. Scorecard

| Area | Verdict | Summary |
|---|---|---|
| Client & global policy | **Good** | One client, HMR-safe, sensible retry/GC, mutations never retried. |
| Query keys | **Good** | Canonical five-slot schema; session epoch prevents cross-login leakage. |
| Invalidation ownership | **Good** | One `invalidateQueries` call site; `queryManager` groups + events. |
| `useQuery` reads | **Mostly good** | Factory-first, auth-aware, `pollWhile` for jobs. Residual inline keys and imperative reads. |
| `useMutation` writes | **Good** | Broad adoption; the audited missing invalidations (4.4) are fixed. Writes owned by `compareStore` remain outside Query (4.13). |
| Polling | **Good** | Network polling is Query-owned (`pollWhile`/`refetchInterval`) or goes through `waitFor*`; the only raw network intervals left are the sanctioned health probe and the queue projection's executor cadence. |
| Error surfacing | **Mixed** | Transport owns toast notification, but many reads never render a failure state. |
| SSE integration | **Good** | Coalesced invalidation, replay-safe `once`, scoped teardown. |
| Non-React stores | **Mixed** | `writeAndInvalidate` used widely; `compareStore` is a server-state island. |

---

## 3. What is already working well

1. **Single client, single policy.** `queries/client.ts` and `contract.ts` mean
   every consumer inherits the same stale/retry/GC behaviour; tests can build
   isolated clients.
2. **The key schema is real.** Scope, id and normalised filters are part of
   cache identity; filters are sorted and empty values dropped, so equivalent
   requests share entries.
3. **Auth is handled at the cache layer.** `startAuthSession()` cancels and
   removes the old epoch’s queries instead of hoping components unmount.
4. **Invalidation is centralised.** `queryManager` is the only caller of
   `invalidateQueries`; writes take a required plan and cannot silently forget
   to invalidate (`queries/writes.ts:34`).
5. **Polling has one policy.** `pollWhile()` gives terminal stop plus error
   backoff; query-owned refetch intervals and `waitFor*` all share it where
   backoff matters, and fixed cadences are recorded as exceptions.
6. **SSE does not become a second fetch owner.** `bridgeEvents` invalidates or
   patches the same cache entries components read.
7. **Uploads are one mutation.** `useUpload` adds progress, abort and the
   transport’s failure path in one place.

---

## 4. Findings and improvement areas

Severity: **P0** = can show wrong data / lose a write; **P1** = drift or
duplication that will cause bugs; **P2** = consistency/ergonomics.

File:line references describe the code **as audited**; each finding ends with a
**Status** line saying whether it landed in the first remediation pass.
Section 7 summarises that pass.

### P0 — correctness

#### 4.1 Invalidate-then-bypass-cache in `getCachedProviders`

`components/lyric-studio/ProviderSelector.tsx:24-26`

```ts
if (forceRefresh) await queryManager.invalidate(queryClient, snapshotOptions('lireek', '/lireek/providers').queryKey);
return (await lireekApi.getProviders()).filter(p => p.available);
```

The invalidation marks the entry stale, then the fresh result is returned
directly and **never written to the cache it just invalidated**. Observers
(`ProviderSelector.tsx:133`, `:237`) can therefore re-fetch separately, and the
two callers can disagree about which result is current.

**Improvement:** return the query’s data — `queryClient.query({ ...providersOptions(), staleTime: 0 })`
— so the refresh fills the cache every observer reads.

**Status:** fixed — `providersOptions()` is exported and both this helper and
the two observers read through `queryClient.query(...)`.

#### 4.2 Positional key surgery in `Yue2Build`

`components/cover-studio/Yue2Build.tsx:194`

```ts
queryClient.setQueryData([key[0], key[1], options.queryKey[2], key[3], key[4]], next);
```

The session id changed, so the new snapshot is grafted into a tuple by
position. Any change to the five-slot schema silently corrupts the write and
the session’s cache entry.

**Improvement:** add a `keys.ts` helper such as
`sameScope(key, newId)` / a `yue2BuildOptions` composer that takes the scope
explicitly. No component should index a key tuple.

**Status:** fixed — `withKeyId(key, id)` in `keys.ts` rebuilds the five slots;
`Yue2Build` re-points at the new session's pathname id (`/yue2-cover/build/<id>`), which is the slot `snapshotOptions` fills — not the bare id.

#### 4.3 Raw delete lifecycle in `RecentExtractions`

`components/stem-studio/RecentExtractions.tsx:40-51`

The delete handler is an imperative `async` function that manually cancels,
deletes, `setQueryData`s, removes the result query, invalidates — and reports
failure only with `console.error`. It is the remaining extraction write that
has no `useMutation` lifecycle, and its invalidation sequence is not reusable.

**Improvement:** wrap in `useMutation` (or a named `useDeleteExtraction` in
`queries/studios/`), keep the cancel/remove/invalidate follow-up in the
mutation’s success path, and surface the failure inline. This also removes the
`refreshTrigger` coupling in 4.7.

**Status:** fixed — delete is a `useMutation` with cancel/patch/remove/
invalidate and an inline error row; the `refreshTrigger` prop is gone.

#### 4.4 Mutations that dirty cached data but invalidate nothing

| Site | Write | Missing follow-up |
|---|---|---|
| `components/settings/AdapterReferencesAction.tsx:7` | `lireekApi.updateAdapterReferences()` rewrites lyrics-set preset references | No invalidation of `cover-lyrics/lireek` snapshots or lyrics-set detail |
| `components/shared/AudioQueueMigrationBanner.tsx:28-35` | Retry/rollback of queue ownership | No invalidation of `audioQueueItemsOptions()` / song views |
| `components/details/Yue2CoverDrift.tsx:42-50` | Drift measurement | Persisted result lives in module state; if the server stores it on the song, song views should be invalidated |
| `hooks/useCoverArtGeneration.ts:33-52` | Starts cover generation | The component owns the follow-up poll; ensure the completed job invalidates the song/cover-art views |

These are not all bugs — some writes deliberately invalidate at the follow-up
site — but the list should be closed or documented as sanctioned exceptions.

**Status:** fixed for `AdapterReferencesAction` (invalidates
`queryManager.coverLyrics.lireek`) and the queue migration banner (invalidates
`audioQueueItemsOptions()` from `onSettled`). `Yue2CoverDrift` keeps its result
in module state only; `useCoverArtGeneration`’s follow dispatches
`cover-art-updated`, which the shell handles with `patchSong`. Both are
sanctioned.

#### 4.5 Hand-rolled polling loops that bypass Query

| Site | Pattern |
|---|---|
| `App.tsx:396-419` | Raw `fetch('/api/songs/:id/extract-kick')`, then a `for (0..360)` loop of `setTimeout(5000)` + `queryClient.query({ ...songOptions(id), staleTime: 0 })`, errors swallowed |
| `components/storm/DriftPanel.tsx:309-317` | `setInterval(poll, 2000)` while playing, results into `useState`, errors swallowed |
| `stores/vstChainStore.ts:216-222` | Module-level `setInterval` polling `vstApi.openGuis()`, self-clearing |
| `stores/audioGenQueueStore.ts:685-689` | Module-level `setInterval` driving the queue's server projection; reads go through Query and idle backoff, but cadence is local |
| `App.tsx:161-173` | Health probe poll (sanctioned liveness transport) |

The disco loop duplicates retry, timeout and cache policy by hand and never
invalidates song views when it completes. The VST loop lives in a store, so it
cannot use hooks; it can use `QueryObserver` instead of a second cache.

**Improvement:** express the disco extraction as a `useQuery` keyed on
`songOptions(id)` with `refetchInterval: pollWhile(s => !s.disco_data_url)`,
or as a `waitForSnapshot` call; invalidate `queryManager.songs.views()` on
completion. Move the VST GUI poll onto a `QueryObserver` with an
`openGuisOptions()` factory.

**Status:** fixed — disco now waits with `waitForQuery(songOptions(id), …)`
(5 s cadence, 30 min cap, abortable) and invalidates song views when it
completes; Directed Drift reads `stormDriftOptions()` with `refetchInterval`
while playing; the VST store polls `openGuisOptions()` through a `QueryObserver`
that unsubscribes when no editor remains. The `/api/health` probe stays
sanctioned, and the queue projection keeps its executor cadence while every
read still goes through Query (see 5).

#### 4.6 Two divergent `waitForSnapshot` implementations

`queries/studios/wait.ts:7` and `queries/cover-lyrics/wait.ts:8` are
near-copies with complementary gaps. The cover version adds the auth-epoch
guard but calls `onData` on every tick; the studios version suppresses repeated
data with `last` but has no guard. So auth-scoped imperative waits through
`studios/wait.ts` can resolve across a session change, and the cover workflows
depend on per-tick `onData` for cancellation.

**Improvement:** keep one implementation with both the guard and duplicate
suppression, and let the cover workflows opt back into per-tick delivery;
delete the other copy.

**Status:** fixed — `queries/wait.ts` owns `waitForSnapshot` (auth epoch guard
and duplicate-data suppression, with `deliverRepeats` for cancellation
callbacks); `studios/wait.ts` and `cover-lyrics/wait.ts` re-export it.
`waitForQuery(options, …)` wraps an options factory.

### P1 — drift and duplication

#### 4.7 Refetch-via-prop-bump

`components/stem-studio/RecentExtractions.tsx:14,37` and
`components/stem-builder/RecentBuilds.tsx:27,83` accept a numeric
`refreshTrigger` prop and invalidate in a child `useEffect`. The parent already
has the mutation/client; the bump is an indirect way to ask for a refetch.

**Improvement:** invalidate in the mutation that caused the change (or call the
shared delete mutation), and delete the prop.

**Status:** fixed — `StemStudio` invalidates `extractionsOptions()` when an
extraction finishes; `StemBuilder` invalidates `songsOptions()` at each build
completion and on `completionCounter`. `RecentBuilds` and `RecentExtractions` no
longer accept the prop; the unused `RecentCovers` prop was removed too.

#### 4.8 `enabled: false` observer plus imperative scan

`components/global-bar/AdaptersDropdown.tsx:58,127-129`

```ts
const { data: scan } = useQuery({ ...adapterScanOptions(scanFolder), enabled: false });
...
await queryManager.invalidate(client, key);
const result = await client.query(adapterScanOptions(dir));
```

The disabled observer subscribes to a cache entry that only the imperative
call fills; invalidate then query is a redundant two-step that races the
refetch triggered by invalidation.

**Improvement:** make the scan a mutation (`useMutation` over
`adapterApi.scan`) that writes the result with `setQueryData` / invalidates, and
have the observer read it. This also gives the scan a proper pending/error
state instead of the local `scanning`/`scanError` pair.

**Status:** fixed — the panel runs `useMutation({ mutationFn: adapterApi.scan })`
and reads `scanMut.data`; pending/error come from the mutation. This panel is
the sole consumer of adapter scanning, so its result stays in mutation state
rather than a cache entry.

#### 4.9 Inline key + queryFn duplicates

| Site | Duplicates |
|---|---|
| `components/lyric-studio/RecordingsTab.tsx:123` | `generationStatusOptions(jobId)` — and its `retry: false` |
| `components/insta-gen/InstaGenPanel.tsx:212` | `songOptions(id)` / `readSong` |
| `components/lyric-studio/QueuePanel.tsx:183-186` | A third LM-adapter read (next to `trainingQueries.lmAdapters` and `AdaptersDropdown`’s local options) |
| `components/stem-studio/SourceSelector.tsx:49-50` | A second `recent-songs` resource (`studios/recent-songs`) with its own filter shape |
| `services/stemStudioApi.ts:176`, `services/supersepApi.ts:119` | Rebuild progress keys/fns instead of using `extractProgressOptions` / `separationProgressOptions` |
| `utils/yue2CaptionSource.ts:226-241` | Its own key and a blanket `catch` that turns every failure into “no caption source” |

Each duplicate bypasses the factory’s `retry`, `staleTime` and invalidation
contract. **Improvement:** call the owning factory; if a filter or endpoint
differs, add it to the factory rather than forking the resource.

**Status:** fixed for the first four rows — `RecordingsTab` uses
`generationStatusOptions(id, { signal })`, `InstaGenPanel` uses `readSong`,
`QueuePanel` uses `lmAdaptersOptions(folder)` (folder from the params store),
and `SourceSelector` uses `studioRecentSongsOptions(source)`. The two services
still rebuild progress keys because the factories would import those services
back (cycle); `yue2CaptionSource` remains a deliberate one-shot helper.

#### 4.10 `localOptions` used directly in components

`localOptions(name, path)` is a useful escape hatch, but it declares eight
resources on the spot across six components:

- `SeedManagerDrawer.tsx:53` (`seeds`)
- `CoverArtDropdown.tsx:62` (`cover-art`)
- `ProfilesModal.tsx:35` (`profiles`)
- `VstChainDropdown.tsx:43` (`vst-scan`)
- `PostProcessingDropdown.tsx:294-302` (`pp-vae`, `stablestep`, `sa3-adapters`)
- `Mm3LmAdapterDropdown.tsx:93` (`mm3-adapters`)

These are effectively inline keys with a nicer spelling. `vst-scan` is
already duplicated elsewhere.

**Improvement:** move each to an area factory (e.g. `global-models/options.ts`)
so the endpoint, key, stale policy and invalidation are declared once. Keep
`localOptions` for genuinely ad-hoc internal reads only.

**Status:** fixed — every row now goes through an area factory:
`lmAdaptersOptions`, `vstScanOptions`, `ppVaeOptions`, `stableStepOptions`,
`stableStepAdaptersOptions`, `mm3AdaptersOptions` in `global-models/options.ts`;
`seedsOptions`, `coverArtStatusOptions` in `shell-queue/queue.ts`;
`profilesOptions` in `shell-queue/settings.ts`. The three components that still
declared `localOptions` inline (`SeedManagerDrawer`, `CoverArtDropdown`,
`ProfilesModal`) now import those factories, and their duplicate local response
types were replaced by the exported ones. `localOptions` remains a building
block inside `global-models/options.ts`.

#### 4.11 Duplicate `adapterScanOptions`

Defined identically in `queries/global-models/options.ts:11` and
`queries/shell-queue/settings.ts:44`; consumers import from both
(`AdaptersDropdown` vs `AdaptersAccordion`). Two owners for one resource means
future `staleTime`/invalidation changes can diverge.

**Improvement:** pick one owner (adapter scanning is a global-models concern)
and re-export or re-point the other.

**Status:** fixed — `shell-queue/settings.ts` re-exports
`adapterScanOptions` from `global-models/options.ts`.

#### 4.12 Reads with no failure state

26 components use `useQuery` but never read `error`/`isError` (at audit time).
Because GET errors are deliberately silent in the axios interceptor, a failed
read is invisible: the component just renders its empty/default state. Examples:

`BackendModelsDropdown`, `ModelsDropdown`, `GlobalParamBar`,
`Yue2LmAdapterDropdown`, `CoverArtDropdown`, `MidiPlayer`,
`RenderAcrossModal`.

**Improvement:** distinguish “empty” from “failed”. Either render a small
inline error row (`query.isError`) or add a shared read-error component. This
is the largest UX gap in the current integration.

**Status:** still open — the largest remaining UX gap; tracked as §7 priority #1.

#### 4.13 `compareStore` is a server-state island

`stores/compareStore.ts:98-210` performs its own list/detail/diff/analysis
loading, dedupes analysis requests in a module `Map`, tracks `loading`
manually, and applies optimistic score updates by hand. Nothing goes through
Query, so compare-studio gets none of the stale/retry/GC/invalidation policy
and cannot be refreshed by `queryManager`.

**Improvement:** treat Compare sessions as another resource slice
(`queries/compare/`): `useQuery` for lists/details/diffs, `useMutation` for
add/remove/scores/archive, and keep only selection/UI state in the store. This
is the largest remaining migration if the contract is meant to be app-wide.

**Status:** still open — the largest remaining migration; tracked as §7 priority #2.

### P2 — consistency and ergonomics

1. **Raw command fetches bypass the transport.** **Fixed.** The six storm
   control/stop POSTs (`DriftPanel.tsx`, `useStreamAudio.ts`) and the disco
   extraction POSTs (`App.tsx`) now go through `apiClient`; the storm control
   calls pass `silent: true` because a dropped tick is replaced by the next one.
   The `/generate/storm/stream` POST stays raw (streaming body), as do file
   export and shutdown.
2. **Queryable POST cardinality.** `services/yue2CoverApi.ts:199-203` puts the
   whole request body in the query key. The pattern is documented and valid,
   but every distinct body creates a cache entry; bound the `filters` to stable
   fields if the vocabulary grows.
3. **Literal `refetchInterval`.** `TrainingWorkerBar.tsx:43` uses a hand-written
   `3000 : 15000` function. If its failures should back off, pass a `pollWhile`
   variant with a custom idle cadence; otherwise record it as a sanctioned fixed
   cadence in section 5.
4. **`staleTime: 0` is common (41 sites).** Many are intentional one-shot
   reads; others effectively make Query a request-deduplicator. Document the
   intentional set in the area READMEs so a future reviewer does not “fix” them.
5. **Hook-placement convention.** **Resolved.** The sanctioned default is
   factory-in-component: `useQuery(factory(...))`, with the factory (key and
   fetcher) owned by an area. Named hooks are extracted only when the lifecycle
   is shared (`useRunJob`, `useJobSelection`, `useReferenceTracks`) or the hook
   owns non-query work (`useDownloadStream`, `useCaptionFile`). Generic and
   single-consumer wrappers may live in `hooks/` or next to their component as
   long as they delegate to a factory.
6. **No Devtools.** `@tanstack/react-query-devtools` is not installed. Add it
   as a dev-only dependency if cache/staleness debugging becomes routine.
7. **`useQuery({ enabled: false })` as a cache slot** is intentional in
   `useDownloadStream.ts:16-19` (SSE fills it). Keep, but record it in
   `ui-server-state.md` alongside the other sanctioned exceptions.

---

## 5. Sanctioned exceptions (do not “fix” these without the doc changing)

| Exception | Why it stays |
|---|---|
| SSE streams (`sharedEventSource.ts`, `useEventSource.ts`, `bridgeEvents`) | Axios cannot stream response bodies; the bridge writes the same cache entries. |
| Media blobs and peak files (`StemMixer.tsx:125`, `useAbEngine.ts:316`, `useStreamAudio.ts:121`, `audio/peaksClient.ts`) | Binary playback, not JSON server state. |
| `/api/health` probes (`App.tsx:161-173`, `:465`) | Liveness transport used to reload the page; should not pollute the cache. |
| Sidecar text reads (`utils/lrcUtils.ts:222`, `utils/wordLrcUtils.ts:57`) | Text payloads outside the JSON transport, keyed through `sharedKeys`. |
| Queryable POST (`yue2CoverApi.ts:199`) | Read-only, idempotent, body in key; documented in `tanstack-query.md` F4#15. Adapter scans are a mutation instead. |
| `useDownloadStream` disabled observer | Deliberate SSE cache slot. |
| `waitForSnapshot` / `waitForQuery` (`QueryObserver` outside React) | Services and stores cannot use hooks; the observer reuses the same cache and polling policy. |
| Fixed-cadence `refetchInterval` (Directed Drift 2 s, VST GUI 1.5 s) | A dropped tick is replaced by the next one, so `pollWhile`’s error backoff adds latency without value. |
| Queue server projection (`audioGenQueueStore.ts`) | The executor owns its 1.5 s / idle-skip cadence, but every read still goes through the Query cache. |

---

## 6. Conventions for new work

1. **Reads:** declare an options factory in the owning area; consume it with
   `useQuery({ ...options, enabled })`. Never hand-build a key or `queryFn` in
   a component.
2. **Writes in React:** one `useMutation` per command, with `onSuccess`
   invalidation through `queryManager`. Use `silent: true` only when the
   component owns the error display.
3. **Writes outside React:** `writeAndInvalidate(client, fn, plan)`; the plan
   is mandatory.
4. **Invalidation:** never call `invalidateQueries` outside
   `queries/invalidation.ts`. Add a `queryManager` group or event if none
   exists.
5. **Polling:** network polling belongs to Query (`refetchInterval` /
   `pollWhile`) or to `waitForSnapshot`/`waitForQuery`. Do not add a
   `setInterval` that fetches. Use `pollWhile` when failures should back off;
   a fixed cadence is acceptable only when a missed tick is worthless (record
   it in section 5).
6. **Errors:** reads render their own inline failure state; commands are
   notified by the transport interceptor exactly once.
7. **Keys:** if a write must move an entry to a new id/scope, add a composer
   helper in `keys.ts`; never splice a tuple by index.
8. **Optimistic updates:** snapshot in `onMutate`, restore in `onError`; today
   only SongBuilder’s section ops need this.

---

## 7. Remediation status (2026-10-23; updated 2026-10-24)

Landed in the first fix pass:

| Finding | Change |
|---|---|
| 4.1 | `providersOptions()`; `getCachedProviders` reads/writes the shared cache entry instead of invalidating and bypassing it. |
| 4.2 | `withKeyId()` in `keys.ts`; `Yue2Build` re-points at the new session's pathname id instead of indexing a key tuple. |
| 4.3 | `RecentExtractions` delete is a `useMutation` with an inline error row. |
| 4.4 | Adapter-reference update and queue migration/rollback invalidate their reads. |
| 4.5 | Disco wait → `waitForQuery`; storm drift → `stormDriftOptions`; VST GUI poll → `QueryObserver` over `openGuisOptions()`. |
| 4.6 | One `waitForSnapshot` in `queries/wait.ts`; area files re-export it. `waitForQuery` added. |
| 4.7 | `refreshTrigger` removed from `RecentExtractions`/`RecentBuilds`/`RecentCovers`; parents invalidate at the completion site. |
| 4.8 | Adapter folder scan is a `useMutation`. |
| 4.9 | First four duplicates moved onto the owning factories (services/`yue2CaptionSource` noted above). |
| 4.10 | All component `localOptions` declarations moved to area factories; duplicate response types replaced by exported ones. |
| 4.11 | One `adapterScanOptions` owner. |
| 4.6 (follow-up) | `followWorkflowJob` in `queries/workflowFollow.ts` replaces the two divergent studio/cover job-follow copies. |

Still open, in rough priority order:

1. **4.12** — reads with no failure state (largest UX gap).
2. **4.13** — `compareStore` migration into a `queries/compare/` slice.
3. **4.9 remainder** — `stemStudioApi`/`supersepApi` progress keys and
   `yue2CaptionSource` (both noted in 4.9).
4. **P2#2–#4, #6–#7** — queryable-POST cardinality, fixed idle cadence,
   documenting intentional `staleTime: 0`, Devtools, and the disabled-observer
   note.

The usage counts in section 1 were re-measured after this pass; section 8 lists
the commands used.

Validation for this pass: `npx tsc -b` clean; the UI suite runs 366 pass / 2
fail / 1 skip, where both failures are pre-existing `ERR_UNKNOWN_FILE_EXTENSION
".css"` loader errors in `Yue2AitkTrainCard.test.ts` and
`Yue2LadderReview.test.ts`; ESLint on the touched files reports only findings in
rule categories already present in the baseline (`react-refresh/only-export-
components`, `@typescript-eslint/no-explicit-any`, and React Compiler
memoization/set-state-in-effect reports). The newly added query modules and
`wait.ts` are lint-clean.

---

## 8. How this audit was produced

All counts are non-test files under `ui/src`, taken with ripgrep:

```sh
# read/write surface
rg -n "useQuery\("            ui/src --glob '!*.test.*' | wc -l
rg -n "useMutation\("         ui/src --glob '!*.test.*' | wc -l
rg -n "\.query\("             ui/src --glob '!*.test.*'
rg -n "useQueryClient\("      ui/src --glob '!*.test.*'

# invalidation ownership
rg -n "invalidateQueries"     ui/src --glob '!*.test.*'

# bypasses
rg -n "fetch\("               ui/src --glob '!*.test.*'
rg -n "setInterval"           ui/src --glob '!*.test.*'
rg -n "queryFn:"              ui/src --glob '!*.test.*'
```

The next audit should re-run these and diff the result against sections 4 and
5, rather than treating this file as permanently true.
