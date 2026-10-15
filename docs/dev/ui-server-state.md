# UI server state

TanStack Query owns every server snapshot the UI fetches: lists, details,
statuses, capabilities, job progress. Client state stays where it is: forms,
playback, drafts, generation params and workflow execution live in Zustand or
React context. Server-sent event streams stay as the push channel and drive
the cache through the bridge below. They never become a second fetch owner.

This page is the contract every area builds on. The code lives in
`ui/src/queries/` (`client.ts`, `contract.ts`, `keys.ts`, `sseBridge.ts`) and
the transports in `ui/src/services/` (`api.ts`, `trainingApi.ts`,
`httpClient.ts`, `sharedEventSource.ts`).

## The client

One `QueryClient`, exported as `queryClient` from `queries/client.ts`.
`main.tsx` mounts `QueryClientProvider` outside `AuthProvider` and `App`. The
client survives Vite HMR through `import.meta.hot.data`, so an edit never
builds a second cache with its own observers and polls. Tests build their own
with `createQueryClient()`. Devtools are not installed.

| Policy | Value |
|---|---|
| `staleTime` | 30 s |
| `gcTime` | 5 min |
| `refetchOnWindowFocus` | off |
| `refetchOnReconnect` | on |
| Query retry | at most 2, network errors and 5xx only (`retryQuery`) |
| Retry delay | 500 ms doubling, capped at 4 s (`retryDelay`) |
| Never retried | aborts, every 4xx |
| Mutation retry | off, always |

These are project choices, not library defaults. Override per resource only.
Active jobs and VRAM poll at `ACTIVE_POLL_MS` (1.5 s) through `pollWhile`:

```ts
refetchInterval: pollWhile<JobStatus>(job => job?.status === 'running'),
```

`pollWhile` stops for good once the predicate fails (terminal stop). A poll
cycle is one fetch plus its retries. While cycles keep failing, the interval
doubles per consecutive failed cycle (3 s, 6 s, 12 s, 24 s, then capped at
30 s), and the next success resets it to 1.5 s. Capability probes keep their
existing down manifest behaviour.

## Keys

Every key is a five-slot tuple built by `serverKey()`:

```
['hs', resource, scope, id, filters]
```

| Slot | Meaning |
|---|---|
| `resource` | a shared name (below) or `<area>/<name>` |
| `scope.api` | the API base of `apiClient`, `/api` today |
| `scope.session` | present only on keys whose request carries the bearer token |
| `scope.worker` | training target: a worker name, or `null` for this PC |
| `scope.backend` | generation engine, only where data differs by engine |
| `id` | one item, or `null` for a list or snapshot |
| `filters` | normalized query parameters, `{}` when none |

Shared local resources omit `worker` and `backend`. A key never holds a
credential: `session` is an opaque counter. `normalizeFilters` drops
`undefined` and `''` and sorts the keys, so equal requests share an entry.

Invalidate with `resourceKey(resource, scope?, id?)`. Matching is per slot, so
`resourceKey('training-data/datasets', { worker: 'A' })` hits every dataset
list on worker A and nothing on B or this PC.

### Capture the target in the key

A query function reads its target back from its own key with `scopeOf()`,
never from a mutable global. Whatever the selection does after scheduling, a
request goes where its cache entry says it went.

```ts
const datasetsQuery = (worker: string | null) => queryOptions({
  queryKey: serverKey('training-data/datasets', { worker }),
  queryFn: ({ queryKey, signal }) => listDatasets({ worker: scopeOf(queryKey)!.worker, signal }),
});
```

### Auth sessions

`AuthProvider` calls `startAuthSession(queryClient, token)` before the new
token reaches any consumer, and exposes the result as `sessionEpoch` on
`useAuth()`. A changed token bumps the epoch, cancels the old epoch's
in-flight auth-scoped queries and removes them. Public keys are untouched.
Build auth keys with `{ auth: true }` and read `sessionEpoch` from `useAuth()`
in the component, so it re-renders when the epoch moves.

### Shared resources

More than one area reads these. The contract is the key, the read and the
cached shape, not another area's hooks. Any area may query a shared resource
directly with its canonical key and canonical read below, so no Stage 2 slice
waits on another. Several observers on one key still share one request and
one cache entry.

