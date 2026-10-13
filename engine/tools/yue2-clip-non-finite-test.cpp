// yue2-clip-non-finite-test.cpp -- S2d-1 gate 3 (RESEARCH/YUE2_S2D_TOLERANCES.md):
// a gradient containing one non-finite value must still fail
// Yue2AitkTrainState::clip_gradients() with "non-finite gradient before
// clipping", on both the device path (default) and the host rollback
// (YUE2_AITK_CLIP_HOST=1). The device path never reads the gradient back
// element-wise; it sums ggml_sqr() on the device and only checks the final
// scalar, so this confirms that sum-of-nonnegative-squares still goes
// non-finite whenever any input does, instead of just asserting it.

#include "train/yue2-aitk-train-state.h"

#include "ggml.h"
#include "ggml-backend.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <string>
#include <vector>

namespace {

// Puts the backend's own env var exactly where clip_gradients() reads it
// (a static local, latched on first call), so each path needs its own
// process. Re-running in-process after setenv would not flip it back.
bool run_one(bool host_path) {
#ifdef _WIN32
    _putenv_s("YUE2_AITK_CLIP_HOST", host_path ? "1" : "");
#else
    if (host_path) setenv("YUE2_AITK_CLIP_HOST", "1", 1); else unsetenv("YUE2_AITK_CLIP_HOST");
#endif
    ggml_backend_load_all();
    ggml_backend_dev_t cpu_dev = ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_CPU);
    if (!cpu_dev) { std::fprintf(stderr, "no CPU device found\n"); return false; }
    ggml_backend_t backend = ggml_backend_dev_init(cpu_dev, nullptr);
    if (!backend) { std::fprintf(stderr, "cpu backend init failed\n"); return false; }

    Yue2AitkTrainState state;
    std::string error;
    // cursor=true gives one plain 2048x2048 gradient slot via
    // cursor_gradient(), with no adapter plumbing needed to reach it.
    if (!state.initialize(backend, Yue2AitkTrainState::kDefaultSeed, &error, /*cursor=*/true)) {
        std::fprintf(stderr, "initialize failed: %s\n", error.c_str());
        ggml_backend_free(backend);
        return false;
    }

    ggml_tensor * grad = state.cursor_gradient();
    const size_t n = ggml_nelements(grad);
    std::vector<float> values(n, 0.01f);
    values[n / 2] = std::numeric_limits<float>::infinity();
    ggml_backend_tensor_set(grad, values.data(), 0, ggml_nbytes(grad));

    double norm = 0.0;
    std::string clip_error;
    const bool ok = state.clip_gradients(1.0f, &norm, &clip_error);
    ggml_backend_free(backend);

    const char * path_name = host_path ? "host" : "device";
    if (ok) {
        std::fprintf(stderr, "FAIL (%s): clip_gradients accepted a non-finite gradient\n", path_name);
        return false;
    }
    if (clip_error != "non-finite gradient before clipping") {
        std::fprintf(stderr, "FAIL (%s): wrong error message: %s\n", path_name, clip_error.c_str());
        return false;
    }
    std::printf("PASS (%s): clip_gradients rejected the non-finite gradient (\"%s\")\n", path_name, clip_error.c_str());
    return true;
}

} // namespace

int main(int argc, char ** argv) {
    // clip_gradients() latches `static const bool host_path` the first time
    // it runs in a process, so the two paths need two processes: re-exec
    // this same binary with an extra arg and read its verdict back as our
    // own child's exit code.
    const char * which = std::getenv("YUE2_CLIP_TEST_WHICH");
    if (which) return run_one(std::string(which) == "host") ? 0 : 1;

    const std::string self = argv[0];
    bool all_ok = true;
    for (const char * leg : {"device", "host"}) {
#ifdef _WIN32
        _putenv_s("YUE2_CLIP_TEST_WHICH", leg);
#else
        setenv("YUE2_CLIP_TEST_WHICH", leg, 1);
#endif
        const int rc = std::system(("\"" + self + "\"").c_str());
        if (rc != 0) { std::fprintf(stderr, "child leg '%s' failed (rc=%d)\n", leg, rc); all_ok = false; }
    }
    return all_ok ? 0 : 1;
}
