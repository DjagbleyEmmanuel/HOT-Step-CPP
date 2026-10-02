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

-- Pingpong sampler for rectified flow (x_t = (1-t) x0 + t eps).
-- Mirrors the native SA3 pingpong step:
--   denoised = x - t v
--   x_next   = (1 - t_next) denoised + t_next z,  z fresh Gaussian noise
-- The last step (t_next = 0) returns denoised.
-- v1.1: renoise knob removed and fixed at 1.0. Ear tests on SA3 scored any
-- renoise below 1.0 at quality 1, and values above 1.0 have no meaning in the
-- variance-preserving mix. Best at 8 steps on SA3.
-- Marked stochastic so the SA3 engine's own renoise wrapper stays out of the
-- way; works on any rectified-flow backend (ACE, SA3).
-- z comes from math.random via Box-Muller; the engine seeds the Lua RNG from
-- the job seed, so a fixed seed gives a fixed render.

solver = {
    name = "md_pingpong_blend",
    version = "1.1",
    display = "MD Pingpong Blend",
    description = "Pingpong sampler (full fresh renoise each step). Recommended default for SA3 at 8 steps.",
    nfe = 1,
    order = 1,
    needs_model = false,
    stateful = false,
    stochastic = true,
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

    if t_next <= 0.0 then
        for i = 0, n - 1 do xt[i] = xt[i] - t_curr * vt[i] end
        return
    end

    for i = 0, n - 1 do
        local x, v = xt[i], vt[i]
        local den = x - t_curr * v
        local y = (1.0 - t_next) * den + t_next * gauss()
        if y ~= y or y == math.huge or y == -math.huge then y = x + (t_next - t_curr) * v end
        xt[i] = y
    end
end
