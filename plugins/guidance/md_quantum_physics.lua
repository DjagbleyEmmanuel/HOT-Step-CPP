-- ============================================================================
-- SPDX-License-Identifier: GPL-3.0-or-later
-- Copyright (C) 2026 Alexander Allan (MDMAchine) -- A&E Concepts
--
-- This program is free software: you can redistribute it and/or modify
-- it under the terms of the GNU General Public License as published by
-- the Free Software Foundation, either version 3 of the License, or
-- (at your option) any later version.
--
-- This program is distributed in the hope that it will be useful,
-- but WITHOUT ANY WARRANTY; without even the implied warranty of
-- MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
-- GNU General Public License for more details: https://www.gnu.org/licenses/
-- ============================================================================

-- MD Quantum Physics Guidance v1.0 — Multi-System Physics Engine
-- MDMAchine | A&E Concepts © 2026
--
-- Port of quantum_physics_core.py multi-system to HOT-Step-CPP Lua.
--
-- FOUR INDEPENDENT SYSTEMS (all toggleable):
--
--   1. GRAVITATIONAL LENSING (apply_gravitational_lensing):
--      Schwarzschild radius from conditioning "mass" (sum of |cond|).
--      Warp factor = clamp(1 - rs/distance, 0, 2.0).
--      Effective warp = 1 + (warp - 1) * sigma.
--      Multiplies guided result by effective_warp.
--      Stronger at high sigma (structure), fades at refinement.
--
--   2. HAWKING RADIATION (apply_hawking_radiation):
--      Per-channel Shannon entropy detection. Channels below entropy_threshold
--      are "information black holes" — inject thermal noise scaled by
--      temperature_scale * sigma to break them out of collapse.
--      Preserves information at 95% (CONST_INFORMATION_PRESERVATION).
--
--   3. QUANTUM SUPERPOSITION NOISE (post_step):
--      Multi-scale additive noise (octave sum with 1/k weighting).
--      Injects gentle structured noise into the latent to maintain
--      exploration diversity. Scaled by sigma so it fades at refinement.
--
--   4. RELATIVISTIC DILATION (applied to step timing conceptually):
--      sqrt(1 - dilation * progress) factor applied to the guided output
--      magnitude. Models time dilation — later steps (higher progress)
--      experience more "slowing." Subtle effect.
--
-- PARAMS:
--   lensing_strength    — gravitational warp intensity
--   hawking_enabled     — toggle thermal radiation injection
--   hawking_temp        — radiation noise scale
--   entropy_threshold   — per-channel entropy below which radiation fires
--   superposition_scale — multi-scale noise injection amplitude
--   dilation_strength   — relativistic time dilation factor
-- ============================================================================

guidance = {
    name        = "md_quantum_physics",
    display     = "MD Quantum Physics (Multi-System)",
    description = "Four-system guidance: gravitational lensing + Hawking radiation + quantum superposition + relativistic dilation. Each independently toggleable. Port of quantum_physics_core v1.0.",
    params      = {
        {
            key     = "lensing_strength",
            type    = "slider",
            label   = "Lensing Strength",
            default = 0.3,
            min     = 0.0,
            max     = 2.0,
            step    = 0.05,
            hint    = "Gravitational warp intensity. 0=off, 0.3=subtle, 1.0=strong. Schwarzschild warping on guided output.",
        },
        {
            key     = "hawking_enabled",
            type    = "toggle",
            label   = "Hawking Radiation",
            default = false,
            hint    = "Inject thermal noise into collapsed (low-entropy) channels to break information black holes.",
        },
        {
            key     = "hawking_temp",
            type    = "slider",
            label   = "Hawking Temperature",
            default = 0.015,
            min     = 0.001,
            max     = 0.1,
            step    = 0.001,
            hint    = "Radiation noise amplitude. Keep low — this is meant to gently perturb dead channels.",
            visible_when = { key = "hawking_enabled", equals = "true" },
        },
        {
            key     = "entropy_threshold",
            type    = "slider",
            label   = "Entropy Threshold",
            default = 3.0,
            min     = 0.5,
            max     = 8.0,
            step    = 0.25,
            hint    = "Per-channel entropy below which Hawking radiation fires. Lower=more selective.",
            visible_when = { key = "hawking_enabled", equals = "true" },
        },
        {
            key     = "superposition_enabled",
            type    = "toggle",
            label   = "Quantum Superposition",
            default = false,
            hint    = "Multi-scale structured noise injection. Maintains exploration diversity.",
        },
        {
            key     = "superposition_scale",
            type    = "slider",
            label   = "Superposition Scale",
            default = 0.01,
            min     = 0.0,
            max     = 0.1,
            step    = 0.005,
            hint    = "Noise injection amplitude. Very subtle — 0.01 is standard.",
            visible_when = { key = "superposition_enabled", equals = "true" },
        },
        {
            key     = "dilation_strength",
            type    = "slider",
            label   = "Dilation Strength",
            default = 0.0,
            min     = 0.0,
            max     = 1.0,
            step    = 0.05,
            hint    = "Relativistic time dilation. 0=off. Subtly reduces guidance magnitude at later steps.",
        },
        {
            key     = "seed",
            type    = "slider",
            label   = "Seed",
            default = 42,
            min     = 0,
            max     = 999999,
            step    = 1,
            hint    = "RNG seed for Hawking radiation and superposition noise.",
        },
    },
}

