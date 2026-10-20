// Unit test for monitor_run_chain: every stage in the chain must be heard.
#include "../tools/monitor-chain.h"
#include <cmath>
#include <cstdio>
#include <functional>
#include <vector>

static int run_case(const std::vector<float> & gains, int n) {
    std::vector<float> sL(n), sR(n), bL(n), bR(n), oL(n), oR(n);
    for (int i = 0; i < n; i++) { sL[i] = 0.001f * (float)(i % 97 + 1); sR[i] = -sL[i]; }
    std::vector<float> refL = sL;
    float want = 1.0f;
    for (float g : gains) want *= g;
    monitor_run_chain(sL.data(), sR.data(), bL.data(), bR.data(), oL.data(), oR.data(), n, 4096,
        gains.size(), [&](size_t pi, float * iL, float * iR, float * dL, float * dR, int c, int) {
            for (int k = 0; k < c; k++) { dL[k] = iL[k] * gains[pi]; dR[k] = iR[k] * gains[pi]; }
        });
    double worst = 0; float got = 0;
    for (int i = 0; i < n; i++) {
        float r = oL[i] / refL[i];
        double e = std::fabs(r - want);
        if (e > worst) { worst = e; got = r; }
        e = std::fabs(oR[i] / -refL[i] - want);
        if (e > worst) { worst = e; got = oR[i] / -refL[i]; }
    }
    bool ok = worst < 1e-4 * want;
    printf("%s: stages=%zu n=%d want x%g worst got x%g\n", ok ? "PASS" : "FAIL", gains.size(), n, want,
           worst == 0 ? want : got);
    return ok ? 0 : 1;
}

// Non-commutative stages: stage k computes y = x * g[k] + (k + 1), so the
// expected output depends on stage order. With in_place, out aliases src.
static int run_order_case(const std::vector<float> & gains, int n, bool in_place) {
    std::vector<float> sL(n), sR(n), bL(n), bR(n), oL(n), oR(n);
    for (int i = 0; i < n; i++) { sL[i] = 0.001f * (float)(i % 97 + 1); sR[i] = -sL[i]; }
    std::vector<double> wantL(n), wantR(n);
    for (int i = 0; i < n; i++) {
        double l = sL[i], r = sR[i];
        for (size_t k = 0; k < gains.size(); k++) { l = l * gains[k] + (double)(k + 1); r = r * gains[k] + (double)(k + 1); }
        wantL[i] = l; wantR[i] = r;
    }
    float * outL = in_place ? sL.data() : oL.data();
    float * outR = in_place ? sR.data() : oR.data();
    monitor_run_chain(sL.data(), sR.data(), bL.data(), bR.data(), outL, outR, n, 4096,
        gains.size(), [&](size_t pi, float * iL, float * iR, float * dL, float * dR, int c, int) {
            for (int k = 0; k < c; k++) {
                dL[k] = iL[k] * gains[pi] + (float)(pi + 1);
                dR[k] = iR[k] * gains[pi] + (float)(pi + 1);
            }
        });
    double worst = 0; int at = 0; double gotv = 0, wantv = 0;
    for (int i = 0; i < n; i++) {
        double e = std::fabs(outL[i] - wantL[i]);
        if (e > worst) { worst = e; at = i; gotv = outL[i]; wantv = wantL[i]; }
        e = std::fabs(outR[i] - wantR[i]);
        if (e > worst) { worst = e; at = i; gotv = outR[i]; wantv = wantR[i]; }
    }
    bool ok = worst < 1e-3;
    printf("%s: order stages=%zu n=%d in_place=%d worst |err|=%g at %d (got %g want %g)\n", ok ? "PASS" : "FAIL",
           gains.size(), n, in_place ? 1 : 0, worst, at, gotv, wantv);
    return ok ? 0 : 1;
}

int main() {
    int f = 0;
    f += run_case({2, 3, 5}, 512);
    f += run_case({2, 3, 5}, 9000);
    f += run_case({2, 3, 5, 7}, 9000);
    f += run_case({4}, 9000);
    f += run_case({}, 9000);
    f += run_order_case({2, 3, 5}, 9000, false);
    f += run_order_case({2, 3, 5, 7}, 9000, true);
    f += run_order_case({}, 9000, true);
    printf("%d failure(s)\n", f);
    return f ? 1 : 0;
}
