#!/usr/bin/env bash
# build-deb.sh - assemble the HOT-Step CPP Linux install into a .deb
#
# Mirrors what .github/workflows/release.yml does for the portable Linux
# tarballs, then repacks that same tree using Debian's directory conventions:
#
#   /opt/hot-step-cpp/     application files, root-owned and read-only
#   /var/lib/hot-step-cpp/ models, songs, database, logs (writable)
#   /etc/hot-step-cpp/     system configuration
#   /usr/bin/hot-step     launcher
#
# Usage:
#   ./build-deb.sh [options]
#
#   --engine-build DIR   cmake build dir with the compiled engine
#                        (default: $REPO/engine/build)
#   --node-runtime DIR   extracted node-vX-linux-x64 tree
#   --essentia DIR       Essentia bundle dir (essentia_streaming_extractor_music
#                        plus lib/). Omit to build without BPM/key detection.
#   --server-bundle FILE prebuilt server.mjs (default: re-run esbuild)
#   --version VERSION    package version (default: git describe, else server/package.json)
#   --variant NAME       engine/.variant marker: cuda, vulkan or cpu
#   --cuda-major N       engine/.cuda-version marker
#   --output DIR         where to write the .deb (default: $REPO/packaging/deb/out)
#   --keep-stage         do not delete the staging tree (for inspection)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

ENGINE_BUILD="$REPO/engine/build"
NODE_RUNTIME=""
ESSENTIA=""
SERVER_BUNDLE=""
VERSION=""
VARIANT=""
CUDA_MAJOR=""
OUTPUT="$HERE/out"
KEEP_STAGE=0

while [ $# -gt 0 ]; do
    case "$1" in
        --engine-build) ENGINE_BUILD="$2"; shift 2 ;;
        --node-runtime) NODE_RUNTIME="$2"; shift 2 ;;
        --essentia)     ESSENTIA="$2"; shift 2 ;;
        --server-bundle) SERVER_BUNDLE="$2"; shift 2 ;;
        --version)      VERSION="$2"; shift 2 ;;
        --variant)      VARIANT="$2"; shift 2 ;;
        --cuda-major)   CUDA_MAJOR="$2"; shift 2 ;;
        --output)       OUTPUT="$2"; shift 2 ;;
        --keep-stage)   KEEP_STAGE=1; shift ;;
        -h|--help)      sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "build-deb.sh: unknown option '$1'" >&2; exit 2 ;;
    esac
