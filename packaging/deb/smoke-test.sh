#!/usr/bin/env bash
# smoke-test.sh - verify a built HOT-Step CPP package actually runs.
#
# Two tiers:
#   1. engine  - boots ace-server against header-only stub GGUFs and hits the
#                endpoints the UI calls on load. Same test upstream CI runs
#                (release.yml, "Smoke test packaged engine"). Needs no GPU, no
#                real weights and no network. This is what catches binaries that
#                link green but die on startup, or die on the first request.
#   2. app     - starts the Node server and checks it serves the UI, answers
#                /api/health, and that state landed in /var/lib rather than
#                /opt. Run this after installing the package.
#
# Usage:
#   smoke-test.sh engine /opt/hot-step-cpp
#   smoke-test.sh app
#   smoke-test.sh all            (engine against the installed prefix, then app)

set -uo pipefail

PREFIX=/opt/hot-step-cpp
STATE=/var/lib/hot-step-cpp
WORK="$(mktemp -d "${TMPDIR:-/var/tmp}/hotstep-smoke-XXXXXX")"
pass=0; fail=0

cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

ok()   { printf '  \033[1;32mPASS\033[0m  %s\n' "$*"; pass=$((pass + 1)); }
bad()  { printf '  \033[1;31mFAIL\033[0m  %s\n' "$*"; fail=$((fail + 1)); }
head_() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }

