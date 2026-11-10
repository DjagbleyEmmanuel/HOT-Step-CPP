# Debian packaging for HOT-Step CPP

Builds a `.deb` out of an already-compiled HOT-Step CPP tree. This is the same
package tree the project's `.github/workflows/release.yml` produces for the
portable Linux tarballs, repacked with Debian's directory conventions.

There is no upstream `debian/` directory in this repository; the project ships
portable tarballs instead. This directory is local, self-contained, and does not
feed into the project's CI.

## Layout

| Path | Contents | Mode |
|---|---|---|
| `/opt/hot-step-cpp/` | engine binaries, ggml backends, Node runtime, `server.mjs`, `ui/dist`, Electron shell, plugins, Essentia | root-owned, read-only |
| `/var/lib/hot-step-cpp/` | the data root: `library/` (SQLite + songs), `models/`, `adapters/`, `settings/.env`, `logs/`, `tools/`, `profile/` | owned by the installing user |
| `/etc/hot-step-cpp/hot-step.env` | system-wide configuration | root-owned conffile |
| `/usr/bin/hot-step` | **desktop app** (opens a window) | 0755 |
| `/usr/bin/hot-step-server` | server only, no window (headless/SSH) | 0755 |
| `/usr/share/applications/hot-step-cpp.desktop` | app menu entry | 0644 |
| `/usr/share/icons/hicolor/*/apps/hot-step-cpp.png` | 8 icon sizes | 0644 |

The state directory must be writable by the user who launches the app, and the
launcher refuses to start rather than letting the app write a root-owned
database. `postinst` therefore chowns `/var/lib/hot-step-cpp` to the invoking
user. sudo and doas expose that user in the environment; GUI package managers
(GNOME Software, KDE Discover, aptkit) do not, so it also checks `PKEXEC_UID`
and then the active logind session. Upgrades keep an existing non-root owner.
Only when no real user can be found is the state left root-owned (e.g. a
headless `dpkg -i` over SSH), and the launcher then shows a dialog with the
`sudo chown` fix instead of failing silently.

## The desktop app

Upstream is a local web server, not a native app, so the `.deb` adds a desktop
shell: a small Electron main process (`desktop/app/src/main.js`) that

1. starts the bundled Node server (`desktop/app` → `server/boot.mjs`),
2. polls `/api/health` and shows a splash window until it answers,
3. opens the real app in its own window — no browser, no URL bar, no tabs,
4. stops the server when the window closes.

You do not have to start the server first, and nothing is left running
afterwards. `hot-step` opens the window; `hot-step-server` runs the server on
its own if you want it headless.

Three details that are easy to get wrong:

- **`chrome-sandbox` must be setuid root** (`postinst` does it). Electron will
  not sandbox its renderer otherwise. `--no-sandbox` is deliberately not passed.
- **The binary is renamed** from `electron` to `hot-step-cpp`, so the process
  name and `WM_CLASS` are `hot-step-cpp` rather than `electron` — otherwise
  every Electron window on the desktop groups together in the window switcher.
  Chromium finds `resources/` relative to the executable's directory, so the
  rename is safe.
- **Single instance lock.** A second launch focuses the existing window instead
  of starting a rival server on the same port and SQLite file.

### Not orphaning the engine

Both launchers handle `SIGTERM`/`SIGINT` and shut the engine down, but neither
can catch being `SIGKILL`ed — and killing an X11 window client with
`XKillClient` does exactly that. The result would be an orphaned Node server
still listening on 3001 with an `ace-server` child holding VRAM and no UI to
reach it by.

So the server is started through `server/boot.mjs`, which polls `process.ppid`
and, when the kernel reparents it to init, sends itself `SIGTERM` and lets the
server's own handlers close the database and stop the engine. Verified against
both a normal window close and an `XKillClient`.

### The icon

The project ships only a 400×133 wordmark (`ui/public/logo.webp`), which cannot
work as an app icon: a `.desktop` entry needs a square, and wordmarks stop being
legible below about 64px. So `electron/icon/make-icon.py` composes one from the
brand's own colours — the logo's near-black backdrop, the orange→magenta of its
lightning — at 8 sizes. Regenerate with:

