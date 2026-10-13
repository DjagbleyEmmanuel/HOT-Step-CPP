// yue2-clip-non-finite-test.cpp -- S2d-1 gate 3 (RESEARCH/YUE2_S2D_TOLERANCES.md):
//
// Case "inf": a gradient containing one non-finite value must still fail
// Yue2AitkTrainState::clip_gradients() with "non-finite gradient before
// clipping", on both the device path (default) and the host rollback
// (YUE2_AITK_CLIP_HOST=1).
//
// Case "huge": a gradient containing one *finite* but extreme value (1e20)
// must NOT be rejected -- squaring it in F32 (1e40) would overflow to inf,
// which is why clip_gradients_device() normalizes by the global max |value|
// before squaring instead of squaring raw values. Checks the device path's
// reported norm against the host path's (F64 accumulation, no overflow
// concern) within a tight relative tolerance.
//
// Case "clipped": max_norm is set below the gradient's actual norm (with
// pre_scale != 1), so the clip must actually engage (scale < 1), unlike the
// gate recipes' real runs where every observed gradient_norm stayed under
// their max_norm. Checks the post-clip gradient's norm lands at max_norm.

#include "train/yue2-aitk-train-state.h"

#include "ggml.h"
#include "ggml-backend.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <string>
#include <vector>

namespace {

struct Result { bool ok; double norm; double post_norm; std::string error; };

// Puts the backend's own env var exactly where clip_gradients() reads it
// (a static local, latched on first call), so each (path, case) combination
// needs its own process.
Result run_one(bool host_path, const std::string & kase) {
#ifdef _WIN32
    _putenv_s("YUE2_AITK_CLIP_HOST", host_path ? "1" : "");
#else
    if (host_path) setenv("YUE2_AITK_CLIP_HOST", "1", 1); else unsetenv("YUE2_AITK_CLIP_HOST");
#endif
    ggml_backend_load_all();
    ggml_backend_dev_t cpu_dev = ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_CPU);
    if (!cpu_dev) return {false, 0.0, 0.0, "no CPU device found"};
    ggml_backend_t backend = ggml_backend_dev_init(cpu_dev, nullptr);
    if (!backend) return {false, 0.0, 0.0, "cpu backend init failed"};

    Yue2AitkTrainState state;
    std::string error;
    // cursor=true gives one plain 2048x2048 gradient slot via
    // cursor_gradient(), with no adapter plumbing needed to reach it.
    if (!state.initialize(backend, Yue2AitkTrainState::kDefaultSeed, &error, /*cursor=*/true)) {
        ggml_backend_free(backend);
        return {false, 0.0, 0.0, "initialize failed: " + error};
    }

    ggml_tensor * grad = state.cursor_gradient();
    const size_t n = ggml_nelements(grad);
    std::vector<float> values(n, 0.01f);
    float max_norm = 1e30f;   // huge: never clips, so the reported norm is the raw value
    float pre_scale = 1.0f;
    if (kase == "inf") {
        values[n / 2] = std::numeric_limits<float>::infinity();
    } else if (kase == "huge") {
        values[n / 2] = 1e20f;
    } else if (kase == "clipped") {
        // Uniform 2.0 everywhere: length = pre_scale * 2.0 * sqrt(n), well
        // above max_norm, so the clip must actually engage.
        std::fill(values.begin(), values.end(), 2.0f);
        pre_scale = 0.5f;
        max_norm = 1.0f;
    }
    ggml_backend_tensor_set(grad, values.data(), 0, ggml_nbytes(grad));

    double norm = 0.0;
    std::string clip_error;
    const bool ok = state.clip_gradients(max_norm, &norm, &clip_error, pre_scale);

    double post_norm = 0.0;
    if (ok) {
        std::vector<float> after(n);
        ggml_backend_tensor_get(grad, after.data(), 0, ggml_nbytes(grad));
        double sq = 0.0;
        for (float v : after) sq += double(v) * double(v);
        post_norm = std::sqrt(sq);
    }
    ggml_backend_free(backend);
    return {ok, norm, post_norm, clip_error};
}

} // namespace

int main(int argc, char ** argv) {
    const char * which_path = std::getenv("YUE2_CLIP_TEST_PATH");
    const char * which_case = std::getenv("YUE2_CLIP_TEST_CASE");
    if (which_path && which_case) {
        const bool host_path = std::string(which_path) == "host";
        const std::string kase = which_case;
        const Result r = run_one(host_path, kase);
        const char * path_name = host_path ? "host" : "device";
        if (kase == "huge") {
            // Expect success, norm close to the injected 1e20 (the other
            // 2048*2048-1 elements at 0.01 contribute negligibly).
            if (!r.ok) { std::fprintf(stderr, "FAIL (%s/huge): rejected a finite gradient: %s\n", path_name, r.error.c_str()); return 1; }
            const double rel = std::fabs(r.norm - 1e20) / 1e20;
            if (!std::isfinite(r.norm) || rel > 1e-5) { std::fprintf(stderr, "FAIL (%s/huge): norm=%.6g (rel diff %.3g)\n", path_name, r.norm, rel); return 1; }
            std::printf("PASS (%s/huge): norm=%.6g (rel diff %.3g to 1e20)\n", path_name, r.norm, rel);
            return 0;
        } else if (kase == "clipped") {
            // pre_scale=0.5, uniform 2.0 -> pre-clip length = 0.5*2.0*sqrt(n);
            // max_norm=1.0 is far below that, so the clip must engage and
            // the post-clip gradient's own norm must land at ~max_norm.
            if (!r.ok) { std::fprintf(stderr, "FAIL (%s/clipped): rejected a finite gradient: %s\n", path_name, r.error.c_str()); return 1; }
            const double rel_to_max = std::fabs(r.post_norm - 1.0) / 1.0;
            if (!std::isfinite(r.post_norm) || rel_to_max > 1e-4) { std::fprintf(stderr, "FAIL (%s/clipped): post-clip norm=%.6g (expected ~1.0)\n", path_name, r.post_norm); return 1; }
            std::printf("PASS (%s/clipped): pre-clip norm=%.6g, post-clip norm=%.6g (expected ~1.0)\n", path_name, r.norm, r.post_norm);
            return 0;
        } else {
            if (r.ok) { std::fprintf(stderr, "FAIL (%s/inf): accepted a non-finite gradient\n", path_name); return 1; }
            if (r.error != "non-finite gradient before clipping") { std::fprintf(stderr, "FAIL (%s/inf): wrong error message: %s\n", path_name, r.error.c_str()); return 1; }
            std::printf("PASS (%s/inf): clip_gradients rejected the non-finite gradient (\"%s\")\n", path_name, r.error.c_str());
            return 0;
        }
    }

    const std::string self = argv[0];
    bool all_ok = true;
    for (const char * path : {"device", "host"}) {
        for (const char * kase : {"inf", "huge", "clipped"}) {
#ifdef _WIN32
            _putenv_s("YUE2_CLIP_TEST_PATH", path);
            _putenv_s("YUE2_CLIP_TEST_CASE", kase);
#else
            setenv("YUE2_CLIP_TEST_PATH", path, 1);
            setenv("YUE2_CLIP_TEST_CASE", kase, 1);
#endif
            const int rc = std::system(("\"" + self + "\"").c_str());
            if (rc != 0) { std::fprintf(stderr, "child (%s/%s) failed (rc=%d)\n", path, kase, rc); all_ok = false; }
        }
    }
    return all_ok ? 0 : 1;
}