The cached value is the canonical read's result, exactly. Reshape it with
`select` in the observer, never inside the `queryFn`: two `queryFn`s on one
key that return different shapes would overwrite each other. The owner is the
area that may change the read or the shape. It announces a change to every
consumer before making it, and adds invalidation for the events it handles.

| Key | Canonical read | Cached shape | Owner |
|---|---|---|---|
| `sharedKeys.songs()` | `songApi.list(token, { signal })` | `{ songs: Song[] }`, normalized | shell-queue |
| `sharedKeys.song(id)` | `songApi.get(id, { signal })` | `{ song: Song }`, normalized | shell-queue |
| `sharedKeys.plugins()` | `apiClient.get('/plugins', { signal })` | raw registry JSON | global-models |
| `sharedKeys.capabilities(backend)` | `apiClient.get('/capabilities?backend=<id>', { signal })` | raw JSON | global-models |
| `sharedKeys.vram()` | `apiClient.get('/logs/vram', { signal })` | raw JSON | global-models |
| `sharedKeys.loadedModels()` | `apiClient.get('/logs/models-loaded', { signal })` | raw `{ loaded }` | global-models |

The two song keys are auth-scoped: read `token` and `sessionEpoch` from
`useAuth()`, build the key in render, and keep the token in the `queryFn`
closure, never in the key. Polling cadence stays per observer
(`refetchInterval`), so a consumer that wants faster VRAM updates sets its own
interval without touching the owner's options.

Each area keeps its own options, hooks and event mappings in
`ui/src/queries/<area>/`, with resources named `<area>/<name>`. The areas are
`training-data`, `training-runs`, `global-models`, `cover-lyrics`, `studios`
and `shell-queue`.

## Transports

Every read in `api.ts` takes a trailing `opts?: ReadOptions` (`{ signal }`).
Positional callers are unchanged, songs are still normalized, and errors are
still `ApiError` with `status` and the server's message.

`trainingApi.ts` routes by target:

- Functions on the "Train on" base take a trailing `TrainingReadOptions`
  (`{ worker, signal }`) for reads or `TrainingTarget` (`{ worker }`) for
  mutations. `worker: undefined` keeps the current selection, `null` is this
  PC, a name is that worker.
- Local-only routes (run records, review, scores, cleanup, mirrored previews)
  keep their local target and take `ReadOptions` on reads.
- `/api/workers` reads take `ReadOptions`; the worker is already an argument.
- `jobStreamUrl`, `sampleAudioUrl` and `previewAudioUrl` take an optional
  `TrainingTarget`, so a stream or player opened for worker A stays on A.

Training errors are now `ApiError` too, with the same message as before, so
retry policy can tell a 404 from a 503. Other domain clients get signals in
their owning area's slice.

Reads throw on failure. Never catch an error into an empty result inside a
`queryFn`: an empty list in the cache looks like real data and stays for
`staleTime`.

## Mutations

- Capture the target when the mutation is created and pass it explicitly
  (`TrainingTarget`). Never read the selection inside `onSuccess`.
- No automatic retry. A submit happens once, when the user asks.
- On success, invalidate the related lists and details for the captured scope.
- Mutations take no signal. Cancelling a read aborts that read; it never
  cancels a server job. Stopping a job is its own explicit mutation.
- No generic get-or-submit query functions.
- Do not copy query data into unscoped Zustand state. A compatibility selector
  reads the cache by a captured key and never fetches on its own.

## Event streams

`bridgeEvents(queryClient, options)` subscribes through `sharedEventSource`,
one connection per URL per tab, next to the existing log, text and audio
reducers. The area maps each parsed event to effects:

| Effect | Behaviour |
|---|---|
| `invalidate` | keys to refetch; bursts coalesce to one invalidation per key per 50 ms |
| `update` | in-place edit, applied only when the entry exists and the updater returns a value |
| `once` | a side effect keyed by id, run at most once per client across replays and remounts |

`reconnectInvalidate` lists the authoritative snapshots to refetch after the
stream drops and reopens. The first open does nothing, because the server
replays its buffer on connect. The caller captures its scope when it starts
the bridge: the URL and every key `map` builds come from that capture. The
returned teardown unsubscribes and drops pending invalidations, and nothing
the old stream delivers afterwards touches the cache.