done

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33mwarning: %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31merror: %s\033[0m\n' "$*" >&2; exit 1; }

# ── Version ──────────────────────────────────────────────────────────────
if [ -z "$VERSION" ]; then
    VERSION="$(git -C "$REPO" describe --tags --abbrev=0 2>/dev/null || true)"
    VERSION="${VERSION#v}"
fi
if [ -z "$VERSION" ]; then
    VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$REPO/server/package.json" | head -1)"
fi
[ -n "$VERSION" ] || die "could not determine a version; pass --version"
# Debian versions allow alphanumerics, '.', '+' and '-'. A git describe suffix
# like "13fd17a5-2-gabc" is already fine.
PKG_NAME=hot-step-cpp
ARCH=amd64

say "Building $PKG_NAME $VERSION ($ARCH)"

# ── Preflight: every input must exist before we build a package from it ───
[ -d "$ENGINE_BUILD" ] || die "engine build dir not found: $ENGINE_BUILD"
for bin in ace-server ace-train ace-caption; do
    [ -f "$ENGINE_BUILD/$bin" ] || die "required engine binary missing: $ENGINE_BUILD/$bin"
done
[ -d "$REPO/ui/dist" ] || die "ui/dist not found - run 'npx vite build' in ui/ first"

# ── Staging tree ─────────────────────────────────────────────────────────
STAGE="$(mktemp -d "${TMPDIR:-/var/tmp}/hotstep-deb-XXXXXX")"
cleanup() {
    [ "$KEEP_STAGE" = "1" ] || rm -rf "$STAGE"
    [ -n "${INVENTORY:-}" ] && rm -f "$INVENTORY"
    return 0
}
trap cleanup EXIT

PREFIX_DIR="$STAGE/opt/hot-step-cpp"
STATE_DIR="$STAGE/var/lib/hot-step-cpp"
ETC_DIR="$STAGE/etc/hot-step-cpp"
mkdir -p "$PREFIX_DIR"/{engine,server,ui} "$STATE_DIR"/{models,adapters,data,logs} \
         "$ETC_DIR" "$STAGE/usr/bin" "$STAGE/usr/share/applications" \
         "$STAGE/usr/share/icons/hicolor" "$STAGE/DEBIAN"

# ── Version + variant markers ────────────────────────────────────────────
printf '%s' "$VERSION" > "$PREFIX_DIR/VERSION"

if [ -z "$VARIANT" ]; then
    if [ -f "$ENGINE_BUILD/libggml-cuda.so" ]; then VARIANT=cuda
    elif [ -f "$ENGINE_BUILD/libggml-vulkan.so" ]; then VARIANT=vulkan
    else VARIANT=cpu
    fi
fi
printf '%s' "$VARIANT" > "$PREFIX_DIR/engine/.variant"
[ -n "$CUDA_MAJOR" ] && printf '%s' "$CUDA_MAJOR" > "$PREFIX_DIR/engine/.cuda-version"

# ── Engine binaries ──────────────────────────────────────────────────────
say "Engine binaries ($VARIANT)"
for bin in ace-server ace-train ace-caption ace-midi mastering mp3-codec \
           neural-codec quantize vst-host; do
    if [ -f "$ENGINE_BUILD/$bin" ]; then
        cp -a "$ENGINE_BUILD/$bin" "$PREFIX_DIR/engine/"
    else
        warn "engine binary not built, skipping: $bin"
    fi
done

# Shared libraries: ggml core plus the dynamically loaded backend plugins.
# With GGML_BACKEND_DL the CUDA and Vulkan backends are separate .so files that
# ace-server dlopen()s at runtime, which is what lets one build offer both.
so_count=0
while IFS= read -r -d '' so; do
    cp -a "$so" "$PREFIX_DIR/engine/"; so_count=$((so_count + 1))
done < <(find "$ENGINE_BUILD" -maxdepth 1 \( -name '*.so' -o -name '*.so.*' \) -print0)
say "  $so_count shared libraries"
[ "$so_count" -gt 0 ] || die "no shared libraries found in $ENGINE_BUILD"

# ── Plugins ──────────────────────────────────────────────────────────────
[ -d "$REPO/engine/plugins" ] && cp -a "$REPO/engine/plugins" "$PREFIX_DIR/engine/plugins"
[ -d "$REPO/plugins" ] && cp -a "$REPO/plugins" "$PREFIX_DIR/plugins"
# The engine derives both plugin roots from its own executable path
# (hot-step-server.cpp), scanning <dir of exe>/plugins and <parent>/plugins.
# The flat /opt/hot-step-cpp/engine + /opt/hot-step-cpp/plugins pair above is
# exactly that layout, so no symlinks are needed.

# ── Node runtime ─────────────────────────────────────────────────────────
say "Node runtime"
if [ -n "$NODE_RUNTIME" ]; then
    mkdir -p "$PREFIX_DIR/runtime/bin" "$PREFIX_DIR/runtime/lib"
    cp -a "$NODE_RUNTIME/bin/node" "$PREFIX_DIR/runtime/bin/node"
    # ICU data, when the tarball ships it (needed for full Intl support).
    if ls "$NODE_RUNTIME"/lib/*.dat >/dev/null 2>&1; then
        cp -a "$NODE_RUNTIME"/lib/*.dat "$PREFIX_DIR/runtime/lib/"
    fi
else
    die "--node-runtime is required (pass the extracted node-vX-linux-x64 dir)"
fi

# ── Server bundle ────────────────────────────────────────────────────────
say "Server bundle"
SRVOUT="$PREFIX_DIR/server"
mkdir -p "$SRVOUT/node_modules"
if [ -n "$SERVER_BUNDLE" ]; then
    # Accept either the staging/server directory or a bare server.mjs, so an
    # older single-file bundle still works.
    if [ -d "$SERVER_BUNDLE" ]; then
        cp -a "$SERVER_BUNDLE/." "$SRVOUT/"
    else
        cp -a "$SERVER_BUNDLE" "$SRVOUT/server.mjs"
    fi
else
    # Wipe first: esbuild writes hashed chunk filenames, so a stale
    # release/staging/server from an earlier build keeps its old chunks around.
    # They bloat the package and, worse, can shadow a chunk of the same name.
    rm -rf "$REPO/release/staging/server"
    ( cd "$REPO" && node release/esbuild.config.mjs )
    [ -f "$REPO/release/staging/server/server.mjs" ] \
        || die "esbuild did not produce server/server.mjs"
    # Copy the whole tree, not just server.mjs: the bundle is code-split
    # (splitting: true, chunkNames: 'chunks/[name]-[hash]'), so server.mjs
    # dynamically imports from chunks/. Copying the entry alone yields a server
    # that starts and then dies on the first lazy route.
    cp -a "$REPO/release/staging/server/." "$SRVOUT/"
fi
[ -f "$SRVOUT/server.mjs" ] || die "server/server.mjs missing from the staged bundle"

# Any chunk referenced but absent is a silent landmine; make it loud here.
if [ -d "$SRVOUT/chunks" ]; then
    say "  $(find "$SRVOUT/chunks" -name '*.mjs' | wc -l) server chunks"
fi

# better-sqlite3 is a native addon and stays external to the esbuild bundle.
# Its own dependencies (bindings, file-uri-to-path) have to travel with it.
BSQL_SRC="$REPO/server/node_modules/better-sqlite3"
[ -f "$BSQL_SRC/build/Release/better_sqlite3.node" ] \
    || die "better_sqlite3.node missing - run: (cd server/node_modules/better-sqlite3 && npx prebuild-install --runtime node --target 24.18.0 --arch x64 --platform linux)"
BSQL_DST="$SRVOUT/node_modules/better-sqlite3"
mkdir -p "$BSQL_DST/build/Release"
cp -a "$BSQL_SRC/package.json" "$BSQL_DST/"
[ -d "$BSQL_SRC/lib" ] && cp -a "$BSQL_SRC/lib" "$BSQL_DST/lib"
cp -a "$BSQL_SRC/build/Release/better_sqlite3.node" "$BSQL_DST/build/Release/"
for dep in bindings file-uri-to-path; do
    [ -d "$REPO/server/node_modules/$dep" ] \
        && cp -a "$REPO/server/node_modules/$dep" "$SRVOUT/node_modules/$dep"
done

# Read-only runtime data: the model catalogue, the MM3 caption corpus and the
# assistant knowledge base. Read as PROJECT_ROOT/server/data/model-registry.json,
# which is a different path from DATA_DIR (the writable database directory).
say "Server data files"
mkdir -p "$SRVOUT/data"
[ -d "$REPO/server/src/data" ] || die "server/src/data missing"
cp -a "$REPO/server/src/data/." "$SRVOUT/data/"

# Entry point wrapper: exits the server if the launcher that started it dies.
# See the comments in the file; it is what stops an orphaned server and engine
# holding port 3001 and VRAM after a SIGKILL.
cp -a "$HERE/server-boot.mjs" "$SRVOUT/boot.mjs"

# ffmpeg: audio import and a few ace-train stages shell out to it.
if [ -f "$REPO/server/node_modules/ffmpeg-static/ffmpeg" ]; then
    cp -a "$REPO/server/node_modules/ffmpeg-static/ffmpeg" "$SRVOUT/ffmpeg"
    say "  bundled ffmpeg"
else
    warn "ffmpeg-static binary missing - audio import will not work"
fi

# Same gate upstream CI runs before publishing an archive: boot the staged
# bundle in place, with its node_modules around it. It has to run after the
# copies above, because the bundle imports better-sqlite3 natively. What it
# catches is a missing chunk: the bundle is code-split, so shipping the entry
# without chunks/ produces a server that starts and then dies on the first
# lazy route rather than failing at build time.
if [ -f "$REPO/release/smoke-boot.mjs" ] && [ -x "$NODE_RUNTIME/bin/node" ]; then
    say "Boot-testing the staged server bundle"
    # With the Node that actually ships, not whatever `node` is on PATH:
    # better-sqlite3 is a native addon and its ABI has to match, so testing
    # under a different Node proves nothing (and fails confusingly).
    "$NODE_RUNTIME/bin/node" "$REPO/release/smoke-boot.mjs" "$SRVOUT/server.mjs" \
        || die "staged server.mjs failed its boot test (missing chunk?)"
    say "  bundle boots"
fi

# ── UI ───────────────────────────────────────────────────────────────────
say "UI"
cp -a "$REPO/ui/dist" "$PREFIX_DIR/ui/dist"

# ── Essentia (BPM / key detection) ───────────────────────────────────────
if [ -n "$ESSENTIA" ]; then
    say "Essentia"
    cp -a "$ESSENTIA" "$PREFIX_DIR/Essentia"
    [ -x "$PREFIX_DIR/Essentia/essentia_streaming_extractor_music" ] \
        || die "essentia_streaming_extractor_music not executable in $ESSENTIA"
    say "  bundled (AGPL-3.0, see $PREFIX_DIR/Essentia/COPYING.txt if present)"
else
    warn "no --essentia given: BPM/key detection will be unavailable"
fi

# ── Misc runtime content ─────────────────────────────────────────────────
[ -d "$REPO/noise_samples" ] && cp -a "$REPO/noise_samples" "$PREFIX_DIR/noise_samples"

cp -a "$HERE/env.example" "$PREFIX_DIR/.env.example"
cp -a "$HERE/hot-step.env"  "$ETC_DIR/hot-step.env"
install -m 0755 "$HERE/launcher-desktop" "$STAGE/usr/bin/hot-step"
install -m 0755 "$HERE/launcher-server"  "$STAGE/usr/bin/hot-step-server"
cp -a "$REPO/LICENSE" "$PREFIX_DIR/LICENSE"
[ -d "$REPO/docs" ] && cp -a "$REPO/docs" "$PREFIX_DIR/docs"

cat > "$PREFIX_DIR/README.txt" <<EOF
HOT-Step CPP $VERSION - Debian package layout

Application   /opt/hot-step-cpp/          (read-only)
Your data     /var/lib/hot-step-cpp/      models, songs, database, logs
Configuration /etc/hot-step-cpp/hot-step.env   (system-wide, needs sudo)
              /var/lib/hot-step-cpp/.env       (the Settings screen writes this)

Start the app:

    hot-step

Then open http://localhost:3001. On first launch the Model Manager opens;
download a starter pack, restart from the sidebar, and generate.

The server has no authentication and drives your GPU. It listens on
127.0.0.1 only; do not bind it to 0.0.0.0 unless you mean to.

Logs: /var/lib/hot-step-cpp/logs/<session>/

Upstream: https://github.com/scragnog/HOT-Step-CPP
EOF

# ── Desktop shell (Electron) ────────────────────────────────────────────
# The upstream app is a local web server, so the "desktop app" is a real
# Chromium window wrapped around it: the shell starts the Node server, waits
# for it to answer, shows the window, and stops the server when the window
# closes. This is what makes the app show up in the desktop menu with its own
# icon instead of asking the user to point a browser at localhost.
say "Desktop shell (Electron)"
ELECTRON_DIST="$HERE/electron/node_modules/electron/dist"
[ -x "$ELECTRON_DIST/electron" ] \
    || die "electron binary not found at $ELECTRON_DIST - run: (cd packaging/deb/electron && npm install && node node_modules/electron/install.js)"

DESKTOP="$PREFIX_DIR/desktop"
mkdir -p "$DESKTOP/resources" "$DESKTOP/app/src" "$DESKTOP/app/icon"

# Renamed from "electron" so the process name and WM_CLASS are hot-step-cpp
# rather than "electron", which would group every window together in the
# window switcher. Chromium resolves resources/ relative to the executable's
# directory by name, so renaming the binary itself is safe.
cp -a "$ELECTRON_DIST/electron" "$DESKTOP/hot-step-cpp"
for f in resources.pak icudtl.dat snapshot_blob.bin v8_context_snapshot.bin \
         chrome_100_percent.pak chrome_200_percent.pak libffmpeg.so \
         libvk_swiftshader.so libvulkan.so.1 vk_swiftshader_icd.json \
         chrome_crashpad_handler chrome-sandbox; do
    [ -f "$ELECTRON_DIST/$f" ] && cp -a "$ELECTRON_DIST/$f" "$DESKTOP/$f"
done
cp -a "$ELECTRON_DIST/resources/." "$DESKTOP/resources/"

# 55 locales ship by default (~8.7 MB). The app is an English-language UI and
# Chromium falls back to en-US, so keep a handful and drop the rest.
if [ -d "$ELECTRON_DIST/locales" ]; then
    mkdir -p "$DESKTOP/locales"
    for loc in en-US en-GB de es fr it nl pl pt-BR ru tr ja ko zh-CN zh-TW; do
        [ -f "$ELECTRON_DIST/locales/$loc.pak" ] \
            && cp -a "$ELECTRON_DIST/locales/$loc.pak" "$DESKTOP/locales/"
    done
fi

# Chromium's own licence text. Required for redistribution, and it is 20 MB.
cp -a "$ELECTRON_DIST/LICENSES.chromium.html" "$DESKTOP/" 2>/dev/null || true
[ -f "$ELECTRON_DIST/LICENSE" ] && cp -a "$ELECTRON_DIST/LICENSE" "$DESKTOP/LICENSE-electron"

# The shell's own code: main process + preload, plus a minimal package.json
# because Electron reads <app>/package.json for its entry point.
cp -a "$HERE/electron/src/main.js"    "$DESKTOP/app/src/main.js"
cp -a "$HERE/electron/src/preload.js" "$DESKTOP/app/src/preload.js"
cat > "$DESKTOP/app/package.json" <<EOF
{
  "name": "hot-step-cpp-desktop",
  "productName": "HOT-Step CPP",
  "version": "$VERSION",
  "private": true,
  "main": "src/main.js"
}
EOF
chmod -R a+rX "$DESKTOP/app"
chmod 0755 "$DESKTOP/hot-step-cpp"

# ── Desktop integration ─────────────────────────────────────────────────
# The .desktop entry is the whole reason this package exists as far as the
# user's menu is concerned: without it `dpkg -i` installs cleanly and the app
# is still invisible in Cinnamon's application list.
say "Desktop integration"
install -m 0644 "$HERE/hot-step-cpp.desktop" "$STAGE/usr/share/applications/hot-step-cpp.desktop"

# Icons in the standard hicolor theme so both the menu and the window use them.
ICON_SRC="$HERE/electron/icon"
[ -f "$ICON_SRC/hot-step-cpp-512.png" ] \
    || die "icon not generated - run: python3 packaging/deb/electron/icon/make-icon.py"
for size in 16 24 32 48 64 128 256 512; do
    src="$ICON_SRC/hot-step-cpp-$size.png"
    [ -f "$src" ] || continue
    dir="$STAGE/usr/share/icons/hicolor/${size}x${size}/apps"
    mkdir -p "$dir"
    install -m 0644 "$src" "$dir/hot-step-cpp.png"
done
cp -a "$ICON_SRC/hot-step-cpp.png" "$DESKTOP/app/icon/hot-step-cpp.png"
# ── Permissions ──────────────────────────────────────────────────────────
# Nothing in /opt is writable by the runtime user; the postinst creates the
# symlinks and the state directory that make the writes land in /var/lib.
find "$STAGE/opt" "$STAGE/etc" "$STAGE/usr" -type d -exec chmod 0755 {} +
find "$STAGE/var/lib/hot-step-cpp" -type d -exec chmod 0755 {} +
chmod 0644 "$ETC_DIR/hot-step.env"

# ── Shared library inventory → Depends ───────────────────────────────────
# Read the real NEEDED entries rather than guessing. Every file in engine/ has
# to be scanned, not just ace-server: the ggml backends are dlopen()ed, so
# ace-server's own ldd never mentions Vulkan or cuBLAS, and those are exactly
# the libraries a user hits "backend failed to load" without.
say "Shared library dependencies"
INVENTORY="$(mktemp "${TMPDIR:-/var/tmp}/hotstep-libs-XXXXXX")"
for f in "$PREFIX_DIR"/engine/*; do
    [ -f "$f" ] || continue
    objdump -p "$f" 2>/dev/null | awk '/NEEDED/ {print $2}'
done | sort -u > "$INVENTORY"

declare -A LIB_PKG=(
    [libc.so.6]=libc6
    [libm.so.6]=libc6
    [libdl.so.2]=libc6
    [libpthread.so.0]=libc6
    [librt.so.1]=libc6
    [libstdc++.so.6]=libstdc++6
    [libgcc_s.so.1]=libgcc-s1
    [libgomp.so.1]=libgomp1
    [libvulkan.so.1]=libvulkan1
    # CUDA runtime: the -12 packages are the minimal runtime-only builds. The
    # cuda-*-12-6 ones additionally install /usr/local/cuda, which is a
    # toolkit layout this package does not want to pull in.
    [libcudart.so.12]=libcudart12
    [libcublas.so.12]=libcublas12
    [libcublasLt.so.12]=libcublaslt12
)
# Supplied by the NVIDIA driver, whose package name tracks the driver branch.
# Never a hard Depends: it would drag a driver onto every machine, including
# the AMD and Intel ones the Vulkan backend exists to serve.
declare -A DRIVER_LIB=(
    [libcuda.so.1]="nvidia driver (libcuda.so.1)"
)

deps=()
declare -A seen_dep=()
add_dep() {
    [ -n "$1" ] || return 0
    [ -z "${seen_dep[$1]:-}" ] || return 0
    seen_dep[$1]=1
    deps+=("$1")
}

# ca-certificates: model downloads are HTTPS from Hugging Face.
add_dep ca-certificates

unmapped=""
while read -r lib; do
    [ -n "$lib" ] || continue
    pkg="${LIB_PKG[$lib]:-}"
    if [ -z "$pkg" ]; then
        if [ -n "${DRIVER_LIB[$lib]:-}" ]; then
            unmapped="$unmapped $lib(driver)"
        else
            unmapped="$unmapped $lib"
        fi
        continue
    fi
    add_dep "$pkg"
done < "$INVENTORY"

# Every mapped package must exist on the target distro, or dpkg -i fails on a
# dependency the user cannot satisfy.
for pkg in "${deps[@]}"; do
    if ! dpkg -s "$pkg" >/dev/null 2>&1 \
       && ! apt-cache show "$pkg" >/dev/null 2>&1; then
        die "Depends package '$pkg' does not exist on this system - fix the mapping"
    fi
done

driver_note=""
[ -f "$PREFIX_DIR/engine/libggml-cuda.so" ] \
    && driver_note="libggml-cuda.so: needs the NVIDIA driver for libcuda.so.1"
[ -f "$PREFIX_DIR/engine/libggml-vulkan.so" ] \
    && echo "  backend: Vulkan (libvulkan1)"

DEPENDS="$(IFS=', '; echo "${deps[*]}")"
SUGGESTS="nvidia-driver-535 | nvidia-driver-550 | mesa-vulkan-drivers | vulkan-tools"
RECOMMENDS="xdg-utils"

# ── DEBIAN/control ───────────────────────────────────────────────────────
INSTALLED_SIZE="$(du -sk "$STAGE/opt" | cut -f1)"
say "Installed size: $((INSTALLED_SIZE / 1024)) MB"

cat > "$STAGE/DEBIAN/control" <<EOF
Package: $PKG_NAME
Version: $VERSION
Section: sound
Priority: optional
Architecture: $ARCH
Depends: ${DEPENDS}
Recommends: ${RECOMMENDS}
Suggests: ${SUGGESTS}
Installed-Size: $INSTALLED_SIZE
Maintainer: HOT-Step CPP packaging <packaging@localhost>
Description: Local AI music generation
 HOT-Step CPP generates music on your own machine: you give it a style caption
 and lyrics, and it renders stereo audio with no cloud, API key or subscription.
 .
 The package contains the C++/GGML engine (built with CUDA for sm_61 and with a
 Vulkan backend), the Node server, the prebuilt web interface and a small
 Electron desktop shell. Launch hot-step for the app window, or hot-step-server
 for a headless server.
 .
 Models are not bundled. Open the Model Manager on first launch and download a
 starter pack.
 .
 Application files live in /opt and are read-only. Your models, songs,
 database and logs live in /var/lib/hot-step-cpp.
EOF

install -m 0755 "$HERE/postinst" "$STAGE/DEBIAN/postinst"
install -m 0755 "$HERE/prerm"   "$STAGE/DEBIAN/prerm"
install -m 0755 "$HERE/postrm"  "$STAGE/DEBIAN/postrm"

cat > "$STAGE/DEBIAN/conffiles" <<EOF
/etc/hot-step-cpp/hot-step.env
EOF

# ── Build ────────────────────────────────────────────────────────────────
mkdir -p "$OUTPUT"
DEB="$OUTPUT/${PKG_NAME}_${VERSION}_${ARCH}.deb"
rm -f "$DEB"
say "Writing $DEB"
dpkg-deb --root-owner-group --build "$STAGE" "$DEB" >/dev/null

if command -v lintian >/dev/null 2>&1; then
    say "lintian"
    lintian "$DEB" || true
fi

say "Done: $DEB ($(du -h "$DEB" | cut -f1))"
[ "$KEEP_STAGE" = "1" ] && say "Staging tree kept at $STAGE"

printf '\nInstall with:\n  sudo dpkg -i %s\n\nThen:\n  hot-step\n\n' "$DEB"
exit 0