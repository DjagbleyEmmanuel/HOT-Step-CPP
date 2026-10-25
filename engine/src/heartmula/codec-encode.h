#pragma once
// HeartCodec waveform to RVQ tokens, as heartlib's HeartCodecEncoder.tokenize:
// mono doubles to stereo, functional resample to 24 kHz, 29.76 s chunks each with a
// 240-sample tail, four feature streams, query fusion and the shared RVQ.
//
// Phases. One encoder component is resident at a time: MuEncoder, WavLM, Whisper,
// then query, each over every chunk, each freed before the next loads. Admission
// before each load takes the S6 figure (NVML free VRAM on CUDA, ggml's otherwise)
// against the file's bytes plus HEARTMULA_VRAM_RESERVE_MB. Cancel is checked between
// components, chunks, channels and MuEncoder windows and throws heartcodec::Cancelled.
// The encoder pack is never loaded for text generation.
#include "heartmula/encoder-query.h"
#include "heartmula/pipeline.h"

#include <filesystem>

namespace heartcodec {

struct EncoderPaths { std::string rvq, muencoder, wavlm, whisper, query; };

// Paths in `dir` with the converter's default names at the given quant ("F16").
inline EncoderPaths encoder_paths(const std::string & dir, const std::string & quant = "F16") {
    auto f = [&](const std::string & role) { return (std::filesystem::path(dir) / ("heartcodec-" + role + "-" + quant + ".gguf")).string(); };
    return {(std::filesystem::path(dir) / "heartcodec-rvq-F32.gguf").string(), f("muencoder"), f("wavlm"), f("whisper"), f("query")};
}

// Stage outputs for parity tracing: stage, chunk, channel (-1 for stereo), values, dims.
using EncodeTrace = std::function<void(const std::string &, int, int, const std::vector<float> &, const std::vector<int64_t> &)>;

struct EncodeResult {
    std::vector<int64_t> codes;  // [8][frames]
    int64_t frames = 0, chunks = 0;
    std::map<std::string, double> seconds;
};

inline double encoder_config_number(const std::string & config, const char * a, const char * b) {
    using Json = std::unique_ptr<yyjson_doc, decltype(&yyjson_doc_free)>;
    Json doc(yyjson_read(config.data(), config.size(), 0), yyjson_doc_free);
    require(bool(doc), "invalid encoder config JSON");
    auto v = yyjson_obj_get(yyjson_obj_get(yyjson_obj_get(yyjson_doc_get_root(doc.get()), "feature_extractors"), a), b);
    require(yyjson_is_num(v), std::string("encoder config lacks ") + a + "." + b);
    return yyjson_get_num(v);
}

// Refuses a load that would not fit: file bytes + reserve against device free now.
inline void encoder_admit(ggml_backend_t backend, const std::string & path, const char * phase) {
    const uint64_t need = std::filesystem::file_size(path) + heartmula_reserve_bytes();
    const uint64_t free = heartmula_device_free(ggml_backend_get_device(backend));
    fprintf(stderr, "[HeartCodec] encoder admission %s: need %.2f GiB, free %.2f GiB -> %s\n", phase,
            need / 1073741824.0, free / 1073741824.0, need <= free ? "admitted" : "refused");
    require(need <= free, std::string("not enough free memory to load the ") + phase + " encoder");
}

inline EncodeResult encode(const EncoderPaths & paths, ggml_backend_t backend, const std::vector<float> & planar,
                           int channels, int64_t samples, int rate, const Cancel & cancelled = {},
                           const EncodeTrace & trace = {}) {
    require(channels == 1 || channels == 2, "audio must be mono or stereo");
    require(samples > 0 && rate > 0 && planar.size() == size_t(channels * samples), "invalid audio shape");
    for (float v : planar) require(std::isfinite(v), "audio must be finite");
    EncodeResult r;
    auto clock = [] { return std::chrono::steady_clock::now(); };
    auto since = [&](std::chrono::steady_clock::time_point t) { return std::chrono::duration<double>(clock() - t).count(); };
    auto t0 = clock();
    std::vector<float> stereo(planar);
    if (channels == 1) stereo.insert(stereo.end(), planar.begin(), planar.end());
    int64_t length = samples;
    if (rate != 24000) stereo = resample(stereo, 2, samples, rate, 24000, false, &length);
    r.frames = int64_t(double(length) / 24000.0 * 12.5) + 1;
    r.chunks = (length + enc_chunk_samples - 1) / enc_chunk_samples;
    const int64_t span = enc_chunk_samples + enc_tail;
    auto chunk_audio = [&](int64_t n, int ch) {
        std::vector<float> a(size_t(span), 0.0f);
        const int64_t start = n * enc_chunk_samples, count = std::min(enc_chunk_samples, length - start);
        std::copy_n(stereo.data() + ch * length + start, count, a.data());
        return a;
    };
    if (trace) trace("audio_24k", 0, -1, stereo, {2, length});
    r.seconds["resample"] = since(t0);
    // Per chunk, per channel: acoustic, semantic, whisper, wavlm [dim, 744].
    const size_t cells = size_t(r.chunks) * 2;
    std::vector<std::vector<float>> acoustic(cells), semantic(cells), whisper(cells), wavlm(cells);
    auto cell = [](int64_t n, int ch) { return size_t(n * 2 + ch); };
    std::string config;
    std::vector<std::string> rvq_hashes;  // every encoder file must name the RVQ in use
    {
        t0 = clock();
        check_cancel(cancelled);
        encoder_admit(backend, paths.muencoder, "muencoder");
        Weights w; load_encoder_part(w, paths.muencoder, "muencoder", backend);
        config = w.config;
        rvq_hashes.push_back(w.rvq_hash);
        const double mean = encoder_config_number(config, "muencoder_config", "mean");
        const double std_dev = encoder_config_number(config, "muencoder_config", "std");
        for (int64_t n = 0; n < r.chunks; ++n) for (int ch = 0; ch < 2; ++ch) {
            check_cancel(cancelled);
            auto audio = chunk_audio(n, ch);
            if (trace) trace("chunk_24k", int(n), ch, audio, {span});
            std::vector<float> mel;
            muencoder_run(w, backend, audio.data(), mean, std_dev, acoustic[cell(n, ch)], semantic[cell(n, ch)], cancelled,
                          trace ? &mel : nullptr);
            if (trace) {
                trace("mu_mel", int(n), ch, mel, {128, enc_frames * 4});
                trace("mu_acoustic", int(n), ch, acoustic[cell(n, ch)], {enc_frames, 1024});
                trace("mu_semantic", int(n), ch, semantic[cell(n, ch)], {enc_frames, 1024});
            }
        }
        r.seconds["muencoder"] = since(t0);
    }
    // Both 16 kHz paths share the resampler; keep its output for Whisper too.
    std::vector<std::vector<float>> audio16(cells);
    {
        t0 = clock();
        check_cancel(cancelled);
        encoder_admit(backend, paths.wavlm, "wavlm");
        Weights w; load_encoder_part(w, paths.wavlm, "wavlm", backend);
        rvq_hashes.push_back(w.rvq_hash);
        require(w.config == config, "encoder pack files come from different configs");
        for (int64_t n = 0; n < r.chunks; ++n) for (int ch = 0; ch < 2; ++ch) {
            check_cancel(cancelled);
            int64_t out = 0;
            audio16[cell(n, ch)] = resample(chunk_audio(n, ch), 1, span, 24000, 16000, true, &out);
            require(out == enc_samples_16k, "unexpected 16 kHz length");
            if (trace) trace("wav_16k", int(n), ch, audio16[cell(n, ch)], {out});
            wavlm[cell(n, ch)] = wavlm_run(w, backend, audio16[cell(n, ch)]);
            if (trace) trace("wavlm", int(n), ch, wavlm[cell(n, ch)], {enc_frames, 768});
        }
        r.seconds["wavlm"] = since(t0);
    }
    {
        t0 = clock();
        check_cancel(cancelled);
        encoder_admit(backend, paths.whisper, "whisper");
        Weights w; load_encoder_part(w, paths.whisper, "whisper", backend);
        rvq_hashes.push_back(w.rvq_hash);
        require(w.config == config, "encoder pack files come from different configs");
        for (int64_t n = 0; n < r.chunks; ++n) for (int ch = 0; ch < 2; ++ch) {
            check_cancel(cancelled);
            const auto & a = audio16[cell(n, ch)];
            auto mel = whisper_mel(a.data(), int64_t(a.size()));
            if (trace) trace("whisper_mel", int(n), ch, mel, {80, 3000});
            whisper[cell(n, ch)] = whisper_run(w, backend, mel);
            if (trace) trace("whisper", int(n), ch, whisper[cell(n, ch)], {enc_frames, 768});
        }
        r.seconds["whisper"] = since(t0);
    }
    {
        t0 = clock();
        check_cancel(cancelled);
        encoder_admit(backend, paths.query, "query");
        Weights w; load_encoder_part(w, paths.query, "query", backend);
        Weights rvq; rvq.load(paths.rvq, "rvq", backend);
        require(w.config == config, "encoder pack files come from different configs");
        rvq_hashes.push_back(w.rvq_hash);
        for (const auto & hash : rvq_hashes)
            require(hash == rvq.file_hash, "encoder pack was converted against a different RVQ");
        // Interleave channels per frame: [left dims, right dims].
        auto stereo_features = [&](const std::vector<std::vector<float>> & f, int64_t n, int64_t dim) {
            std::vector<float> out(size_t(2 * dim * enc_frames));
            for (int ch = 0; ch < 2; ++ch) for (int64_t t = 0; t < enc_frames; ++t)
                std::copy_n(f[cell(n, ch)].data() + t * dim, dim, out.data() + t * 2 * dim + ch * dim);
            return out;
        };
        std::vector<int64_t> packed;
        for (int64_t n = 0; n < r.chunks; ++n) {
            check_cancel(cancelled);
            auto fa = stereo_features(acoustic, n, 1024), fs = stereo_features(semantic, n, 1024);
            auto fw = stereo_features(whisper, n, 768), fl = stereo_features(wavlm, n, 768);
            if (trace) {
                trace("feature_acoustic", int(n), -1, fa, {enc_frames, 2048});
                trace("feature_semantic", int(n), -1, fs, {enc_frames, 2048});
                trace("feature_whisper", int(n), -1, fw, {enc_frames, 1536});
                trace("feature_wavlm", int(n), -1, fl, {enc_frames, 1536});
            }
            auto queries = query_run(w, backend, fa, fs, fw, fl, enc_frames);
            if (trace) trace("query", int(n), -1, queries, {enc_frames / 2, 512});
            auto codes = rvq_encode(rvq, queries, enc_frames / 2);
            packed.insert(packed.end(), codes.begin(), codes.end());
        }
        r.seconds["query"] = since(t0);
        // The first `frames` [frame][8] rows, transposed to [8][frames].
        require(int64_t(packed.size() / 8) >= r.frames, "fewer codes than frames");
        r.codes.resize(size_t(8 * r.frames));
        for (int64_t t = 0; t < r.frames; ++t) for (int q = 0; q < 8; ++q)
            r.codes[size_t(q * r.frames + t)] = packed[size_t(t * 8 + q)];
    }
    return r;
}

} // namespace heartcodec
