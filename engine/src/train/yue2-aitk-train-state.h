#pragma once

// Persistent native-v1 YuE2 AR/NAR fused-LoRA state. This owns the two
// parameter collections and their persistent F32 gradient slots, but keeps
// optimizer state and update policy outside the export contract.

#include "yue2-aitk-block-executor.h"
#include "yue2-aitk-native-adapter-io.h"
#include "yue2-aitk-lora.h"

#include <array>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <limits>
#include <random>
#include <string>
#include <vector>

class Yue2AitkTrainState {
public:
    struct NamedTensors { std::string name; ggml_tensor * parameter; ggml_tensor * gradient; };
    static constexpr int kLayers = 28;
    static constexpr int kSites = kYue2AitkSites;
    static constexpr uint32_t kDefaultSeed = 0x59414531u;

    Yue2AitkTrainState() = default;
    ~Yue2AitkTrainState() { reset(); }
    Yue2AitkTrainState(const Yue2AitkTrainState &) = delete;
    Yue2AitkTrainState & operator=(const Yue2AitkTrainState &) = delete;

    // lokr_dim > 0 selects LoKr sites (kron factors, lokr-apply.h) in place of
    // LoRA pairs; rank is then unused and alpha is the LoKr alpha.
    bool initialize(ggml_backend_t backend, uint32_t seed = kDefaultSeed, std::string * error = nullptr, bool cursor = false,
                    int64_t rank = 32, float alpha = 32.0f, int lokr_dim = 0, int lokr_factor = 0) {
        reset();
        if (!backend) return fail(error, "backend is null");
        if (rank < 1 || rank > 65536) return fail(error, "rank must be within [1, 65536]");
        if (!std::isfinite(alpha) || alpha <= 0.0f) return fail(error, "alpha must be finite and positive");
        if (lokr_dim < 0 || lokr_dim > 65536) return fail(error, "lokr dim must be within [1, 65536]");
        ggml_init_params params{}; params.mem_size = 2048*ggml_tensor_overhead()+4096; params.no_alloc = true;
        ctx_ = ggml_init(params); if (!ctx_) return fail(error, "failed to create train-state context");
        backend_ = backend; seed_ = seed; init_policy_ = "native-v1"; rank_ = rank; alpha_ = alpha;
        lokr_dim_ = lokr_dim; lokr_factor_ = lokr_factor;
        const Yue2AitkDims dims{2048, 2048, 1024, 6144};
        if (lokr_dim > 0) {
            std::string why;
            if (!yue2_aitk_lokr_slices_ok(dims, lokr_factor, &why)) { reset(); return fail(error, why); }
            if (!yue2_aitk_make_expert_adapters_lokr(ctx_, dims, kLayers, lokr_dim, lokr_factor, alpha, &ar_, "ar") ||
                !yue2_aitk_make_expert_adapters_lokr(ctx_, dims, kLayers, lokr_dim, lokr_factor, alpha, &nar_, "nar")) {
                reset(); return fail(error, "failed to allocate AR/NAR LoKr adapters");
            }
        } else if (!yue2_aitk_make_expert_adapters(ctx_, dims, kLayers, rank, alpha, &ar_, "ar") ||
                   !yue2_aitk_make_expert_adapters(ctx_, dims, kLayers, rank, alpha, &nar_, "nar")) {
            reset(); return fail(error, "failed to allocate AR/NAR adapters");
        }
        slots_.reserve(2u * kLayers * kSites * 3u);
        if (!build_slots(nar_, "diffusion_model", 0, error) || !build_slots(ar_, "text_encoders", 1, error)) { reset(); return false; }
        if (cursor) {
            auto * parameter=ggml_new_tensor_2d(ctx_,GGML_TYPE_F32,2048,2048);
            auto * gradient=ggml_new_tensor_2d(ctx_,GGML_TYPE_F32,2048,2048);
            // Trainable like the adapter factors: ggml_opt_step_adamw (the
            // adamw-lm path) asserts the flag. The cursor loss graph forms its
            // own gradient explicitly and never builds a backward, so the flag
            // changes nothing there.
            ggml_set_param(parameter);
            cursor_slot_=slots_.size();
            slots_.push_back({"cursor_head.weight",parameter,gradient,2048,2048,-1,std::vector<float>(2048*2048,0)});
        }
        buffer_ = ggml_backend_alloc_ctx_tensors(ctx_, backend_);
        if (!buffer_) { reset(); return fail(error, "failed to allocate train-state backend buffer"); }
        std::mt19937 rng(seed_);
        for (Slot & slot : slots_) {
            std::fill(slot.host.begin(), slot.host.end(), 0.0f);
            if (slot.factor == 0) {
                const float bound = 1.0f / std::sqrt(static_cast<float>(slot.cols));
                std::uniform_real_distribution<float> dist(-bound, bound);
                for (float & value : slot.host) value = dist(rng);
            }
            if (slot.factor == -1) for(size_t i=0;i<size_t(slot.rows);++i) slot.host[i*size_t(slot.cols)+i]=1.0f;
            ggml_backend_tensor_set(slot.parameter, slot.host.data(), 0, ggml_nbytes(slot.parameter));
            ggml_backend_tensor_memset(slot.gradient, 0, 0, ggml_nbytes(slot.gradient));
        }
        initialized_ = true;
        return true;
    }

