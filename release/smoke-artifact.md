# Windows archive smoke test

Run from the checkout on Windows with Node 20-24:

```powershell
node release/smoke-artifact.mjs release/out/HOT-Step-CPP-vVERSION-win-x64-cpu.zip
node --test release/smoke-artifact.test.mjs
```

The optional second argument is an existing output parent outside the checkout.
The third argument is the server and engine timeout in seconds, default 60,
maximum 600. Extraction has a separate 120-second timeout. Every invocation
creates a unique `hotstep-artifact-*` directory under the output parent, with
the archive extracted directly into `HOT Step smoke`. Archives must contain
`runtime/node.exe`, `server/server.mjs` and `engine/ace-server.exe` at their root.

The gate runs the checkout's existing `smoke-boot.mjs` using the extracted Node
runtime against the extracted server bundle. It uses temporary data and profile
directories, a deliberately absent engine and a CPU marker so boot does not
download CUDA runtimes. The engine is then launched separately with four
header-only GGUF stubs and a free localhost port. It must serve `/health`,
`/props`, `/plugins` and `/props` again, then remain alive for two seconds.
Requests have two-second deadlines. These checks do not load models or test
GPU inference or GGML backend loading.

The server and engine run with only Windows system directories on `PATH`, so
toolkit or build-tree directories cannot supply missing packaged DLLs. The
engine still uses DLLs next to its executable and the Windows system loader.
The current process environment is otherwise inherited; package-local config
is part of what is tested. Each command is awaited and reaped. On timeout or
interruption, Windows `taskkill /PID <owned-pid> /T /F` kills its process tree.
No dev stack, launcher or GPU job is started.

The printed evidence directory is retained on success and failure. It contains
`result.json`, `extract.log`, `server.log`, and, once the server passes,
`engine.log`, plus the extraction and isolated test state. Upload that directory
as CI failure evidence, or inspect it locally and delete it when finished.
`server.log` includes the existing smoke helper's last 40 server output lines
on failure. Exit 0 means both checks passed; any extraction, boot, HTTP or
cleanup failure returns nonzero. Workflow wiring and the owning developer docs
are handled by the release workflow slice.
