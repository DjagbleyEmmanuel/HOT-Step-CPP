#pragma once
#include "codec-flow.h"

namespace heartcodec {

inline ggml_tensor * scalar_conv(ggml_context * c, const Weights & w, const std::string & p,
                                 ggml_tensor * x, int dilation = 1, bool causal = true) {
    int pad = int(w.get(p + ".weight")->ne[0] - 1) * dilation;
    if (causal && pad) x = ggml_pad_ext(c, x, pad, 0, 0, 0, 0, 0, 0, 0);
    return conv(c, w, p, x, causal ? 0 : pad / 2, dilation);
}

inline ggml_tensor * prelu(ggml_context * c, const Weights & w, const std::string & p, ggml_tensor * x) {
    auto weight = w.get(p + ".weight");
    require(ggml_nelements(weight) == 1, p + ": expected scalar PReLU");
    float slope;
    ggml_backend_tensor_get(weight, &slope, 0, sizeof(slope));
    return ggml_leaky_relu(c, x, slope, false);
}

inline ggml_tensor * scalar_graph(Graph & g, const Weights & w, ggml_tensor * input) {
    auto c = g.ctx;
    const std::string p = "scalar_model.decoder.";
    auto x = scalar_conv(c, w, p + "0", input, 1, false);
    constexpr int strides[] = {5, 4, 4, 4, 3};
    constexpr int dilations[] = {1, 3, 5, 7, 9};
    for (int b = 0; b < 5; ++b) {
        std::string bp = p + std::to_string(b + 1);
        auto kernel = w.get(bp + ".up_conv.layer.weight");
        int stride = strides[b];
        require(kernel->ne[0] == 2 * stride && kernel->ne[2] == x->ne[1], bp + ": invalid transposed convolution");
        // Causal transposed convolution has no symmetric padding. Trim only
        // its final stride, exactly as the reference ConvTranspose1d wrapper.
        x = ggml_conv_transpose_1d(c, kernel, x, stride, 0, 1);
        x = ggml_cont(c, ggml_view_2d(c, x, x->ne[0] - stride, x->ne[1], x->nb[1], 0));
        if (auto bias = w.optional(bp + ".up_conv.layer.bias"))
            x = ggml_add(c, x, ggml_reshape_2d(c, bias, 1, bias->ne[0]));
        for (int r = 0; r < 5; ++r) {
            std::string rp = bp + ".convs." + std::to_string(r);
            auto skip = x;
            x = scalar_conv(c, w, rp + ".conv1", x, dilations[r]);
            x = prelu(c, w, rp + ".activation1", x);
            x = scalar_conv(c, w, rp + ".conv2", x);
            x = prelu(c, w, rp + ".activation2", x);
            x = ggml_add(c, skip, x);
        }
    }
    // PostProcessor repeats every sample twice before its causal convolution.
    int64_t time = x->ne[0], channels = x->ne[1];
    x = ggml_reshape_3d(c, x, 1, time, channels);
    x = ggml_repeat(c, x, ggml_new_tensor_3d(c, GGML_TYPE_F32, 2, time, channels));
    x = ggml_reshape_2d(c, x, 2 * time, channels);
    x = scalar_conv(c, w, p + "6.conv", x);
    x = prelu(c, w, p + "6.activation", x);
    return scalar_conv(c, w, p + "7", x);
}

// Input is the flow's [time,256], split into two independent 128-wide channels.
// Output is planar stereo [2,time*1920] at 48 kHz.
inline std::vector<float> scalar_decode(const Weights & w, ggml_backend_t backend,
                                        const std::vector<float> & latent, int64_t frames,
                                        const Cancel & cancelled = {}) {
    require(frames > 0 && latent.size() == size_t(frames * 256), "invalid scalar latent shape");
    std::vector<float> result;
    for (int ch = 0; ch < 2; ++ch) {
        require(!cancelled || !cancelled(), "cancelled");
        std::vector<float> planar(size_t(frames * 128));
        for (int d = 0; d < 128; ++d) for (int64_t t = 0; t < frames; ++t) {
            // torch.round uses ties-to-even, including negative half-integers.
            planar[size_t(d * frames + t)] = std::nearbyint(9.0f * latent[size_t(t * 256 + ch * 128 + d)]) / 9.0f;
        }
        Graph g(backend);
        auto input = g.input(GGML_TYPE_F32, {frames, 128}, planar.data());
        auto channel = g.run(scalar_graph(g, w, input));
        require(channel.size() == size_t(frames * 1920), "unexpected scalar waveform length");
        result.insert(result.end(), channel.begin(), channel.end());
    }
    return result;
}

} // namespace heartcodec
