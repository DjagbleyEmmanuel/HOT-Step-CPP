#pragma once
// heartmula/adapter.h: runtime LoRA for the HeartMuLa global (backbone) LM.
//
// HOT-Step file. Reads the GGUF written by engine/tools/convert-heartmula-lora.py
// (engine/docs/HEARTMULA_CONTRACT.md, "LoRA adapter"). The factors stay apart from the
// base weights, so one adapter works over any quant of its base:
//
//   y = W x + (alpha / rank) x adapter_scale x B (A x)
//
// The factor math is qwen3-lora.h's (qwen3_linear_lora); this file only loads and
// checks. Targets are backbone q/k/v/output projections; the local decoder is never
// adapted. Accepted only when the variant and base fingerprint equal the loaded
// model's, the component is a global-targeting LoRA, `heartmula.lora.targets` is
// exactly the set of factor tensors present, and every shape fits its base weight.
//
// Every load takes a new id. The LM graph (lm-graph.h) keys its built graphs and its
// KV rows on (id, scale), so switching, reloading or re-scaling the adapter drops them.

#include "heartmula/model.h"
#include "qwen3-lora.h"

#include <atomic>
#include <cmath>
#include <set>
#include <string>
#include <vector>

struct HeartMuLaAdapter {
    WeightCtx                wctx = {};
    std::vector<QwLoraLayer> layers;  // per backbone layer; slots Q/K/V/O, scale = alpha / rank
    int                      rank  = 0;
    float                    alpha = 0.0f;
    uint64_t                 id    = 0;  // 0 = not loaded
    std::string              path, variant, base_fingerprint;
    bool                     loaded() const { return id != 0; }
};

static void heartmula_adapter_free(HeartMuLaAdapter * a) {
    wctx_free(&a->wctx);
    *a = HeartMuLaAdapter{};
}

namespace heartmula_adapter_detail {

inline bool fail(std::string * err, const std::string & msg) {
    if (err) {
        *err = msg;
    }
    return false;
}

inline const char * proj_name(int slot) {
    static const char * names[4] = { "q_proj", "k_proj", "v_proj", "output_proj" };
    return names[slot];
}

// `["a", "b"]` of plain strings (the converter writes json.dumps of tensor names).
inline bool parse_targets(const std::string & s, std::vector<std::string> * out) {
    size_t i = s.find_first_not_of(" \t\r\n");
    if (i == std::string::npos || s[i] != '[') {
        return false;
    }
    for (++i;;) {
        i = s.find_first_not_of(" \t\r\n", i);
        if (i == std::string::npos) {
            return false;
        }
        if (s[i] == ']') {
            return s.find_first_not_of(" \t\r\n", i + 1) == std::string::npos;
        }
        if (!out->empty()) {
            if (s[i] != ',') {
                return false;
            }
            i = s.find_first_not_of(" \t\r\n", i + 1);
            if (i == std::string::npos) {
                return false;
            }
        }
        if (s[i] != '"') {
            return false;
        }
        const size_t e = s.find('"', i + 1);
        if (e == std::string::npos) {
            return false;
        }
        const std::string name = s.substr(i + 1, e - i - 1);
        if (name.find('\\') != std::string::npos) {
            return false;
        }
        out->push_back(name);
        i = e + 1;
    }
}

}  // namespace heartmula_adapter_detail