# ── Tier 1: engine ───────────────────────────────────────────────────────
test_engine() {
    local prefix="$1"
    head_ "Engine: $prefix/engine/ace-server"

    if [ ! -x "$prefix/engine/ace-server" ]; then
        bad "ace-server missing or not executable"
        return 1
    fi
    ok "ace-server present"

    # Every shared library the packaged binaries need must resolve, or the app
    # dies at startup with a dlopen error the user only sees in a log file.
    local unresolved
    unresolved="$(ldd "$prefix"/engine/* 2>/dev/null | grep -c 'not found')"
    if [ "$unresolved" -eq 0 ]; then
        ok "all shared libraries resolve"
    else
        bad "$unresolved unresolved shared library reference(s)"
        ldd "$prefix"/engine/* 2>/dev/null | grep 'not found' | sort -u | sed 's/^/        /'
    fi

    # Dynamic ggml backends must be sitting next to the executable: ace-server
    # dlopen()s them by name relative to argv[0], and a wrong prefix gives a
    # "no backend" engine that silently runs on the CPU.
    local backends=""
    [ -f "$prefix/engine/libggml-cuda.so" ] && backends="$backends cuda"
    [ -f "$prefix/engine/libggml-vulkan.so" ] && backends="$backends vulkan"
    [ -f "$prefix/engine/libggml-cpu.so" ] && backends="$backends cpu"
    if [ -n "$backends" ]; then
        ok "ggml backends present:$backends"
    else
        bad "no ggml backend shared objects found"
    fi

    # Stub GGUFs: header only, classified by general.architecture. /props reads
    # the catalogue without loading a model, so this works with no weights.
    mkdir -p "$WORK/smoke-models"
    python3 - "$WORK/smoke-models" <<'PYEOF'
import struct, sys, os
out = sys.argv[1]
def s(x):
    b = x.encode()
    return struct.pack('<Q', len(b)) + b
for arch in ['acestep-lm', 'acestep-dit', 'acestep-text-enc', 'acestep-vae']:
    d = b'GGUF' + struct.pack('<I', 3) + struct.pack('<Q', 0) + struct.pack('<Q', 1)
    d += s('general.architecture') + struct.pack('<I', 8) + s(arch)
    open(os.path.join(out, 'stub-%s.gguf' % arch), 'wb').write(d)
PYEOF
    [ $? -eq 0 ] && ok "stub models written" || { bad "could not write stub models"; return 1; }

    local port=18085
    LD_LIBRARY_PATH="$prefix/engine:${LD_LIBRARY_PATH:-}" \
        "$prefix/engine/ace-server" --models "$WORK/smoke-models" --host 127.0.0.1 --port $port \
        > "$WORK/engine.log" 2>&1 &
    local pid=$!

    local healthy=0
    for _ in $(seq 1 60); do
        sleep 1
        kill -0 $pid 2>/dev/null || break
        if curl -sf -m 2 "http://127.0.0.1:$port/health" >/dev/null 2>&1; then
            healthy=1; break
        fi
    done
    if [ "$healthy" = 1 ]; then
        ok "engine healthy on 127.0.0.1:$port"
    else
        bad "engine never became healthy"
        sed 's/^/        /' "$WORK/engine.log" | tail -30
        kill $pid 2>/dev/null; return 1
    fi

    for ep in health props plugins props; do
        if curl -sf -m 10 "http://127.0.0.1:$port/$ep" >/dev/null 2>&1; then
            ok "GET /$ep"
        else
            bad "GET /$ep failed"
        fi
    done

    sleep 2
    if kill -0 $pid 2>/dev/null; then
        ok "engine still alive after serving requests"
    else
        bad "engine died after serving requests"
    fi

    # Which backend did it actually pick? Worth knowing: a CUDA build that
    # falls back to CPU looks identical from the UI.
    echo "--- engine backend report ---"
    grep -iE 'cuda|vulkan|backend|device' "$WORK/engine.log" | head -12 | sed 's/^/        /'
    echo "-----------------------------"

    kill $pid 2>/dev/null
    wait $pid 2>/dev/null
}

# ── Tier 2: installed app ────────────────────────────────────────────────
test_app() {
    head_ "App: $STATE"

    if [ ! -x /usr/bin/hot-step ]; then
        bad "/usr/bin/hot-step not installed"
        return 1
    fi
    ok "launcher installed"

    for p in "$PREFIX/server/server.mjs" "$PREFIX/server/boot.mjs" "$PREFIX/runtime/bin/node" \
             "$PREFIX/ui/dist/index.html" "$PREFIX/engine/ace-train" \
             "$PREFIX/engine/ace-caption"; do
        if [ -e "$p" ]; then ok "present: ${p#$PREFIX/}"; else bad "missing: ${p#$PREFIX/}"; fi
    done

    # Desktop integration: without the .desktop entry and icons the package
    # installs perfectly and the app is still invisible in the desktop menu.
    if [ -f /usr/share/applications/hot-step-cpp.desktop ]; then
        ok ".desktop entry installed"
        if grep -qE "^Exec=hot-step$" /usr/share/applications/hot-step-cpp.desktop; then
            ok ".desktop Exec points at the desktop launcher"
        else
            bad ".desktop Exec is not hot-step"
        fi
    else
        bad "no .desktop entry - the app will not appear in your menu"
    fi
    local nicon
    nicon="$(find /usr/share/icons/hicolor -name 'hot-step-cpp.png' 2>/dev/null | wc -l)"
    if [ "$nicon" -ge 4 ]; then
        ok "$nicon icon sizes installed"
    else
        bad "only $nicon icon sizes installed (want at least 4)"
    fi
    if [ -x "$PREFIX/desktop/hot-step-cpp" ] && [ -f "$PREFIX/desktop/app/src/main.js" ]; then
        ok "desktop shell present"
    else
        bad "desktop shell missing (this is the browser-only build)"
    fi
    if [ -u "$PREFIX/desktop/chrome-sandbox" ]; then
        ok "Chromium sandbox is setuid (required by Electron)"
    else
        bad "chrome-sandbox is not setuid - Electron will refuse to sandbox"
    fi

    # The whole point of the /opt + /var/lib split: /opt must stay read-only.
    if find "$PREFIX" -newer "$PREFIX/VERSION" -type f -writable 2>/dev/null | grep -q .; then
        bad "writable files found under /opt (state is leaking into the prefix)"
    else
        ok "/opt/hot-step-cpp is read-only"
    fi

    # Read the port the launcher will actually use. It comes from
    # /etc/hot-step-cpp/hot-step.env, which the launcher parses into the
    # environment; a hardcoded 3001 reports a false failure whenever the
    # package has been given a different port.
    local port
    port="$(sed -n 's/^SERVER_PORT=//p' /etc/hot-step-cpp/hot-step.env 2>/dev/null | tail -1)"
    [ -n "$port" ] || port=3001
    say "  (server port $port, engine tier uses 18085)"
    /usr/bin/hot-step --no-browser > "$WORK/app.log" 2>&1 &
    local pid=$!

    local up=0
    for _ in $(seq 1 90); do
        sleep 1
        kill -0 $pid 2>/dev/null || break
        if curl -sf -m 2 "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then
            up=1; break
        fi
    done

    if [ "$up" = 1 ]; then
        ok "server healthy on 127.0.0.1:$port"
    else
        bad "server never became healthy"
        sed 's/^/        /' "$WORK/app.log" | tail -40
        kill $pid 2>/dev/null; return 1
    fi

    for ep in /api/health /api/version /api/plugins; do
        if curl -sf -m 10 "http://127.0.0.1:$port$ep" >/dev/null 2>&1; then
            ok "GET $ep"
        else
            bad "GET $ep failed"
        fi
    done

    if curl -sf -m 10 "http://127.0.0.1:$port/" | grep -qi '<html\|<div id="root"'; then
        ok "UI served at /"
    else
        bad "UI not served at /"
    fi

    # The engine is a child process. It exits with "no models found" when the
    # models directory is empty, which is the correct state before the Model
    # Manager has downloaded anything - so only assert on it when models exist.
    #
    # Ask the app where it is actually looking rather than assuming the default,
    # because ACESTEPCPP_MODELS may be pointed at an external folder.
    local models_dir
    # The API reports only what is in the app's own .env; /etc wins at runtime,
    # so fall back to the system config before giving up.
    #
    # Parsed with python, not sed: the value comes back with its surrounding
    # quotes escaped into the JSON ("ACESTEPCPP_MODELS":"\/media\/..."), so a
    # [^"]* capture yields a lone backslash instead of the path.
    models_dir="$(curl -sf -m 5 "http://127.0.0.1:$port/api/settings/env" 2>/dev/null | python3 -c '
import json, sys
try:
    v = json.load(sys.stdin).get("values", {}).get("ACESTEPCPP_MODELS", "")
except Exception:
    v = ""
print(v.strip().strip("\"'"'"'"))
' 2>/dev/null)"
    if [ -z "$models_dir" ]; then
        models_dir="$(sed -n 's/^[[:space:]]*ACESTEPCPP_MODELS=//p' /etc/hot-step-cpp/hot-step.env 2>/dev/null | tail -1)"
        models_dir="${models_dir%\"}"
        models_dir="${models_dir#\"}"
    fi
    [ -n "$models_dir" ] || models_dir="$STATE/models"
    local nmodels
    nmodels="$(find "$models_dir" -maxdepth 1 -iname '*.gguf' 2>/dev/null | wc -l)"
    if [ "$nmodels" -gt 0 ]; then
        if pgrep -x ace-server >/dev/null 2>&1; then
            ok "engine running against $models_dir ($nmodels .gguf)"
        else
            bad "ace-server not running with $nmodels model(s) present in $models_dir"
        fi
    else
        echo "  SKIP  engine process - $models_dir has no .gguf yet (expected before the"
        echo "        Model Manager downloads a pack; use the engine tier for a"
        echo "        model-free boot check)"
    fi

    # State must be in /var/lib, and the symlink redirect must have held.
    # Upstream's data-root subsystem (server/src/dataroot) owns the layout:
    # <root>/library, /models, /adapters, /settings/.env, /logs, /tools. The
    # launchers pin HOT_STEP_DATA_ROOT at /var/lib/hot-step-cpp because the
    # default would be <parent of app>/HOT-Step-Data, which is read-only under
    # /opt and stops the app outright.
    for d in library models adapters settings logs tools; do
        if [ -d "$STATE/$d" ]; then
            ok "data root dir $d/ present under $STATE"
        else
            bad "missing $STATE/$d - data root not laid out"
        fi
    done
    if [ -f "$STATE/settings/.env" ]; then
        ok "user settings file present ($STATE/settings/.env)"
    else
        bad "no settings/.env - the Settings screen will not save anything"
    fi
    # The marker the data-root subsystem writes; its absence means the folder
    # is not a recognised data layout.
    if [ -f "$STATE/hot-step-data.json" ]; then
        ok "data-root marker present"
    else
        bad "no hot-step-data.json marker in $STATE"
    fi

    # Every writable path must be a symlink into /var/lib, not a real directory
    # under /opt. `test -w` follows symlinks, so checking writability here
    # would report the intended design as a failure.
    for p in data models adapters logs; do
        if [ -L "$PREFIX/$p" ] && [ -e "$PREFIX/$p" ]; then
            ok "writable path $p/ -> $(readlink "$PREFIX/$p")"
        else
            bad "/opt/hot-step-cpp/$p is not a symlink into /var/lib"
        fi
    done

    echo "--- server log tail ---"
    tail -25 "$WORK/app.log" | sed 's/^/        /'
    echo "-----------------------"

    kill $pid 2>/dev/null
    sleep 3
    pkill -x ace-server 2>/dev/null
    wait $pid 2>/dev/null

    # Nothing left behind: the whole point of the shell owning the server is
    # that closing the app leaves no listener and no process holding the GPU.
    sleep 2
    if ss -ltn 2>/dev/null | grep -q ":$port "; then
        bad "port $port still listening after shutdown - the server was orphaned"
    else
        ok "port $port released after shutdown"
    fi
    if pgrep -x ace-server >/dev/null 2>&1; then
        bad "ace-server survived shutdown - it may still be holding VRAM"
        pkill -x ace-server 2>/dev/null
    else
        ok "engine stopped with the server"
    fi
}

# ── main ─────────────────────────────────────────────────────────────────
what="${1:-all}"; shift 2>/dev/null || true
prefix="${1:-$PREFIX}"

case "$what" in
    engine) test_engine "$prefix" ;;
    app)    test_app ;;
    all)    test_engine "$prefix"; test_app ;;
    *) echo "usage: $0 [engine|app|all] [prefix]" >&2; exit 2 ;;
esac

printf '\n\033[1m%s passed, %s failed\033[0m\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1