    void reset() {
        initialized_ = false; slots_.clear(); frozen_.clear(); layer_slots_ = {}; layer_grads_ = {}; ar_ = {}; nar_ = {}; cursor_slot_=kInvalid;
        if (buffer_) { ggml_backend_buffer_free(buffer_); buffer_ = nullptr; }
        if (ctx_) { ggml_free(ctx_); ctx_ = nullptr; }
        backend_ = nullptr;
    }

    bool initialized() const { return initialized_; }
    uint32_t seed() const { return seed_; }
    const std::string & initialization_policy() const { return init_policy_; }
    int64_t rank() const { return rank_; }
    float alpha() const { return alpha_; }
    bool is_lokr() const { return lokr_dim_ > 0; }
    int lokr_dim() const { return lokr_dim_; }
    int lokr_factor() const { return lokr_factor_; }
    size_t parameter_count() const {
        size_t n = 0;
        for (const Slot & slot : slots_) if (slot.factor != -1) n += slot.host.size();
        return n;
    }
    const Yue2AitkExpertAdapters & ar_adapters() const { return ar_; }
    const Yue2AitkExpertAdapters & nar_adapters() const { return nar_; }
    ggml_tensor * cursor_head() const { return cursor_slot_==kInvalid?nullptr:slots_[cursor_slot_].parameter; }
    ggml_tensor * cursor_gradient() const { return cursor_slot_==kInvalid?nullptr:slots_[cursor_slot_].gradient; }
    void clear_cursor_gradient() {
        if(auto * gradient=cursor_gradient()) ggml_backend_tensor_memset(gradient,0,0,ggml_nbytes(gradient));
    }
    std::vector<NamedTensors> named_tensors() const {
        std::vector<NamedTensors> result; result.reserve(slots_.size());
        for (const auto & slot : slots_) result.push_back({slot.name,slot.parameter,slot.gradient});
        return result;
    }

    // Upload one layer's block gradients (yue2_aitk_layer_params order) into
    // their persistent F32 slots. The tensors remain available for a later
    // optimizer, but this class performs no update itself.
    // accumulate (--grad-accum): add to the slot's current gradient instead of
    // replacing it; the sum is read back on the host, so the first micro-step
    // of an update must upload without it.
    bool upload_gradients(bool nar, int layer, const Yue2AitkBlockBackwardHost & g, std::string * error = nullptr, bool accumulate = false) {
        if (!initialized_ || layer < 0 || layer >= kLayers) return fail(error, "train state is not initialized or layer is invalid");
        const std::vector<size_t> & indices = layer_slots_[nar ? 0 : 1][static_cast<size_t>(layer)];
        if (g.params.size() != indices.size()) return fail(error, "gradient count mismatch");
        for (size_t i = 0; i < indices.size(); ++i) {
            if (g.params[i].size() != slots_[indices[i]].host.size()) return fail(error, "gradient shape mismatch");
            for (float value : g.params[i]) if (!std::isfinite(value)) return fail(error,"non-finite adapter gradient");
        }
        for (size_t i = 0; i < indices.size(); ++i) {
            Slot & slot = slots_[indices[i]];
            if (accumulate) {
                ggml_backend_tensor_get(slot.gradient, slot.host.data(), 0, ggml_nbytes(slot.gradient));
                for (size_t k = 0; k < slot.host.size(); ++k) slot.host[k] += g.params[i][k];
                ggml_backend_tensor_set(slot.gradient, slot.host.data(), 0, ggml_nbytes(slot.gradient));
            } else {
                ggml_backend_tensor_set(slot.gradient, g.params[i].data(), 0, ggml_nbytes(slot.gradient));
            }
        }
        return true;
    }