// Load `path` for model `m`. On failure `a` is left empty and `err` names the file and cause.
static bool heartmula_adapter_load(HeartMuLaAdapter * a, const HeartMuLaModel & m, const char * path,
                                   std::string * err) {
    using namespace heartmula_adapter_detail;
    static std::atomic<uint64_t> next_id{ 1 };
    heartmula_adapter_free(a);
    const std::string file = path;
    const auto        bad  = [&](const std::string & why) { return fail(err, file + ": " + why); };
    if (!m.loaded) {
        return bad("no HeartMuLa model is loaded to attach the adapter to");
    }
    GGUFModel gf = {};
    if (!gf_load(&gf, path)) {
        return bad("cannot open adapter");
    }
    const auto done = [&](bool ok) {
        gf_close(&gf);
        if (!ok) {
            heartmula_adapter_free(a);
        }
        return ok;
    };
    if (std::string(gf_get_str(gf, "general.architecture")) != "heartmula-lora" ||
        std::string(gf_get_str(gf, "heartmula.component")) != "lora") {
        done(false);
        return bad("not a HeartMuLa LoRA adapter (architecture/component)");
    }
    if (gf_get_u32(gf, "heartmula.format_version") != HEARTMULA_FORMAT_VERSION) {
        done(false);
        return bad("unsupported heartmula.format_version");
    }
    if (std::string(gf_get_str(gf, "heartmula.lora.target_component")) != "global") {
        done(false);
        return bad("heartmula.lora.target_component is not 'global'");
    }
    const std::string variant = gf_get_str(gf, "heartmula.variant"),
                      fp      = gf_get_str(gf, "heartmula.base_fingerprint");
    if (variant != m.variant) {
        done(false);
        return bad("variant is '" + variant + "', the loaded model is '" + m.variant + "'");
    }
    if (fp != m.base_fingerprint) {
        done(false);
        return bad("heartmula.base_fingerprint differs from the loaded global model's");
    }
    const int   rank  = (int) gf_get_u32(gf, "heartmula.lora.rank");
    const float alpha = gf_get_f32(gf, "heartmula.lora.alpha");
    if (rank < 1 || !std::isfinite(alpha) || alpha <= 0.0f) {
        done(false);
        return bad("heartmula.lora.rank/alpha are missing or invalid");
    }

    // Targets: exactly the projections that carry factors, all inside the backbone set.
    std::vector<std::string> targets;
    if (!parse_targets(gf_get_str(gf, "heartmula.lora.targets"), &targets) || targets.empty()) {
        done(false);
        return bad("heartmula.lora.targets is missing or not a JSON array of names");
    }
    const int                n_layer = m.global.cfg.n_layer;
    std::set<std::string>    allowed, listed(targets.begin(), targets.end());
    for (int i = 0; i < n_layer; i++) {
        for (int s = 0; s < 4; s++) {
            allowed.insert("backbone.layers." + std::to_string(i) + ".attn." + proj_name(s) + ".weight");
        }
    }
    for (const auto & t : targets) {
        if (!allowed.count(t)) {
            done(false);
            return bad("target '" + t + "' is not a backbone q/k/v/output projection of this model");
        }
    }
    if (listed.size() != targets.size()) {
        done(false);
        return bad("heartmula.lora.targets lists a tensor twice");
    }
    if ((size_t) gguf_get_n_tensors(gf.gguf) != 2 * targets.size()) {
        done(false);
        return bad("tensor count does not match heartmula.lora.targets");
    }

    a->layers.assign((size_t) n_layer, QwLoraLayer{});
    wctx_init(&a->wctx, (int) (2 * targets.size()) + 1);
    const float scale = alpha / (float) rank;
    for (int i = 0; i < n_layer; i++) {
        const HeartMuLaLayer & base = m.global.layers[(size_t) i];
        ggml_tensor * const    w[4] = { base.q, base.k, base.v, base.o };
        for (int s = 0; s < 4; s++) {
            const std::string name = "backbone.layers." + std::to_string(i) + ".attn." + proj_name(s) + ".weight";
            if (!listed.count(name)) {
                continue;
            }
            ggml_tensor * ta = ggml_get_tensor(gf.meta, (name + ".lora_a").c_str());
            ggml_tensor * tb = ggml_get_tensor(gf.meta, (name + ".lora_b").c_str());
            if (!ta || !tb) {
                done(false);
                return bad("target '" + name + "' lacks its .lora_a/.lora_b pair");
            }
            const bool type_ok = (ta->type == GGML_TYPE_F32 || ta->type == GGML_TYPE_F16) &&
                                 (tb->type == GGML_TYPE_F32 || tb->type == GGML_TYPE_F16);
            // ggml order: A [in, rank], B [rank, out]; the base weight is [in, out]. Rank 1 makes A
            // a 1-D tensor to ggml_n_dims, so only the trailing dimensions are checked.
            if (!type_ok || ta->ne[0] != w[s]->ne[0] || ta->ne[1] != rank || tb->ne[0] != rank ||
                tb->ne[1] != w[s]->ne[1] || ta->ne[2] != 1 || ta->ne[3] != 1 || tb->ne[2] != 1 || tb->ne[3] != 1) {
                done(false);
                return bad("'" + name + "' factors do not fit the base weight at rank " + std::to_string(rank));
            }
            QwLoraPair & p = a->layers[(size_t) i].p[s == 0 ? QW_LORA_Q : s == 1 ? QW_LORA_K : s == 2 ? QW_LORA_V : QW_LORA_O];
            p.A     = gf_load_tensor(&a->wctx, gf, name + ".lora_a");
            p.B     = gf_load_tensor(&a->wctx, gf, name + ".lora_b");
            p.scale = scale;
        }
    }
    if (!wctx_alloc(&a->wctx, m.bp.backend)) {
        done(false);
        return bad("adapter weight allocation failed (out of VRAM?)");
    }
    a->rank             = rank;
    a->alpha            = alpha;
    a->path             = file;
    a->variant          = variant;
    a->base_fingerprint = fp;
    a->id               = next_id.fetch_add(1);
    return done(true);
}