```bash
python3 packaging/deb/electron/icon/make-icon.py
```

## Why the split is not just cosmetic

Upstream 1.4.1 reworked where data lives: `server/src/dataroot` owns the layout,
and defaults the data folder to `<parent of app>/HOT-Step-Data`. For a portable
tarball that is the folder next to the extracted app. For this package
`HOT_STEP_ROOT` is `/opt/hot-step-cpp`, so the default would be
`/opt/HOT-Step-Data` — **read-only**, and `bootstrap.ts` treats an unwritable
data root as fatal ("HOT-Step cannot start … EACCES"), serving one plain error
page and refusing to boot.

So all three launchers pin the two documented overrides:

```sh
export HOT_STEP_DATA_ROOT=/var/lib/hot-step-cpp
export HOT_STEP_PROFILE_DIR=/var/lib/hot-step-cpp/profile
```

That is what keeps `/opt` genuinely read-only and needs no symlinks for the new
layout. `HOT_STEP_PROFILE_DIR` keeps the pointer that records the data location
beside the data, so a backup of `/var/lib/hot-step-cpp` is self-contained rather
than depending on `~/.config`.

Pinning the root also means the in-app "repoint your data folder" control will
not move it. That is the intended trade for a package-managed install.

The `postinst` still creates the six legacy symlinks (`/opt/hot-step-cpp/.env`,
`logs`, `models`, `adapters`, `data`, `.restart-requested`). Those exist because
`inspectLegacy()` looks at exactly those paths to find a pre-1.4.1 install to
migrate, so pointing them into `/var/lib` preserves the migration path instead
of stranding a 1.4.0-era user.

### Port conflicts

Two HOT-Step installs on one machine is the ordinary way this goes wrong: the
portable copy holds 3001, the packaged one cannot bind, its server dies on
`EADDRINUSE`, and the splash spins with no explanation.

`main.js` therefore resolves the listening socket on the configured port to a
PID via `/proc` (no external tools), walks its ancestry, and if the holder is not
this process or a descendant, stops with the holder's PID, its `HOT_STEP_ROOT`
and its command line — plus the one-line fix. The message also goes to stderr,
because when launched from a terminal there may be nobody to click a dialog.

Note the config is parsed **before** the port is checked. `SERVER_PORT` is only
read out of `/etc` by `serverEnv()`, so checking first would test the built-in
default and report a conflict on a port the app was never going to use.

### Two environment layers

`/etc/hot-step-cpp/hot-step.env` is parsed into the environment by both
launchers (`launcher-server` in the shell, `parseSystemConfig()` in
`main.js`), so it wins over `.env`. It is deliberately minimal: only the two
bind addresses, neither of which is Settings-editable.

| Want to change | Where |
|---|---|
| Where model weights are read from | Settings > Environment, **or** `ACESTEPCPP_MODELS` in `/etc/hot-step-cpp/hot-step.env` (this wins) |
| Ports, API keys, LLM provider, GPU | Settings > Environment |
| Bind address | `/etc/hot-step-cpp/hot-step.env` only |

The env file is **parsed, not sourced**, so a path containing spaces works
either way and the file cannot execute anything:

```bash
sudo nano /etc/hot-step-cpp/hot-step.env
#   ACESTEPCPP_MODELS="/media/ghost/Pride/AceStep Music Models"
```

Then restart. The engine rescans the folder on startup. `/etc` is a dpkg
conffile, so a package upgrade will prompt if you have edited it —
`sudo dpkg -i --force-confold` keeps your version.

`SERVER_HOST=127.0.0.1` is the packaged default rather than upstream's
`0.0.0.0`. The server has no authentication and will drive your GPU, so it
should not be answering on your whole network unless you ask for it.

## Building

Prerequisites, all of which the script expects to already exist:

```bash
# engine (this is the long pole)
git submodule update --init engine/ggml engine/vendor/vst3sdk
(cd engine/vendor/vst3sdk && git submodule update --init base cmake pluginterfaces public.sdk)
mkdir -p engine/build && cd engine/build
cmake .. -G Ninja -DCMAKE_BUILD_TYPE=Release \
  -DGGML_CUDA=ON -DGGML_VULKAN=ON -DGGML_BACKEND_DL=ON -DGGML_CPU_ALL_VARIANTS=ON \
  -DCMAKE_CUDA_ARCHITECTURES=61 -DCMAKE_CUDA_COMPILER=/usr/local/cuda/bin/nvcc
cmake --build . -j "$(nproc)"
```