    // The device gradient slots of one layer, in yue2_aitk_layer_params order,
    // for block graphs that write their gradients in place (S2b).
    const std::vector<ggml_tensor *> * gradient_tensors(bool nar, int layer) const {
        if (!initialized_ || layer < 0 || layer >= kLayers) return nullptr;
        return &layer_grads_[nar ? 0 : 1][static_cast<size_t>(layer)];
    }

    // Planner freeze (--nar-extra-steps): every slot outside the decoder — the
    // planner's text_encoders.* adapters and the cursor head — is captured
    // once, then held. zero_planner_gradients() runs before clipping so the
    // clip norm and Prodigy's d see the decoder alone; hold_planner() runs
    // after the optimizer step and writes the captured weights back, which
    // undoes whatever momentum or weight decay moved. Optimizer-agnostic.
    void freeze_planner() {
        frozen_.clear();
        for (size_t i = 0; i < slots_.size(); ++i) {
            if (slots_[i].name.rfind("diffusion_model", 0) == 0) continue;
            std::vector<float> weights(ggml_nelements(slots_[i].parameter));
            ggml_backend_tensor_get(slots_[i].parameter, weights.data(), 0, ggml_nbytes(slots_[i].parameter));
            frozen_.emplace_back(i, std::move(weights));
        }
    }
    bool planner_frozen() const { return !frozen_.empty(); }
    void zero_planner_gradients() {
        for (const auto & f : frozen_) ggml_backend_tensor_memset(slots_[f.first].gradient, 0, 0, ggml_nbytes(slots_[f.first].gradient));
    }
    void hold_planner() {
        for (const auto & f : frozen_) ggml_backend_tensor_set(slots_[f.first].parameter, f.second.data(), 0, ggml_nbytes(slots_[f.first].parameter));
    }

    // Default recipe uses one joint parameter group. pre_scale (--grad-accum:
    // 1/N) multiplies every gradient before the norm is taken, so the clip
    // sees the mean over the accumulated songs. 1.0 leaves the path a no-op
    // when the clip scale is also 1.0.
    //
    // S2d-1: the device path (default) computes the sum of squares on the
    // GPU and reads back one scalar, instead of every gradient slot; the
    // combined pre_scale*clip scale is then applied and written back by a
    // second small graph, in place. That is not bit-identical to the old
    // host reduction (F32 device accumulation vs. the host's F64), so
    // YUE2_AITK_CLIP_HOST=1 keeps today's exact host path for anyone who
    // needs the old numbers. See RESEARCH/YUE2_S2D_TOLERANCES.md.
    bool clip_gradients(float max_norm, double * norm, std::string * error=nullptr, float pre_scale=1.0f) {
        if (!initialized_ || !(max_norm>0) || !std::isfinite(max_norm) || !(pre_scale>0) || !std::isfinite(pre_scale)) return fail(error,"invalid clipping request");
        static const bool host_path = std::getenv("YUE2_AITK_CLIP_HOST") != nullptr;
        return host_path ? clip_gradients_host(max_norm, norm, error, pre_scale) : clip_gradients_device(max_norm, norm, error, pre_scale);
    }

    // Copy every slot's gradient into F32 tensors of matching shape, device to
    // device. The LmOptim path uses this to fill its persistent accumulators,
    // which live in a buffer this class does not own. Valid only after
    // clip_gradients, which leaves each slot equal to its host copy.
    bool fill_device_gradients(std::vector<ggml_tensor *> & targets, std::string * error = nullptr) const {
        if (!initialized_ || targets.size() != slots_.size()) return fail(error, "gradient target count does not match slot count");
        for (size_t i = 0; i < slots_.size(); ++i) {
            ggml_tensor * target = targets[i];
            if (!target || target->type != GGML_TYPE_F32 || !ggml_is_contiguous(target) || !ggml_are_same_shape(target, slots_[i].gradient))
                return fail(error, "gradient target must be contiguous F32 of the slot's shape");
            ggml_backend_tensor_copy(slots_[i].gradient, target);
        }
        return true;
    }

