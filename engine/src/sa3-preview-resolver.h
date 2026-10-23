// sa3-preview-resolver.h: SA3 training snapshot -> adapter spec for /sa3-synth.
//
// Checkpoint previews render a trainer inference export
//   <adapters>/sa3-medium/<dataset>/<adapter>/<stamp>/snapshots/step-N.gguf
// (train/sa3-train-run.h, --export-every). This is an internal path beside the
// public adapter names: models/sa3-adapters/<name>.gguf and its name parser
// and catalogue are untouched, and snapshots never appear in /sa3/props.
//
// Bounds, in order:
//   - run = "<dataset>/<adapter>/<stamp>" with the server's slug, adapterName
//     and run-stamp charsets; step = positive decimal. No separators beyond
//     those two slashes, so no "..", no drive letters, no absolute paths.
//   - the canonical file (symlinks and junctions resolved) must be a regular
//     file under the canonical <adapters>/sa3-medium root.
//   - the GGUF is a dora-rows-v1 sa3-adapter whose sa3.inference_base_id
//     names the sha256 of the DiT this request loads (wrong base = 400).
//   - the ModelKey carries the snapshot's content sha256, so a step file
//     rewritten in place loads fresh instead of reusing the cached merge.

#pragma once

#include "train/yue2-aitk-sha256.h"

#include "gguf.h"

#include <filesystem>
#include <map>
#include <mutex>
#include <regex>
#include <string>
#include <tuple>

static std::string sa3_preview_sha(const std::filesystem::path & p) {
    yue2_aitk::sha256::digest d;
    return yue2_aitk::sha256::file(p, d) ? d.hex() : std::string();
}

// The DiT is ~3 GB: hash once per (size, mtime), not per preview.
static std::string sa3_preview_dit_sha(const std::filesystem::path & p) {
    static std::mutex                                                              mtx;
    static std::map<std::string, std::tuple<uintmax_t, int64_t, std::string>>     cache;
    std::error_code ec;
    const uintmax_t size  = std::filesystem::file_size(p, ec);
    if (ec) return {};
    const int64_t   mtime = (int64_t) std::filesystem::last_write_time(p, ec).time_since_epoch().count();
    if (ec) return {};
    std::lock_guard<std::mutex> lock(mtx);
    auto it = cache.find(p.u8string());
    if (it != cache.end() && std::get<0>(it->second) == size && std::get<1>(it->second) == mtime)
        return std::get<2>(it->second);
    std::string sha = sa3_preview_sha(p);
    if (!sha.empty()) cache[p.u8string()] = { size, mtime, sha };
    return sha;
}

static std::string sa3_preview_gguf_str(const gguf_context * g, const char * key) {
    const int64_t i = gguf_find_key(g, key);
    return (i >= 0 && gguf_get_kv_type(g, i) == GGUF_TYPE_STRING) ? gguf_get_val_str(g, i) : "";
}

// Resolve one snapshot. On success fills `path` (canonical, for the loader)
// and `sig` (the adapter_stack entry, content hash included) and returns "".
// Otherwise returns the client-facing error.
// ponytail: hash-then-load is not atomic; a step file swapped between the two
// loads the new bytes under the old key. Snapshots are write-once per step.
static std::string sa3_resolve_snapshot(const char * adapters_dir, const std::string & run, const std::string & step,
                                        const std::string & dit_path, float scale, std::string & path,
                                        std::string & sig) {
    namespace fs = std::filesystem;
    if (!adapters_dir || !*adapters_dir) return "SA3 snapshots need the engine's --adapters directory";
    static const std::regex run_re("[A-Za-z0-9][A-Za-z0-9_-]{0,127}/[A-Za-z0-9][A-Za-z0-9_-]{0,63}/[0-9][0-9_-]{0,63}");
    static const std::regex step_re("[1-9][0-9]{0,8}");
    if (!std::regex_match(run, run_re)) return "Invalid snapshot_run (expected <dataset>/<adapter>/<stamp>)";
    if (!std::regex_match(step, step_re)) return "Invalid snapshot_step (expected a positive integer)";

    std::error_code ec;
    const fs::path root = fs::canonical(fs::u8path(adapters_dir) / "sa3-medium", ec);
    if (ec) return "No SA3 training runs under the adapters directory";
    const fs::path file = fs::canonical(fs::u8path(adapters_dir) / "sa3-medium" / fs::u8path(run) / "snapshots" /
                                            ("step-" + step + ".gguf"), ec);
    if (ec || !fs::is_regular_file(file, ec)) return "SA3 snapshot not found: " + run + " step " + step;
    // Component-wise containment: a sibling such as "sa3-medium-x" must not pass.
    auto r = root.begin(), f = file.begin();
    for (; r != root.end(); ++r, ++f)
        if (f == file.end() || *r != *f) return "SA3 snapshot resolves outside the training runs";

    gguf_init_params gp = { /*no_alloc=*/true, /*ctx=*/nullptr };
    gguf_context *   g  = gguf_init_from_file(file.u8string().c_str(), gp);
    if (!g) return "SA3 snapshot is not a readable GGUF";
    const std::string arch = sa3_preview_gguf_str(g, "general.architecture");
    const std::string fmt  = sa3_preview_gguf_str(g, "sa3.adapter_format");
    const std::string base = sa3_preview_gguf_str(g, "sa3.inference_base_id");
    gguf_free(g);
    if (arch != "sa3-adapter" || fmt != "dora-rows-v1") return "SA3 snapshot is not a dora-rows-v1 inference export";

    const std::string dit_sha = sa3_preview_dit_sha(fs::u8path(dit_path));
    if (dit_sha.empty()) return "Cannot hash the SA3 generation DiT";
    if (base != "stabilityai/stable-audio-3-medium sha256:" + dit_sha)
        return "SA3 snapshot was exported for a different DiT (" + base + "), not " + fs::u8path(dit_path).filename().u8string();

    const std::string snap_sha = sa3_preview_sha(file);
    if (snap_sha.empty()) return "Cannot read the SA3 snapshot";
    path = file.u8string();
    // model-store parses "path=scale" entries; the "#sha256:" entry has no '='
    // so the parser skips it, but it is still part of the cache key.
    sig  = path + "=" + std::to_string(scale) + ";#sha256:" + snap_sha;
    return "";
}
