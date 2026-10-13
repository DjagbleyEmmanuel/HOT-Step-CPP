#pragma once
#include "yue2-aitk-block-executor.h"
#include "st-write.h"
#include <algorithm>
#include <cstring>
#include <functional>
#include <cstdio>
#include <memory>
#include <cstdlib>

// Recompute one block at a time. Keep layer checkpoints on the backend by
// default; the diagnostic host tape packs the same rounded values as BF16.
// Device canvases for the NAR's detached AR prefix (S2b, 2026-10-13): one K
// and one V [D, length+count, Nkv] per layer, prefix rows written by the
// capturing forward pass, the trailing `count` rows zero. The NAR forward and
// its backward recompute read them in place, so the prefix never crosses the
// bus and no per-layer canvas is allocated, cleared or uploaded.
struct Yue2AitkPrefixDevice {
    ggml_context * ctx = nullptr;
    ggml_backend_buffer_t buffer = nullptr;
    std::vector<ggml_tensor *> k, v;
    int64_t count = 0;
    Yue2AitkPrefixDevice() = default;
    Yue2AitkPrefixDevice(const Yue2AitkPrefixDevice &) = delete;
    Yue2AitkPrefixDevice & operator=(const Yue2AitkPrefixDevice &) = delete;
    ~Yue2AitkPrefixDevice() { if (buffer) ggml_backend_buffer_free(buffer); if (ctx) ggml_free(ctx); }
};
struct Yue2AitkPrefixHost {
    int64_t length = 0;
    std::vector<std::vector<float>> keys, values; // [D,length,Nkv] per layer
    // Set device_count (the NAR sequence the prefix will condition) before a
    // capturing forward to capture into device canvases instead of host vectors.
    int64_t device_count = 0;
    std::shared_ptr<Yue2AitkPrefixDevice> device;
};
struct Yue2AitkStackTape {
    Yue2AitkStackTape() = default;
    Yue2AitkStackTape(const Yue2AitkStackTape &) = delete;
    Yue2AitkStackTape & operator=(const Yue2AitkStackTape &) = delete;
    int64_t length = 0;
    bool nar = false;
    std::vector<std::vector<uint16_t>> layer_inputs;
    std::vector<float> final_hidden; // before final expert norm
    // Fast path storage. Tensor objects and their backend buffer live with the
    // tape, so a backward pass can walk all layer inputs without BF16 host
    // widen/upload cycles. The baseline path never initializes these fields.
    ggml_context * device_ctx = nullptr;
    ggml_backend_buffer_t device_buffer = nullptr;
    std::vector<ggml_tensor *> device_layers;
    ggml_tensor * device_grad[2] = {nullptr, nullptr};
    bool device_tape = false;
    bool device_saved = false;
    void clear_device() {
        if (device_buffer) ggml_backend_buffer_free(device_buffer);
        if (device_ctx) ggml_free(device_ctx);
        device_buffer = nullptr; device_ctx = nullptr; device_layers.clear();
        device_grad[0] = device_grad[1] = nullptr; device_tape = false; device_saved = false;
    }
    ~Yue2AitkStackTape() {
        clear_device();
    }
};