    // Refreshes host F32 snapshots and invokes the installed 448-tensor BF16
    // writer. The writer enforces exact names/shapes and no-overwrite publish.
    bool export_snapshot(const char * output_path, int64_t steps, std::string * error = nullptr, const char * ar_path = nullptr, const char * nar_path = nullptr, const std::string & trigger = {}, float caption_dropout = 0.0f,
                         const std::vector<std::pair<std::string, std::string>> & meta = {}) {
        if (!initialized_) return fail(error, "train state is not initialized");
        std::vector<Yue2AitkF32Matrix> factors; factors.reserve(slots_.size());
        for (Slot & slot : slots_) {
            if (slot.factor == -1) continue; // auxiliary training head is resume-only
            ggml_backend_tensor_get(slot.parameter, slot.host.data(), 0, ggml_nbytes(slot.parameter));
            factors.push_back({slot.name, slot.rows, slot.cols, slot.host.data()});
        }
        if (is_lokr()) {
            if (!yue2_aitk_write_fused_lokr(factors, lokr_dim_, lokr_factor_, alpha_, steps, output_path)) return fail(error, "fused-LoKr export failed");
            if ((ar_path || nar_path) && !yue2_aitk_write_native_split_lokr(factors, lokr_dim_, lokr_factor_, alpha_, steps, ar_path, nar_path, trigger, caption_dropout, meta)) return fail(error, "native AR/NAR LoKr export failed");
            return true;
        }
        if (!yue2_aitk_write_fused_lora(factors, rank_, alpha_, steps, output_path)) return fail(error, "fused-LoRA export failed");
        if ((ar_path || nar_path) && !yue2_aitk_write_native_split(factors, rank_, alpha_, steps, ar_path, nar_path, trigger, caption_dropout, meta)) return fail(error, "native AR/NAR export failed");
        return true;
    }

private:
    static constexpr size_t kInvalid = static_cast<size_t>(-1);
    struct Slot {
        std::string name;
        ggml_tensor * parameter = nullptr;
        ggml_tensor * gradient = nullptr;
        int64_t rows = 0, cols = 0;
        // Init policy: 0 = U(+-1/sqrt(cols)) (kaiming_uniform, a=sqrt(5)),
        // 1 = zero, -1 = identity (the resume-only cursor head).
        int factor = 0;
        std::vector<float> host;
    };
    ggml_context * ctx_ = nullptr;
    ggml_backend_t backend_ = nullptr;
    ggml_backend_buffer_t buffer_ = nullptr;
    Yue2AitkExpertAdapters ar_, nar_;
    std::vector<Slot> slots_;
    std::vector<std::pair<size_t, std::vector<float>>> frozen_;  // slot index, held weights
    // [expert (0 = NAR, 1 = AR)][layer] -> slot indices in yue2_aitk_layer_params order.
    std::array<std::vector<std::vector<size_t>>, 2> layer_slots_{};
    std::array<std::vector<std::vector<ggml_tensor *>>, 2> layer_grads_{};  // same order, gradient tensors
    uint32_t seed_ = kDefaultSeed;
    std::string init_policy_ = "native-v1";
    bool initialized_ = false;
    size_t cursor_slot_ = kInvalid;
    int64_t rank_ = 32;
    float alpha_ = 32.0f;
    int lokr_dim_ = 0;     // 0 = LoRA sites
    int lokr_factor_ = 0;

    static bool fail(std::string * error, const char * message) { if (error) *error = message; return false; }
    static bool fail(std::string * error, const std::string & message) { if (error) *error = message; return false; }

    // Today's path: every slot's gradient round-trips through the host so
    // the norm can be accumulated in double. Kept for YUE2_AITK_CLIP_HOST=1.
    bool clip_gradients_host(float max_norm, double * norm, std::string * error, float pre_scale) {
        double squared=0;
        for (auto & slot : slots_) {
            ggml_backend_tensor_get(slot.gradient,slot.host.data(),0,ggml_nbytes(slot.gradient));
            for (float & value : slot.host) {
                if (pre_scale!=1.0f) value*=pre_scale;
                if (!std::isfinite(value)) return fail(error,"non-finite gradient before clipping");
                squared+=double(value)*double(value);
            }
        }
        const double length=std::sqrt(squared);
        if (norm) *norm=length;
        // Divide in double -- length can be far past FLT_MAX (a dense
        // near-F32-limit gradient), and casting it to float first saturates
        // to inf before the division ever runs. The result is always in
        // [0,1] (min with 1.0), so the final cast to float is always safe.
        const float scale=float((std::min)(1.0,double(max_norm)/(length+1e-6)));
        if (scale<1.0f || pre_scale!=1.0f) for (auto & slot : slots_) {
            if (scale<1.0f) for (float & value : slot.host) value*=scale;
            ggml_backend_tensor_set(slot.gradient,slot.host.data(),0,ggml_nbytes(slot.gradient));
        }
        return true;
    }