`GGML_BACKEND_DL=ON` is what puts CUDA and Vulkan in one package: the backends
become separate `libggml-cuda.so` / `libggml-vulkan.so` plugins that `ace-server`
`dlopen()`s, so the backend picker in the UI switches between them at runtime.

```bash
# server + UI
(cd server && npm install --ignore-scripts)
(cd server/node_modules/better-sqlite3 && npx prebuild-install --runtime node --target 24.18.0 --arch x64 --platform linux)
(cd server/node_modules/ffmpeg-static && node install.js)
(cd ui && npm install && npx vite build)

# Node runtime to bundle
curl -LO https://nodejs.org/dist/v24.18.0/node-v24.18.0-linux-x64.tar.xz
tar xf node-v24.18.0-linux-x64.tar.xz

# Desktop shell (~283 MB unpacked; downloads the Electron binary)
(cd packaging/deb/electron && npm install)
(cd packaging/deb/electron/node_modules/electron && node install.js)

# Essentia (optional but recommended - BPM/key detection)
bash tools/essentia/build-linux.sh /path/to/Essentia-linux-x64
```

Then:

```bash
packaging/deb/build-deb.sh \
  --engine-build engine/build \
  --node-runtime /path/to/node-v24.18.0-linux-x64 \
  --essentia /path/to/Essentia-linux-x64 \
  --variant cuda --cuda-major 12
```

Output: `packaging/deb/out/hot-step-cpp_<version>_amd64.deb`

### Options

| Flag | Meaning |
|---|---|
| `--engine-build DIR` | cmake build dir with the compiled engine |
| `--node-runtime DIR` | extracted `node-vX-linux-x64` tree |
| `--essentia DIR` | Essentia bundle; omit to build without BPM/key detection |
| `--server-bundle FILE` | use a prebuilt `server.mjs` instead of re-running esbuild |
| `--version VERSION` | override the package version |
| `--variant` | `engine/.variant` marker; auto-detected from the built backends |
| `--cuda-major N` | `engine/.cuda-version` marker |
| `--output DIR` | where to write the `.deb` |
| `--keep-stage` | keep the staging tree for inspection |

## Installing and removing

```bash
sudo dpkg -i hot-step-cpp_<version>_amd64.deb
```

Then launch **HOT-Step CPP** from your desktop menu, or:

```bash
hot-step                 # opens the app window
hot-step-server          # server only, no window (headless / over SSH)
```

Models are not in the package (5–12 GB) unless you point it at weights you
already have — see "Custom model folders" above. Otherwise the Model Manager
opens on first launch: download a starter pack and restart from the sidebar.

```bash
sudo dpkg -r hot-step-cpp      # keeps models, songs, database and logs
sudo dpkg -P hot-step-cpp      # deletes /var/lib/hot-step-cpp as well
```

## Notes

- **glibc floor.** Build on Ubuntu 22.04 or newer for the widest compatibility;
  upstream's CI does the same. This build was made on Linux Mint 22.3
  (glibc 2.39), so it will not run on anything older than that.
- **CUDA arch.** `CMAKE_CUDA_ARCHITECTURES=61` targets Pascal (GTX 10-series,
  including the GTX 1050 this was built for). Add your card's compute capability
  — or use a bare number for the built-in default — to support more.
- **CUDA runtime.** `libcudart-12-6` is a hard `Depends`, and `libcuda.so.1`
  comes from the NVIDIA driver. Without them the engine falls back to CPU or
  fails to load its CUDA backend; the Vulkan backend keeps working.
- **Essentia is AGPL-3.0** and FFmpeg is LGPL-2.1+. Redistributing the resulting
  `.deb` carries those obligations. The bundle in `Essentia/` is not statically
  linked and expects the host's glibc.
- **`node_modules` is trimmed to three packages** (`better-sqlite3`, `bindings`,
  `file-uri-to-path`), matching upstream: everything else is inlined by esbuild.