-- ── State ────────────────────────────────────────────────────────────────────

local _last_n = 0
local EPSILON = 1e-6
local CONST_G         = 6.674e-3
local CONST_RS_SCALE  = 0.05
local CONST_SOFTENING = 1e-4
local CONST_INFO_PRES = 0.95

-- ── Helpers ──────────────────────────────────────────────────────────────────

local function clamp(v, lo, hi)
    if v < lo then return lo end
    if v > hi then return hi end
    return v
end

-- Seeded LCG + Box-Muller
local function make_rng(seed)
    local state = math.floor(seed) % 2147483647
    if state <= 0 then state = state + 2147483646 end
    return function()
        state = (state * 1664525 + 1013904223) % 2147483648
        return state / 2147483648.0
    end
end

local function normal_sample(rng)
    local u1 = math.max(rng(), EPSILON)
    local u2 = rng()
    return math.sqrt(-2.0 * math.log(u1)) * math.cos(2.0 * math.pi * u2)
end

-- Shannon entropy on a sub-array (channel slice)
local function channel_entropy(arr, start_i, count)
    local total = 0.0
    for i = start_i, start_i + count - 1 do
        total = total + math.abs(arr[i]) + 1e-7
    end
    total = total + 1e-8
    local h = 0.0
    for i = start_i, start_i + count - 1 do
        local p = (math.abs(arr[i]) + 1e-7) / total
        h = h - p * math.log(p) / math.log(2.0)
    end
    if h ~= h then return 5.0 end
    return math.max(0.05, h)
end

-- ── guide() — lensing + hawking + dilation ────────────────────────────────────

function guide(pred_cond, pred_uncond, guidance_scale, result, Oc, T, norm_threshold)
    local n     = Oc * T
    local lens  = (params and params.lensing_strength) or 0.3
    local hawk  = (params and params.hawking_enabled)  or false
    local h_tmp = (params and params.hawking_temp)     or 0.015
    local h_thr = (params and params.entropy_threshold) or 3.0
    local dil   = (params and params.dilation_strength) or 0.0
    local seed  = math.floor((params and params.seed)  or 42)

    if n ~= _last_n then _last_n = n end

    local sigma = t_curr or 0.5
    local step  = step_idx or 0
    local steps = num_steps or 8

    -- Base APG
    apg(pred_cond, pred_uncond, guidance_scale, result, Oc, T, norm_threshold)

    -- 1. GRAVITATIONAL LENSING
    if lens > 0.0 then
        -- Mass from conditioning
        local mass = 0.0
        for i = 0, n - 1 do mass = mass + math.abs(pred_cond[i]) end
        mass = mass * lens

        local rs = (2.0 * CONST_G * mass) * CONST_RS_SCALE

        -- Distance = norm(result - mean(result))
        local mean = 0.0
        for i = 0, n - 1 do mean = mean + result[i] end
        mean = mean / n
        local dist_sq = 0.0
        for i = 0, n - 1 do
            local d = result[i] - mean
            dist_sq = dist_sq + d * d
        end
        local dist = math.sqrt(dist_sq) + CONST_SOFTENING

        local warp = clamp(1.0 - (rs / (dist + EPSILON)), 0.0, 2.0)
        local eff_warp = 1.0 + (warp - 1.0) * sigma

        for i = 0, n - 1 do result[i] = result[i] * eff_warp end
    end

    -- 2. HAWKING RADIATION (per-channel entropy check)
    if hawk and Oc >= 2 then
        local rng = make_rng(seed + step * 7919)
        for ch = 0, Oc - 1 do
            local ch_start = ch * T
            local ent = channel_entropy(result, ch_start, T)
            if ent < h_thr then
                -- Inject thermal noise into this channel
                for t_i = 0, T - 1 do
                    local idx = ch_start + t_i
                    local thermal = normal_sample(rng) * h_tmp * sigma * CONST_INFO_PRES
                    result[idx] = result[idx] + thermal
                end
            end
        end
    end

    -- 3. RELATIVISTIC DILATION
    if dil > 0.0 and steps > 1 then
        local progress = step / (steps - 1)
        local factor = math.sqrt(math.max(0.0, 1.0 - dil * progress))
        if factor < 1.0 then
            for i = 0, n - 1 do
                local vel = result[i] - pred_uncond[i]
                result[i] = pred_uncond[i] + vel * factor
            end
        end
    end
end

-- ── post_step — quantum superposition noise ──────────────────────────────────

function post_step(xt, t, n, eval_cond, eval_uncond, vt_cond, vt_uncond)
    local sp_on = (params and params.superposition_enabled) or false
    local sp_sc = (params and params.superposition_scale)   or 0.01
    local seed  = math.floor((params and params.seed)       or 42)

    if not sp_on or sp_sc <= 0.0 then return end

    local sigma = t or 0.5
    local step  = step_idx or 0

    -- Multi-scale noise: 3 octaves with 1/k weighting, scaled by sigma
    local rng = make_rng(seed + step * 1999)
    local total_weight = 0.0
    for k = 1, 3 do total_weight = total_weight + (1.0 / k) end

    for i = 0, n - 1 do
        local noise = 0.0
        for k = 1, 3 do
            noise = noise + normal_sample(rng) * (1.0 / k)
        end
        noise = noise / total_weight  -- normalize
        xt[i] = xt[i] + noise * sp_sc * sigma
    end
end