    // S2d-1 (rev 2, after review): no gradient ever leaves the device, and
    // neither does the clip scale -- it is derived and applied entirely as
    // device tensors, never read back and recomputed on the host. The one
    // scalar that does come back (`length`) is read AFTER the scale and the
    // in-place apply are already baked into the graph; it feeds only the
    // *norm telemetry output, never the clip itself.
    //
    // Squaring a raw gradient in F32 can overflow (a legitimate finite value
    // like 1e20 squares to 1e40, outside F32 range) even though the host's
    // F64 accumulation handles it fine. rev 1 of this fix found the true
    // global max |value| on the device first (ggml_pool_1d MAX) to rescale
    // by -- correct, but ggml-cuda's pool1d kernel puts the whole reduction
    // on ONE thread whenever the window covers the full tensor (nr==1: see
    // ggml-cuda/pool1d.cu, parallel_elements = nr*OW), so it serially
    // scanned millions of elements and turned clip into the new slowest
    // stage (~2s/step). rev 2 used a fixed SAFE_SCALE instead -- wrong,
    // Reviewer found a finite 1e26 still overflows after it (1e26*1e-6 =
    // 1e20, squares to 1e40 > F32 max). rev 3 brings back the true max, but
    // in two pool1d levels instead of one: level 1 reshapes each slot's
    // |gradient| into [kAbsMaxBlock, blocks] so nr=blocks (parallel, one
    // thread per block, not one thread total); level 2 does a single
    // whole-tensor pool like rev 1's, but only over the *partial* maxes
    // (one float per block across every slot combined, typically a few
    // thousand values total, not millions), so the serial fallback is
    // cheap there. Every element is then divided by that true max before
    // squaring, which bounds the square to <=1 regardless of how large or
    // small the raw gradient was -- no fixed constant, no overflow, for
    // the entire finite F32 range.
    //
    // S2e-1: level 1's own pool1d call still had every one of its `blocks`
    // threads serially scanning the full kAbsMaxBlock=4096-wide window
    // (ggml-cuda/pool1d.cu loops `b..e` on one thread per output element,
    // independent of nr) -- 97ms/step of GPU time by itself. Splitting that
    // one 4096-wide pool into two cascaded kAbsMaxSubBlock=64-wide pools
    // (64*64==4096) turns one thread's 4096-iteration loop into two
    // 64-iteration loops spread over 64x more threads; max(max(...)) over a
    // partition is still the true max, so this is bit-identical, just more
    // parallel. No ggml-cuda edit needed.
    static constexpr int64_t kAbsMaxBlock = 4096;
    static constexpr int64_t kAbsMaxSubBlock = 64;
    static_assert(kAbsMaxSubBlock * kAbsMaxSubBlock == kAbsMaxBlock, "two cascaded sub-block pools must cover one kAbsMaxBlock exactly");
    bool clip_gradients_device(float max_norm, double * norm, std::string * error, float pre_scale) {
        const size_t n = slots_.size();
        if (n == 0) return fail(error, "no gradient slots to clip");
        const size_t graph_size = 28*n + 128;
        ggml_init_params params{};
        // Per slot: reshape, optional pre_scale, abs, optional pad,
        // two cascaded reshape-2d+pool1d pairs (S2e-1) then reshape (max
        // pass) then reshape, optional pre_scale, div, sqr, sum, running
        // add (sum pass), plus the apply pass's mul+cpy, plus one concat
        // into the running partial-max chain -- under 20 tensors per slot;
        // padded well past that since the pool is cheap and a miscount
        // here is a hard abort.
        params.mem_size = ggml_graph_overhead_custom(graph_size, false) + ggml_tensor_overhead()*(28*n+128) + 32768;
        params.no_alloc = true;
        ggml_context * ctx = ggml_init(params);
        if (!ctx) return fail(error, "failed to create clip context");
        ggml_cgraph * graph = ggml_new_graph_custom(ctx, graph_size, false);

        ggml_tensor * max_norm_t = ggml_new_tensor_1d(ctx, GGML_TYPE_F32, 1);
        ggml_tensor * clip_eps_t = ggml_new_tensor_1d(ctx, GGML_TYPE_F32, 1);

        // Stage 1: true global max(|pre_scale * gradient|) across every
        // slot, via the two-level pool above.
        ggml_tensor * partials = nullptr;
        for (size_t i = 0; i < n; ++i) {
            ggml_tensor * flat = ggml_reshape_1d(ctx, slots_[i].gradient, ggml_nelements(slots_[i].gradient));
            ggml_tensor * scaled = pre_scale != 1.0f ? ggml_scale(ctx, flat, pre_scale) : flat;
            ggml_tensor * abs_t = ggml_abs(ctx, scaled);
            const int64_t ne = abs_t->ne[0];
            const int64_t blocks = (ne + kAbsMaxBlock - 1) / kAbsMaxBlock;
            const int64_t padded_ne = blocks * kAbsMaxBlock;
            ggml_tensor * padded = padded_ne != ne ? ggml_pad(ctx, abs_t, int(padded_ne - ne), 0, 0, 0) : abs_t;
            // Two cascaded 64-wide pools instead of one 4096-wide pool (see
            // comment above): sub-level a reduces every 64 raw elements in
            // parallel, sub-level b reduces every 64 of those partials down
            // to one max per kAbsMaxBlock-sized block.
            ggml_tensor * grid_a = ggml_reshape_2d(ctx, padded, kAbsMaxSubBlock, (padded_ne / kAbsMaxSubBlock));
            ggml_tensor * level_a = ggml_pool_1d(ctx, grid_a, GGML_OP_POOL_MAX, int(kAbsMaxSubBlock), int(kAbsMaxSubBlock), 0);
            ggml_tensor * grid_b = ggml_reshape_2d(ctx, level_a, kAbsMaxSubBlock, blocks);
            ggml_tensor * level_b = ggml_pool_1d(ctx, grid_b, GGML_OP_POOL_MAX, int(kAbsMaxSubBlock), int(kAbsMaxSubBlock), 0);
            ggml_tensor * level1_flat = ggml_reshape_1d(ctx, level_b, blocks);
            partials = partials ? ggml_concat(ctx, partials, level1_flat, 0) : level1_flat;
        }
        ggml_tensor * global_max = ggml_pool_1d(ctx, partials, GGML_OP_POOL_MAX, int(partials->ne[0]), int(partials->ne[0]), 0);
        // +eps so an all-zero gradient divides by eps, not zero.
        ggml_tensor * denom = ggml_add(ctx, global_max, clip_eps_t);

        // Stage 2: sum((pre_scale*gradient / denom)^2); every term is
        // bounded to <=1 by construction, so the sum stays inside F32's
        // range for any number of elements this trainer will ever see.
        ggml_tensor * total_norm_sq = nullptr;
        for (size_t i = 0; i < n; ++i) {
            ggml_tensor * flat = ggml_reshape_1d(ctx, slots_[i].gradient, ggml_nelements(slots_[i].gradient));
            ggml_tensor * scaled = pre_scale != 1.0f ? ggml_scale(ctx, flat, pre_scale) : flat;
            ggml_tensor * safe = ggml_div(ctx, scaled, denom);
            ggml_tensor * sq = ggml_sqr(ctx, safe);
            ggml_tensor * s = ggml_sum(ctx, sq);
            total_norm_sq = total_norm_sq ? ggml_add(ctx, total_norm_sq, s) : s;
        }
        // The true norm is denom * sqrt_sum, but that product can itself
        // overflow F32 even though both factors never do on their own (a
        // dense gradient near the F32 limit: denom ~1e38, sqrt_sum ~1e3,
        // product ~1e41 > FLT_MAX). Never materialize that product in F32:
        // keep it factored for the clip ratio --
        //   max_norm/(denom*sqrt_sum + eps) == (max_norm/denom) / (sqrt_sum + eps/denom)
        // -- and reconstruct the telemetry norm in host double from the two
        // separately-read-back factors, where the product can't overflow.
        ggml_tensor * sqrt_sum = ggml_sqrt(ctx, total_norm_sq);
        ggml_tensor * ratio = ggml_div(ctx, ggml_div(ctx, max_norm_t, denom), ggml_add(ctx, sqrt_sum, ggml_div(ctx, clip_eps_t, denom)));
        ggml_tensor * scale = ggml_clamp(ctx, ratio, -(std::numeric_limits<float>::max)(), 1.0f);
        ggml_tensor * combined = pre_scale != 1.0f ? ggml_scale(ctx, scale, pre_scale) : scale;

        // Always applied -- whether combined == 1 is itself a device value,
        // and branching on it would mean reading it back first.
        for (size_t i = 0; i < n; ++i) {
            ggml_tensor * updated = ggml_mul(ctx, slots_[i].gradient, combined);
            ggml_build_forward_expand(graph, ggml_cpy(ctx, updated, slots_[i].gradient));
        }
        ggml_build_forward_expand(graph, denom);
        ggml_build_forward_expand(graph, sqrt_sum);

        ggml_backend_buffer_t buffer = ggml_backend_alloc_ctx_tensors(ctx, backend_);
        if (!buffer) { ggml_free(ctx); return fail(error, "failed to allocate clip buffer"); }
        const float eps = 1e-6f;
        ggml_backend_tensor_set(max_norm_t, &max_norm, 0, sizeof(float));
        ggml_backend_tensor_set(clip_eps_t, &eps, 0, sizeof(float));
        if (ggml_backend_graph_compute(backend_, graph) != GGML_STATUS_SUCCESS) {
            ggml_backend_buffer_free(buffer); ggml_free(ctx);
            return fail(error, "clip graph failed");
        }
        float denom_f = 0.0f, sqrt_sum_f = 0.0f;
        ggml_backend_tensor_get(denom, &denom_f, 0, sizeof(float));
        ggml_backend_tensor_get(sqrt_sum, &sqrt_sum_f, 0, sizeof(float));
        ggml_backend_buffer_free(buffer);
        ggml_free(ctx);
        if (!std::isfinite(denom_f) || !std::isfinite(sqrt_sum_f)) return fail(error, "non-finite gradient before clipping");
        if (norm) *norm = double(denom_f) * double(sqrt_sum_f);
        return true;
    }