```ts
useEffect(() => bridgeEvents(queryClient, {
  url: jobStreamUrl(jobId, { worker }),
  reconnectInvalidate: [resourceKey('training-runs/jobs', { worker })],
  map: (e: JobEvent) => e.type === 'done'
    ? { invalidate: [resourceKey('training-runs/jobs', { worker })],
        once: { id: `${worker}:${jobId}:done`, run: notifyDone } }
    : undefined,
}), [jobId, worker]);
```

## Consumer manifest

Every non-test file under `ui/src` that imports a service module, calls
`fetch(` directly, opens a stream or runs an interval, at base `0ae4bf36`
plus this foundation. It was generated by scanning sources, so it counts
imports inside `services/` and type-only imports too. That is why it lists
more files than the 127 importers in the original inventory.

The list is append-only. A file added later gets a new row; a migrated file
keeps its row and its disposition changes. Areas report dispositions in their
slice hand-off, and the integration stage reconciles them here. Disposition
values: `open`, `query` (reads owned by Query), `transport`, `mutation`,
`stream` or `client` (a surviving call with its reason), `none` (nothing to
migrate).

Columns: services imported, raw `fetch(` calls, stream openers, intervals.

| File | Area | Services | fetch | SSE | Timers | Disposition |
|---|---|---|---|---|---|---|
| `App.tsx` | shell-queue | api, sharedEventSource | 7 | 1 | 2 | open |
| `audio/peaksClient.ts` | shell-queue | - | 1 | - | - | open |
| `components/assistant/AssistantPanel.tsx` | studios | assistantApi | - | - | - | open |
| `components/cover-studio/ArtistSettingsPanel.tsx` | cover-lyrics | lireekApi | - | - | - | open |
| `components/cover-studio/CoverArtistGrid.tsx` | cover-lyrics | lireekApi | - | - | - | open |
| `components/cover-studio/CoverRecentSongs.tsx` | cover-lyrics | api | 1 | - | - | open |
| `components/cover-studio/CoverStudio.tsx` | cover-lyrics | api, coverWorkflowApi, lireekApi, studioDraftMirror, supersepApi, workflowApi, yue2CoverApi | 5 | - | 2 | open |
| `components/cover-studio/RecentCovers.tsx` | cover-lyrics | api | 1 | - | - | open |
| `components/cover-studio/ScorePlanReview.tsx` | cover-lyrics | yue2CoverApi | - | - | - | open |
| `components/cover-studio/SectionMatchReview.tsx` | cover-lyrics | yue2CoverApi | - | - | - | open |
| `components/cover-studio/SourcePanel.tsx` | cover-lyrics | api, supersepApi | - | - | - | open |
| `components/cover-studio/Yue2Build.tsx` | cover-lyrics | yue2CoverApi | - | - | 1 | open |
| `components/cover-studio/Yue2CoverPanel.tsx` | cover-lyrics | lireekApi | - | - | - | open |
| `components/cover-studio/Yue2CoverScore.tsx` | cover-lyrics | yue2CoverApi | - | - | - | open |
| `components/create/AdaptersAccordion.tsx` | shell-queue | api | - | - | - | open |
| `components/create/AiGenerateModal.tsx` | shell-queue | inspireApi | - | - | - | open |
| `components/create/CreatePanel.tsx` | shell-queue | api, studioDraftMirror, trainingApi | - | - | - | open |
| `components/create/MasteringSection.tsx` | shell-queue | api | - | - | - | open |
| `components/create/Mm3ComposeButton.tsx` | shell-queue | lireekApi | - | - | - | open |
| `components/create/trainingCreateDraft.ts` | shell-queue | trainingOperations | - | - | - | open |
| `components/details/MetadataEditorModal.tsx` | shell-queue | api | 1 | - | - | open |
| `components/details/Yue2CoverDrift.tsx` | shell-queue | yue2CoverApi | - | - | - | open |
| `components/global-bar/AdaptersDropdown.tsx` | global-models | api | - | - | - | open |
| `components/global-bar/CoverArtDropdown.tsx` | global-models | - | 3 | - | 1 | open |
| `components/global-bar/GenerationDropdown.tsx` | global-models | api | - | - | - | open |
| `components/global-bar/GlobalParamBar.tsx` | global-models | api | - | - | - | open |
| `components/global-bar/MasteringDropdown.tsx` | global-models | api | - | - | - | open |
| `components/global-bar/Mm3LmAdapterDropdown.tsx` | global-models | - | 1 | - | - | open |
| `components/global-bar/ModelsDropdown.tsx` | global-models | api | - | - | - | open |
| `components/global-bar/MonitorBar.tsx` | global-models | - | - | - | 1 | open |
| `components/global-bar/PostProcessingDropdown.tsx` | global-models | api | 4 | - | - | open |
| `components/global-bar/ProfilesModal.tsx` | global-models | api, exportImportApi | - | - | - | open |
| `components/global-bar/SeedManagerDrawer.tsx` | global-models | - | 5 | - | - | open |
| `components/global-bar/Yue2LmAdapterDropdown.tsx` | global-models | - | 1 | - | - | open |
| `components/insta-gen/InspirePreview.tsx` | studios | inspireApi | - | - | - | open |
| `components/insta-gen/InstaGenPanel.tsx` | studios | api, inspireApi | - | - | - | open |
| `components/library/CoverArtPromptModal.tsx` | shell-queue | - | 3 | - | 1 | open |
| `components/library/ImportTracksModal.tsx` | shell-queue | exportImportApi | - | - | - | open |
| `components/lyric-studio/AlbumGrid.tsx` | cover-lyrics | lireekApi | - | - | - | open |
| `components/lyric-studio/AlbumHeader.tsx` | cover-lyrics | lireekApi | - | - | - | open |
| `components/lyric-studio/ArtistGrid.tsx` | cover-lyrics | lireekApi | - | - | - | open |
| `components/lyric-studio/ArtistPageSidebar.tsx` | cover-lyrics | lireekApi | - | - | - | open |
| `components/lyric-studio/ArtistSidebar.tsx` | cover-lyrics | lireekApi | - | - | - | open |
| `components/lyric-studio/CuratedProfileModal.tsx` | cover-lyrics | lireekApi | 1 | - | - | open |
| `components/lyric-studio/LyricStudioV2.tsx` | cover-lyrics | lireekApi | - | - | - | open |
| `components/lyric-studio/PresetSettingsModal.tsx` | cover-lyrics | lireekApi | - | - | - | open |
| `components/lyric-studio/ProfilesTab.tsx` | cover-lyrics | lireekApi, lyricWorkflowApi | - | - | - | open |
| `components/lyric-studio/PromptEditor.tsx` | cover-lyrics | lireekApi | - | - | - | open |
| `components/lyric-studio/ProviderSelector.tsx` | cover-lyrics | lireekApi | - | - | - | open |
| `components/lyric-studio/QueuePanel.tsx` | cover-lyrics | api, lireekApi, lyricWorkflowApi | - | - | - | open |
| `components/lyric-studio/RecordingsTab.tsx` | cover-lyrics | api, lireekApi | - | - | - | open |
| `components/lyric-studio/RenderAcrossModal.tsx` | cover-lyrics | lireekApi | - | - | - | open |
| `components/lyric-studio/SourceLyricsTab.tsx` | cover-lyrics | lireekApi | - | - | - | open |
| `components/lyric-studio/WrittenSongsTab.tsx` | cover-lyrics | lireekApi, lyricWorkflowApi | - | - | - | open |
| `components/lyric-studio/playlistStore.ts` | cover-lyrics | studioDraftsApi | - | - | - | open |
| `components/lyric-studio/useAudioGeneration.ts` | cover-lyrics | lireekApi | - | - | - | open |
| `components/midi-studio/MidiPlayer.tsx` | studios | midiStudioApi | - | 1 | 1 | open |
| `components/midi-studio/MidiStudio.tsx` | studios | api, midiStudioApi | 1 | - | 2 | open |
| `components/midi-studio/midiSynth.ts` | studios | - | - | - | 1 | open |
| `components/model-manager/ModelManagerModal.tsx` | global-models | api | - | - | - | open |
| `components/model-manager/useDownloadStream.ts` | global-models | api | - | 1 | - | open |
| `components/model-manager/useModelRegistry.ts` | global-models | api | - | - | - | open |
| `components/player/LyricsBar.tsx` | shell-queue | - | 1 | - | - | open |
| `components/player/SectionMarkers.tsx` | shell-queue | - | 1 | - | - | open |
| `components/player/TrimControls.tsx` | shell-queue | api | - | - | - | open |
| `components/repaint-studio/RepaintStudio.tsx` | studios | api, repaintLayerWorkflowApi, studioDraftMirror, workflowApi | 1 | - | - | open |
| `components/settings/DataFolderPanel.tsx` | shell-queue | dataFolderApi | 1 | - | - | open |
| `components/settings/SettingsPanel.tsx` | shell-queue | api, lireekApi, stemStudioApi | 2 | - | - | open |
| `components/shared/FileBrowserModal.tsx` | shell-queue | api | - | - | - | open |
| `components/shared/LatentImport.tsx` | shell-queue | - | 1 | - | - | open |
| `components/shared/PresetSyncNotices.tsx` | shell-queue | presetCollection | - | - | - | open |
| `components/shared/StemMixer.tsx` | shell-queue | - | 1 | - | - | open |
| `components/shared/StudioDraftPicker.tsx` | shell-queue | studioDraftMirror, studioDraftsApi | - | - | - | open |
| `components/shared/UnifiedRecentSongs.tsx` | shell-queue | api | - | - | - | open |
| `components/shared/VramIndicator.tsx` | global-models | - | 3 | - | 2 | open |
| `components/song-builder/SongBuilder.tsx` | studios | api, workflowApi | - | - | - | open |
| `components/song-builder/followSection.ts` | studios | workflowApi | - | - | - | open |
| `components/stem-builder/RecentBuilds.tsx` | studios | api | - | - | - | open |
| `components/stem-builder/StemBuilder.tsx` | studios | api, repaintLayerWorkflowApi, workflowApi | 1 | - | - | open |
| `components/stem-studio/RecentExtractions.tsx` | studios | stemStudioApi | - | - | - | open |
| `components/stem-studio/SourceSelector.tsx` | studios | - | 2 | - | - | open |
| `components/stem-studio/StemStudio.tsx` | studios | api, stemStudioApi, supersepApi | - | - | - | open |
| `components/stem-studio/TrackSelector.tsx` | studios | stemStudioApi, supersepApi | - | - | - | open |
| `components/storm/AiContinuePresetModal.tsx` | studios | preferencesApi, presetCollection, settingDocument | - | - | - | open |
| `components/storm/StormLiveControls.tsx` | studios | inspireApi | - | - | - | open |
| `components/storm/StormPage.tsx` | studios | - | 1 | - | - | open |
| `components/terminal/TerminalPanel.tsx` | global-models | - | 1 | 1 | 1 | open |
| `components/training-studio/AuditionCard.tsx` | training-data | trainingApi | - | - | - | open |
| `components/training-studio/AuditionPlayer.tsx` | training-data | trainingApi | - | - | - | open |
| `components/training-studio/BatchImportWizard.tsx` | training-data | api, trainingApi | - | - | - | open |
| `components/training-studio/BuildPanel.tsx` | training-data | trainingApi | - | - | - | open |
| `components/training-studio/DatasetAssetChips.tsx` | training-data | trainingApi | - | - | - | open |
| `components/training-studio/FolderPicker.tsx` | training-data | api | - | - | - | open |
| `components/training-studio/LabelPanel.tsx` | training-data | trainingApi | - | - | - | open |
| `components/training-studio/LmAdapterPicker.tsx` | training-data | api | - | - | - | open |
| `components/training-studio/Mm3RunsPanel.tsx` | training-runs | trainingApi | - | - | - | open |
| `components/training-studio/Mm3TrainCard.tsx` | training-runs | trainingApi, trainingRecipesApi | - | - | - | open |
| `components/training-studio/MonitorPanel.tsx` | training-runs | trainingApi | - | - | 1 | open |
| `components/training-studio/NewDatasetWizard.tsx` | training-data | trainingApi | - | - | - | open |
| `components/training-studio/PipelineStageProgress.tsx` | training-data | trainingApi | - | - | - | open |
| `components/training-studio/PreprocessOptionsForm.tsx` | training-data | trainingApi | - | - | - | open |
| `components/training-studio/PreprocessPanel.tsx` | training-data | trainingApi | - | - | - | open |
| `components/training-studio/PreprocessVariantCard.tsx` | training-data | trainingApi | - | - | - | open |
| `components/training-studio/RefinePanel.tsx` | training-runs | trainingApi, trainingReviewApi | - | - | 1 | open |
| `components/training-studio/ReviewPanel.tsx` | training-runs | stemStudioApi, trainingApi, trainingReviewApi | - | - | 3 | open |
| `components/training-studio/SampleDrawer.tsx` | training-data | trainingApi | - | - | - | open |
| `components/training-studio/SampleGrid.tsx` | training-data | trainingApi | - | - | - | open |
| `components/training-studio/SampleRow.tsx` | training-data | trainingApi | - | - | - | open |
| `components/training-studio/SendToLyricStudio.tsx` | training-data | trainingApi | - | - | - | open |
| `components/training-studio/TrainDitForm.tsx` | training-runs | trainingApi | - | - | - | open |
| `components/training-studio/TrainLmForm.tsx` | training-runs | trainingApi | - | - | - | open |
| `components/training-studio/TrainPanel.tsx` | training-runs | trainingApi, trainingRecipesApi | - | - | - | open |
| `components/training-studio/TrainingRunStats.tsx` | training-runs | - | - | - | 1 | open |
| `components/training-studio/TrainingWorkerBar.tsx` | training-data | trainingApi | - | - | 1 | open |
| `components/training-studio/WorkersPanel.tsx` | training-runs | trainingApi | - | - | 1 | open |
| `components/training-studio/Yue2AitkTrainCard.tsx` | training-runs | api, preferencesApi, sharedEventSource, trainingApi, trainingOperations, trainingPreparationApi | - | 1 | 5 | open |
| `components/training-studio/Yue2ArTrainCard.tsx` | training-runs | trainingApi, trainingRecipesApi | - | - | 1 | open |
| `components/training-studio/Yue2BatchPanel.tsx` | training-runs | trainingApi | - | - | 2 | open |
| `components/training-studio/Yue2ClearPreparedCard.tsx` | training-data | trainingApi | - | - | - | open |
| `components/training-studio/Yue2LadderReview.tsx` | training-runs | trainingApi, trainingReviewApi | - | - | - | open |
| `components/training-studio/Yue2OptimisePanel.tsx` | training-runs | trainingApi | - | - | 1 | open |
| `components/training-studio/Yue2OptimizerFields.tsx` | training-data | trainingApi | - | - | - | open |
| `components/training-studio/Yue2SplitChart.tsx` | training-data | sharedEventSource, trainingApi | - | 1 | - | open |
| `components/training-studio/Yue2TrainCard.tsx` | training-runs | trainingApi, trainingRecipesApi | - | - | - | open |
| `components/training-studio/Yue2TrainStages.tsx` | training-runs | trainingPreparationApi | - | - | 1 | open |
| `components/training-studio/sendAuditionToCustomGen.ts` | training-data | trainingApi, trainingOperations | 1 | - | - | open |
| `components/training-studio/useMm3Status.ts` | training-runs | trainingApi | - | - | - | open |
| `components/training-studio/useTrainingStream.ts` | training-data | sharedEventSource, trainingApi | - | 1 | - | open |
| `components/training-studio/useYue2ArStatus.ts` | training-runs | trainingApi | - | - | - | open |
| `components/training-studio/useYue2Status.ts` | training-runs | trainingApi | - | - | - | open |
| `components/training-studio/yue2ChartData.ts` | training-data | trainingApi | - | - | - | open |
| `components/training-studio/yue2JointCommand.ts` | training-data | trainingApi, trainingOperations, trainingPreparationApi | - | - | - | open |
| `components/training-studio/yue2JointPresets.ts` | training-data | trainingApi | - | - | - | open |
| `context/AuthContext.tsx` | foundation | api | - | - | - | transport |
| `hooks/useAssistantActions.ts` | studios | assistantApi | - | - | - | open |
| `hooks/useCapabilities.ts` | global-models | - | - | - | 1 | open |
| `hooks/useEventSource.ts` | global-models | sharedEventSource | - | 2 | - | open |
| `hooks/usePluginRegistry.ts` | global-models | - | 1 | - | - | open |
| `hooks/usePolling.ts` | shell-queue | - | - | - | 1 | open |
| `hooks/useStreamAudio.ts` | studios | analysis | 4 | - | 1 | open |
| `queries/contract.ts` | foundation | httpClient | - | - | - | none |
| `queries/keys.ts` | foundation | httpClient | - | - | - | none |
| `queries/sseBridge.ts` | foundation | sharedEventSource | - | - | - | none |
| `services/api.ts` | foundation | httpClient, workflowApi | 8 | - | - | transport |
| `services/assistantApi.ts` | studios | - | 2 | - | - | open |
| `services/audioQueueApi.ts` | shell-queue | - | 2 | - | - | open |
| `services/coverWorkflowApi.ts` | cover-lyrics | workflowApi | 2 | - | - | open |
| `services/dataFolderApi.ts` | shell-queue | - | 1 | - | - | open |
| `services/exportImportApi.ts` | shell-queue | api | 3 | - | - | open |
| `services/httpClient.ts` | foundation | - | 4 | 2 | - | transport |
| `services/inspireApi.ts` | studios | workflowApi | 9 | - | - | open |
| `services/lireekApi.ts` | cover-lyrics | - | 2 | - | - | open |
| `services/lyricWorkflowApi.ts` | cover-lyrics | workflowApi | 1 | - | - | open |
| `services/midiStudioApi.ts` | studios | - | 8 | - | - | open |
| `services/preferencesApi.ts` | shell-queue | workflowApi | 1 | - | - | open |
| `services/presetCollection.ts` | shell-queue | preferencesApi, workflowApi | - | - | - | open |
| `services/repaintLayerWorkflowApi.ts` | studios | workflowApi | - | - | - | open |
| `services/settingDocument.ts` | shell-queue | preferencesApi, workflowApi | - | - | - | open |
| `services/sharedEventSource.ts` | foundation | - | - | 2 | - | transport |
| `services/stemStudioApi.ts` | studios | - | 8 | - | - | open |
| `services/streamSessionsApi.ts` | studios | - | 2 | - | - | open |
| `services/studioDraftMirror.ts` | cover-lyrics | studioDraftsApi | - | - | - | open |
| `services/studioDraftsApi.ts` | cover-lyrics | workflowApi | - | - | - | open |
| `services/supersepApi.ts` | studios | - | 5 | - | - | open |
| `services/trainingApi.ts` | foundation | httpClient | 3 | - | - | transport |
| `services/trainingOperations.ts` | training-data | trainingApi | 1 | - | - | open |
| `services/trainingPreparationApi.ts` | training-data | trainingOperations | - | - | - | open |
| `services/trainingRecipesApi.ts` | training-data | trainingOperations | - | - | - | open |
| `services/trainingReviewApi.ts` | training-runs | trainingApi, trainingOperations | - | - | - | open |
| `services/workflowApi.ts` | shell-queue | - | 2 | - | - | open |
| `services/yue2CoverApi.ts` | cover-lyrics | - | 1 | - | - | open |
| `stores/audioGenQueueStore.ts` | shell-queue | api, audioQueueApi, lireekApi, workflowApi | 1 | - | 1 | open |
| `stores/audioQueueStoreTestFake.ts` | shell-queue | preferencesTestFake | - | - | - | open |
| `stores/backendStore.ts` | global-models | - | 5 | - | - | open |
| `stores/coverStemsStore.ts` | cover-lyrics | supersepApi | - | - | - | open |
| `stores/discoStore.ts` | shell-queue | - | 1 | - | - | open |
| `stores/globalParamsStore.ts` | global-models | - | 1 | - | - | open |
| `stores/mm3StreamStore.ts` | shell-queue | - | 1 | - | - | open |
| `stores/postProcessStore.ts` | shell-queue | api | - | - | 1 | open |
| `stores/streamingStore.ts` | cover-lyrics | lireekApi, lyricWorkflowApi | - | - | - | open |
| `stores/trainingStore.ts` | training-data | trainingApi, trainingOperations, trainingPreparationApi | - | - | - | open |
| `stores/vstChainStore.ts` | global-models | api, preferencesApi, presetCollection | 4 | - | - | open |
| `utils/downloadTrack.ts` | shell-queue | exportImportApi | - | - | - | open |
| `utils/heapWatch.ts` | shell-queue | - | - | - | 1 | open |
| `utils/lrcUtils.ts` | shell-queue | - | 1 | - | - | open |
| `utils/wordLrcUtils.ts` | shell-queue | - | 1 | - | - | open |
| `utils/yue2CaptionSource.ts` | shell-queue | - | 1 | - | - | open |