namespace yue2_aitk_stack {
inline bool fast_execution() { return std::getenv("YUE2_AITK_BASELINE") == nullptr; }
inline std::vector<float> widen(const std::vector<uint16_t> & source) {
    std::vector<float> result(source.size());
    for (size_t i=0; i<source.size(); ++i) {
        const uint32_t bits=uint32_t(source[i])<<16;
        std::memcpy(&result[i], &bits, sizeof(float));
    }
    return result;
}
inline std::vector<uint16_t> pack(const std::vector<float> & source) {
    std::vector<uint16_t> result(source.size());
    for (size_t i=0; i<source.size(); ++i) result[i]=stw_f32_to_bf16(source[i]);
    return result;
}
inline void trig(const Yue2AitkGraphConfig & c, int64_t count, int64_t offset,
                  std::vector<float> & cosine, std::vector<float> & sine) {
    const int64_t half=c.head_dim/2;
    cosine.resize(size_t(count*half)); sine.resize(cosine.size());
    for (int64_t t=0;t<count;++t) for (int64_t i=0;i<half;++i) {
        const float frequency=1.0f/std::pow(1000000.0f,float(2*i)/float(c.head_dim));
        const float angle=float(t+offset)*frequency;
        const uint32_t cb=uint32_t(stw_f32_to_bf16(std::cos(angle)))<<16;
        const uint32_t sb=uint32_t(stw_f32_to_bf16(std::sin(angle)))<<16;
        std::memcpy(&cosine[size_t(t*half+i)],&cb,4);
        std::memcpy(&sine[size_t(t*half+i)],&sb,4);
    }
}
inline Yue2AitkBlockNorms norms(const Yue2AitkModel & model, bool nar, size_t layer) {
    const std::string prefix=std::string(nar ? "model.diffusion_model.model.layers." : "text_encoders.model.layers.")+
                              std::to_string(layer)+".";
    return {model.ordinary((prefix+"input_layernorm.weight").c_str()),
            model.ordinary((prefix+"post_attention_layernorm.weight").c_str()),
            model.ordinary((prefix+"self_attn.q_norm.weight").c_str()),
            model.ordinary((prefix+"self_attn.k_norm.weight").c_str())};
}
inline bool valid_norms(const Yue2AitkBlockNorms & n) { return n.input && n.post_attention && n.q && n.k; }
inline bool make_device_tape(ggml_backend_t backend, const Yue2AitkGraphConfig & c,
                             size_t layers, int64_t length, bool save,
                             Yue2AitkStackTape * tape, std::string * error) {
    using yue2_aitk_executor_detail::fail;
    if (!backend || !tape || length <= 0 || c.hidden <= 0) return fail(error, "invalid device tape request");
    const size_t count = save ? layers + 1 : 2;
    const size_t overhead = (count + 2) * ggml_tensor_overhead() + 4096;
    ggml_init_params p{}; p.mem_size = overhead; p.no_alloc = true;
    tape->device_ctx = ggml_init(p);
    if (!tape->device_ctx) return fail(error, "device tape context allocation failed");
    tape->device_layers.resize(count);
    for (size_t i = 0; i < count; ++i) {
        tape->device_layers[i] = ggml_new_tensor_2d(tape->device_ctx, GGML_TYPE_F32, c.hidden, length);
        if (!tape->device_layers[i]) return fail(error, "device tape tensor allocation failed");
    }
    tape->device_grad[0] = ggml_new_tensor_2d(tape->device_ctx, GGML_TYPE_F32, c.hidden, length);
    tape->device_grad[1] = ggml_new_tensor_2d(tape->device_ctx, GGML_TYPE_F32, c.hidden, length);
    if (!tape->device_grad[0] || !tape->device_grad[1]) return fail(error, "device gradient tensor allocation failed");
    tape->device_buffer = ggml_backend_alloc_ctx_tensors(tape->device_ctx, backend);
    if (!tape->device_buffer) return fail(error, "device tape backend allocation failed");
    tape->device_tape = true;
    tape->device_saved = save;
    return true;
}
inline bool make_prefix_device(ggml_backend_t backend, const Yue2AitkGraphConfig & c, size_t layers,
                               int64_t length, Yue2AitkPrefixHost * prefix) {
    auto d = std::make_shared<Yue2AitkPrefixDevice>();
    ggml_init_params p{}; p.mem_size = (2 * layers + 2) * ggml_tensor_overhead() + 4096; p.no_alloc = true;
    d->ctx = ggml_init(p);
    if (!d->ctx) return false;
    d->count = prefix->device_count;
    for (size_t i = 0; i < layers; ++i) {
        d->k.push_back(ggml_new_tensor_4d(d->ctx, GGML_TYPE_F32, c.head_dim, length + d->count, c.kv_heads, 1));
        d->v.push_back(ggml_new_tensor_4d(d->ctx, GGML_TYPE_F32, c.head_dim, length + d->count, c.kv_heads, 1));
    }
    d->buffer = ggml_backend_alloc_ctx_tensors(d->ctx, backend);
    if (!d->buffer) return false;
    ggml_backend_buffer_clear(d->buffer, 0);
    prefix->device = std::move(d);
    return true;
}
// Block constants (the RoPE tables and the attention mask) depend only on the
// sequence length, the prefix length and the mask mode. They are built,
// checked and uploaded once and shared by every pass and step that asks for
// the same shape (S2b, 2026-10-13); before, each pass rebuilt the mask on the
// host (4,128^2 values for a whole-song AR) and every block call re-checked
// the tables. Up to kSharedConstants shapes stay resident, oldest out first;
// block compute is synchronous, so an evicted entry is no longer being read.
struct SharedConstants {
    ggml_backend_t backend = nullptr;
    int64_t length = 0, prefix = 0;
    Yue2AitkMaskMode mode = Yue2AitkMaskMode::causal;
    std::vector<float> cosine, sine;
    Yue2AitkBlockConstants constants;
};
inline SharedConstants * shared_constants(ggml_backend_t backend, const Yue2AitkGraphConfig & c, int64_t length,
                                          int64_t prefix, Yue2AitkMaskMode mode, std::string * error) {
    constexpr size_t kSharedConstants = 8;
    // Never destroyed: a static destructor would free CUDA buffers after the
    // backend is gone. The process exit reclaims them.
    static auto * cache = new std::vector<std::unique_ptr<SharedConstants>>();
    for (size_t i = 0; i < cache->size(); ++i) {
        const SharedConstants & e = *(*cache)[i];
        if (e.backend == backend && e.length == length && e.prefix == prefix && e.mode == mode) {
            std::rotate(cache->begin() + long(i), cache->begin() + long(i) + 1, cache->end());
            return cache->back().get();
        }
    }
    auto e = std::make_unique<SharedConstants>();
    e->backend = backend; e->length = length; e->prefix = prefix; e->mode = mode;
    { YUE2_PROF("stack: RoPE tables (host)"); trig(c, length, prefix, e->cosine, e->sine); }
    if (!yue2_aitk_executor_detail::finite_all(e->cosine.data(), e->cosine.size()) ||
        !yue2_aitk_executor_detail::finite_all(e->sine.data(), e->sine.size())) {
        yue2_aitk_executor_detail::fail(error, "non-finite RoPE table");
        return nullptr;
    }
    if (!e->constants.make(backend, c, length, prefix, mode, e->cosine.data(), e->sine.data(), error)) return nullptr;
    if (cache->size() >= kSharedConstants) cache->erase(cache->begin());
    cache->push_back(std::move(e));
    return cache->back().get();
}
struct PrefixCanvas {
    yue2_aitk_executor_detail::Runtime runtime;
    ggml_tensor * k=nullptr, * v=nullptr;
    bool make(ggml_backend_t backend, const Yue2AitkGraphConfig & c,
              const Yue2AitkPrefixHost * prefix, size_t layer, int64_t count, std::string * error) {
        if (!prefix) return true;
        using namespace yue2_aitk_executor_detail;
        if (prefix->device) {
            if (prefix->device->count != count || layer >= prefix->device->k.size())
                return fail(error, "device AR prefix was captured for a different decoder length");
            k = prefix->device->k[layer]; v = prefix->device->v[layer];
            return true;
        }
        if (prefix->length<=0 || prefix->length+count>24576 || layer>=prefix->keys.size() || layer>=prefix->values.size())
            return fail(error,"invalid detached AR prefix dimensions");
        const size_t expected=size_t(c.head_dim*c.kv_heads*prefix->length);
        if (prefix->keys[layer].size()!=expected || prefix->values[layer].size()!=expected)
            return fail(error,"AR prefix payload has wrong size");
        if (!make_runtime(backend, 4*ggml_tensor_overhead()+1024,&runtime,error)) return false;
        k=ggml_new_tensor_4d(runtime.ctx,GGML_TYPE_F32,c.head_dim,prefix->length+count,c.kv_heads,1);
        v=ggml_new_tensor_4d(runtime.ctx,GGML_TYPE_F32,c.head_dim,prefix->length+count,c.kv_heads,1);
        if (!allocate(&runtime,backend,error)) return false;
        ggml_backend_buffer_clear(runtime.buffer,0);
        for (int64_t head=0;head<c.kv_heads;++head) {
            const size_t begin=size_t(head*c.head_dim*prefix->length);
            const size_t bytes=size_t(c.head_dim*prefix->length)*sizeof(float);
            ggml_backend_tensor_set(k,prefix->keys[layer].data()+begin,size_t(head)*k->nb[2],bytes);
            ggml_backend_tensor_set(v,prefix->values[layer].data()+begin,size_t(head)*v->nb[2],bytes);
        }
        return true;
    }
};

inline bool forward(ggml_backend_t backend, const Yue2AitkModel & model,
                     const Yue2AitkExpertAdapters * adapters, bool nar,
                     const std::vector<float> & initial, int64_t length,
                     const Yue2AitkPrefixHost * prefix, bool save_tape,
                     Yue2AitkStackTape * tape, Yue2AitkPrefixHost * capture_prefix,
                     std::string * error=nullptr) {
    using namespace yue2_aitk_executor_detail;
    const auto & expert=nar?model.nar():model.ar();
    Yue2AitkGraphConfig c;
    if (!tape || length<=0 || length>24576 || initial.size()!=size_t(length*c.hidden) ||
        (adapters && adapters->layers.size()!=expert.layers.size()) || (nar && !prefix))
        return fail(error,"invalid expert forward request");
    tape->clear_device();
    tape->length=length; tape->nar=nar; tape->layer_inputs.clear(); tape->final_hidden.clear();
    if (capture_prefix) {
        capture_prefix->length=length; capture_prefix->keys.clear(); capture_prefix->values.clear();
        capture_prefix->device.reset();
        if (capture_prefix->device_count > 0 && fast_execution() && backend &&
            !make_prefix_device(backend, c, expert.layers.size(), length, capture_prefix)) {
            static bool warned = false;
            if (!warned) { warned = true; std::fprintf(stderr, "[yue2-aitk] warning: no device memory for the AR prefix canvases; keeping the prefix on the host\n"); }
        }
    }
    Yue2AitkBlockWorkspace workspace;
    const bool fast = fast_execution();
    const Yue2AitkMaskMode mask_mode = nar ? Yue2AitkMaskMode::noncausal : Yue2AitkMaskMode::causal;
    SharedConstants * shared = fast ? shared_constants(backend, c, length, prefix ? prefix->length : 0, mask_mode, error) : nullptr;
    if (fast && !shared) return false;
    std::vector<float> local_cosine, local_sine;
    if (!shared) trig(c, length, prefix ? prefix->length : 0, local_cosine, local_sine);
    const std::vector<float> & cosine = shared ? shared->cosine : local_cosine;
    const std::vector<float> & sine = shared ? shared->sine : local_sine;
    Yue2AitkBlockConstants * constants = shared ? &shared->constants : nullptr;
    const bool device = fast && backend != nullptr && std::getenv("YUE2_AITK_HOST_TAPE") == nullptr;
    if (device && !make_device_tape(backend, c, expert.layers.size(), length, save_tape, tape, error)) return false;
    std::vector<float> hidden=initial;
    if (device) ggml_backend_tensor_set(tape->device_layers[0], initial.data(), 0, ggml_nbytes(tape->device_layers[0]));
    for (size_t layer=0;layer<expert.layers.size();++layer) {
        if (!device && save_tape) tape->layer_inputs.push_back(pack(hidden));
        PrefixCanvas canvas;
        { YUE2_PROF("stack: prefix canvas"); if (!canvas.make(backend,c,prefix,layer,length,error)) return false; }
        const Yue2AitkBlockNorms layer_norms = norms(model,nar,layer);
        if (!valid_norms(layer_norms)) return fail(error,"expert layer norm weights are missing");
        Yue2AitkBlockForwardHost out;
        ggml_tensor * device_in = device ? tape->device_layers[save_tape ? layer : (layer & 1)] : nullptr;
        ggml_tensor * device_out = device ? tape->device_layers[save_tape ? layer + 1 : ((layer + 1) & 1)] : nullptr;
        const bool device_capture = capture_prefix && capture_prefix->device;
        if (!Yue2AitkBlockExecutor::forward(backend,c,expert.layers[layer],layer_norms,
                adapters?&adapters->layers[layer]:nullptr,device ? nullptr : hidden.data(),length,cosine.data(),sine.data(),
                nar?Yue2AitkMaskMode::noncausal:Yue2AitkMaskMode::causal,&out,canvas.k,canvas.v,
                prefix?prefix->length:0,error,!fast || (capture_prefix != nullptr && !device_capture),
                constants,fast?&workspace:nullptr,device_in,device_out,
                device_capture ? capture_prefix->device->k[layer] : nullptr,
                device_capture ? capture_prefix->device->v[layer] : nullptr)) return false;
        if (!device) hidden=std::move(out.hidden);
        if (capture_prefix && !device_capture) { capture_prefix->keys.push_back(std::move(out.key)); capture_prefix->values.push_back(std::move(out.value)); }
    }
    if (device) {
        YUE2_PROF("stack: final hidden readback");
        const ggml_tensor * final_tensor = tape->device_layers[save_tape ? expert.layers.size() : (expert.layers.size() & 1)];
        tape->final_hidden.resize(static_cast<size_t>(c.hidden * length));
        ggml_backend_tensor_get(final_tensor, tape->final_hidden.data(), 0, ggml_nbytes(final_tensor));
        if (!save_tape) tape->clear_device();
    } else tape->final_hidden=std::move(hidden);
    return true;
}

using StoreGradients=std::function<bool(size_t,const Yue2AitkBlockBackwardHost &,std::string *)>;
inline bool backward(ggml_backend_t backend,const Yue2AitkModel & model,
                      const Yue2AitkExpertAdapters & adapters,const Yue2AitkStackTape & tape,
                      const Yue2AitkPrefixHost * prefix,std::vector<float> gradient,
                      const StoreGradients & store,std::string * error=nullptr) {
    using namespace yue2_aitk_executor_detail;
    const auto & expert=tape.nar?model.nar():model.ar();
    Yue2AitkGraphConfig c;
    const bool fast = fast_execution();
    const bool device = fast && tape.device_tape;
    if (!store || ((!device && tape.layer_inputs.size()!=expert.layers.size()) ||
        (device && (!tape.device_saved || tape.device_layers.size()!=expert.layers.size()+1))) ||
        adapters.layers.size()!=expert.layers.size() ||
        gradient.size()!=size_t(tape.length*c.hidden)) return fail(error,"invalid expert backward tape");
    Yue2AitkBlockWorkspace workspace;
    const Yue2AitkMaskMode mask_mode = tape.nar ? Yue2AitkMaskMode::noncausal : Yue2AitkMaskMode::causal;
    SharedConstants * shared = fast ? shared_constants(backend, c, tape.length, prefix ? prefix->length : 0, mask_mode, error) : nullptr;
    if (fast && !shared) return false;
    std::vector<float> local_cosine, local_sine;
    if (!shared) trig(c, tape.length, prefix ? prefix->length : 0, local_cosine, local_sine);
    const std::vector<float> & cosine = shared ? shared->cosine : local_cosine;
    const std::vector<float> & sine = shared ? shared->sine : local_sine;
    Yue2AitkBlockConstants * constants = shared ? &shared->constants : nullptr;
    if (device) {
        ggml_backend_tensor_set(tape.device_grad[0], gradient.data(), 0, ggml_nbytes(tape.device_grad[0]));
        int ping = 0;
        for (size_t end=expert.layers.size(); end>0; --end) {
            const size_t layer = end - 1;
            PrefixCanvas canvas;
            if (!canvas.make(backend,c,prefix,layer,tape.length,error)) return false;
            const Yue2AitkBlockNorms layer_norms = norms(model,tape.nar,layer);
            if (!valid_norms(layer_norms)) return fail(error,"expert layer norm weights are missing");
            Yue2AitkBlockBackwardHost out;
            const size_t input_index = layer;
            const int next = ping ^ 1;
            if (!Yue2AitkBlockExecutor::backward(backend,c,expert.layers[layer],layer_norms,
                    &adapters.layers[layer],nullptr,nullptr,tape.length,cosine.data(),sine.data(),
                    tape.nar?Yue2AitkMaskMode::noncausal:Yue2AitkMaskMode::causal,&out,canvas.k,canvas.v,
                    prefix?prefix->length:0,error,constants,fast?&workspace:nullptr,
                    tape.device_layers[input_index],tape.device_grad[ping],tape.device_grad[next])) return false;
            { YUE2_PROF("state: gradient upload (host checks + H2D)"); if (!store(layer,out,error)) return false; }
            ping = next;
        }
        return true;
    }
    for (size_t end=expert.layers.size();end>0;--end) {
        const size_t layer=end-1;
        auto input=widen(tape.layer_inputs[layer]);
        PrefixCanvas canvas;
        if (!canvas.make(backend,c,prefix,layer,tape.length,error)) return false;
        const Yue2AitkBlockNorms layer_norms = norms(model,tape.nar,layer);
        if (!valid_norms(layer_norms)) return fail(error,"expert layer norm weights are missing");
        Yue2AitkBlockBackwardHost out;
        if (!Yue2AitkBlockExecutor::backward(backend,c,expert.layers[layer],layer_norms,
                &adapters.layers[layer],input.data(),gradient.data(),tape.length,cosine.data(),sine.data(),
                tape.nar?Yue2AitkMaskMode::noncausal:Yue2AitkMaskMode::causal,&out,canvas.k,canvas.v,
                prefix?prefix->length:0,error,constants,fast?&workspace:nullptr)) return false;
        if (!store(layer,out,error)) return false;
        gradient=std::move(out.dx);
    }
    return true;
}
} // namespace yue2_aitk_stack