    bool build_slots(const Yue2AitkExpertAdapters & expert, const char * prefix, int expert_index, std::string * error) {
        static const char * names[kSites] = {"self_attn.qkv_proj", "self_attn.o_proj", "mlp.gate_up_proj", "mlp.down_proj"};
        if (expert.layers.size() != static_cast<size_t>(kLayers)) return fail(error, "adapter layer count mismatch");
        auto & per_layer = layer_slots_[static_cast<size_t>(expert_index)];
        auto & grads = layer_grads_[static_cast<size_t>(expert_index)];
        per_layer.assign(static_cast<size_t>(kLayers), {});
        grads.assign(static_cast<size_t>(kLayers), {});
        for (int layer=0; layer<kLayers; ++layer) for (int s=0; s<kSites; ++s) {
            std::vector<Yue2AitkSiteParam> params;
            yue2_aitk_site_params(yue2_aitk_site(expert.layers[static_cast<size_t>(layer)], s), &params);
            for (const Yue2AitkSiteParam & p : params) {
                ggml_tensor * parameter = p.tensor;
                if (!parameter) return fail(error, "null adapter parameter");
                const int64_t rows = parameter->ne[1], cols = parameter->ne[0];
                ggml_tensor * gradient = ggml_new_tensor_2d(ctx_, GGML_TYPE_F32, cols, rows);
                if (!gradient) return fail(error, "failed to allocate persistent gradient");
                const std::string name = std::string(prefix) + ".model.layers." + std::to_string(layer) + "." + names[s] + p.suffix;
                Slot slot{name,parameter,gradient,rows,cols,p.zero_init ? 1 : 0,std::vector<float>(static_cast<size_t>(rows*cols),0.0f)};
                per_layer[static_cast<size_t>(layer)].push_back(slots_.size()); slots_.push_back(std::move(slot));
                grads[static_cast<size_t>(layer)].push_back(gradient);
            }
        }
        return true;
    }
};
