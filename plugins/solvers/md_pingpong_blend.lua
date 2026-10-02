-- ============================================================================
-- SPDX-License-Identifier: GPL-3.0-or-later
-- Copyright (C) 2026 Alexander Allan (MDMAchine) | A&E Concepts
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

-- Pingpong with a renoise amount knob, for rectified flow
-- (x_t = (1-t) x0 + t eps). Mirrors the native SA3 pingpong step:
--   denoised = x - t v
--   x_next   = (1 - t_next) denoised + t_next noise_mix
-- where noise_mix blends fresh Gaussian noise with the trajectory's own
-- implied noise eps_cur = (x - (1-t) denoised) / t, variance-preserving:
--   noise_mix = a z + sqrt(1 - a^2) eps_cur,  a = renoise
-- renoise 1.0 = exact pingpong (all fresh noise), 0.0 = deterministic Euler.
-- The last step (t_next = 0) returns denoised.
-- Marked stochastic so the SA3 engine's own renoise wrapper stays out of the
-- way; works on any rectified-flow backend (ACE, SA3).
-- z comes from math.random via Box-Muller; the engine seeds the Lua RNG from
-- the job seed, so a fixed seed gives a fixed render.

solver = {
    name = "md_pingpong_blend",
    version = "1.0",
    display = "MD Pingpong Blend",
    description = "Pingpong sampler with a renoise amount knob. 1.0 = exact pingpong, lower keeps more of the trajectory's own noise.",
    nfe = 1,
    order = 1,
    needs_model = false,
    stateful = false,
    stochastic = true,
    params = {
        { key = "renoise", type = "slider", label = "Renoise", default = 1.0, min = 0.0, max = 1.0, step = 0.01 },
    },
}

local spare = nil

do
    local raw_randomseed = math.randomseed
    math.randomseed = function(...)
        spare = nil
        return raw_randomseed(...)
    end
end

local function gauss()
    if spare then
        local s = spare
        spare = nil
        return s
    end
    local u1 = math.random()
    if u1 < 1e-12 then u1 = 1e-12 end
    local u2 = math.random()
    local r = math.sqrt(-2.0 * math.log(u1))
    local a = 2.0 * math.pi * u2
    spare = r * math.sin(a)
    return r * math.cos(a)
end

function step(xt, vt, t_curr, t_next, n)
    if n <= 0 then return end
    local a = 1.0
    if params and params.renoise ~= nil then a = tonumber(params.renoise) or 1.0 end
    if a < 0 then a = 0 elseif a > 1 then a = 1 end
    local keep = math.sqrt(1.0 - a * a)

    if t_next <= 0.0 then
        for i = 0, n - 1 do xt[i] = xt[i] - t_curr * vt[i] end
        return
    end

    local inv_t = (t_curr > 1e-6) and (1.0 / t_curr) or 0.0
    for i = 0, n - 1 do
        local x, v = xt[i], vt[i]
        local den = x - t_curr * v
        local mix
        if a >= 1.0 then
            mix = gauss()
        else
            local eps = (t_curr > 1e-6) and ((x - (1.0 - t_curr) * den) * inv_t) or 0.0
            if a > 0.0 then mix = a * gauss() + keep * eps else mix = eps end
        end
        local y = (1.0 - t_next) * den + t_next * mix
        if y ~= y or y == math.huge or y == -math.huge then y = x + (t_next - t_curr) * v end
        xt[i] = y
    end
end
