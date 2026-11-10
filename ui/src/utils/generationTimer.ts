/**
 * generationTimer.ts — queue-aware timing for audio generation jobs.
 *
 * The C++ engine runs one generation at a time (single GPU), so jobs submitted
 * while another is running sit in the server queue as `status: 'pending'` until
 * the engine picks them up. The displayed elapsed time and the client-side
 * timeout must therefore measure REAL generation time — not the time spent
 * waiting in the queue — otherwise a deep queue makes later jobs show inflated
 * timers and trip the timeout before they ever start generating (issue #64).
 *
 * `createGenerationTimer()` is the single source of truth for that rule: the
 * elapsed clock and the timeout only start once the server reports a non-pending
 * status. Every poll loop (Create queue, Lyric Studio, Cover, Repaint, InstaGen)
 * feeds it the latest status via `tick()` and uses the returned values.
 */

/** Read the generation timeout (minutes) from localStorage settings.
 *  Mirrors SettingsPanel's clamp/default (30 min, [10, 360]).
 *
 *  The upper bound must stay >= the largest option SettingsPanel offers, or a
 *  saved value above it is silently discarded and the user drops back to 30
 *  (issue #107 — the old [10, 120] range made 120 both the maximum the UI
 *  offered and the ceiling the server clamped to, so the setting could never
 *  buy more than two hours). */
const TIMEOUT_MIN_MINUTES = 10;
const TIMEOUT_MAX_MINUTES = 360;
/** The value Settings starts from. */
export const DEFAULT_GENERATION_TIMEOUT_MINUTES = 30;

export function getGenerationTimeoutMinutes(): number {
  try {
    const raw = localStorage.getItem('ace-settings');
    if (raw) {
      const parsed = JSON.parse(raw);
      // A numeric string counts: settings written by an older build, or by a
      // panel that handed the select's raw value through, must not be read as
      // "no setting" — that silently ran every job on the 30 min default while
      // the Settings page showed the new value.
      const val = typeof parsed.generationTimeoutMinutes === 'string'
        ? Number(parsed.generationTimeoutMinutes)
        : parsed.generationTimeoutMinutes;
      // Clamp rather than discard: a value outside the offered range is still
      // an explicit choice, and dropping it is the same silent reset.
      if (typeof val === 'number' && Number.isFinite(val) && val > 0) {
        return Math.min(TIMEOUT_MAX_MINUTES, Math.max(TIMEOUT_MIN_MINUTES, Math.round(val)));
      }
    }
  } catch { /* ignore parse errors */ }
  return DEFAULT_GENERATION_TIMEOUT_MINUTES;
}

/** Server job statuses that mean "still waiting in the queue, not yet running".
 *  Anything else (lm_running, synth_running, saving, …) counts as started. */
function isQueued(status: string | undefined): boolean {
  return status == null || status === 'pending' || status === 'queued';
}

export interface GenerationTimerTick {
  /** True once the engine has actually started this job (status left 'pending'). */
  started: boolean;
  /** Seconds of real generation time — 0 while the job is still queued. */
  elapsed: number;
  /** True once real generation time exceeds the timeout. Never true while queued. */
  timedOut: boolean;
}

export interface GenerationTimerOptions {
  /** Override the timeout (minutes). Defaults to the user's configured setting. */
  timeoutMinutes?: number;
  /** Seconds already elapsed before this timer was created (reconnect/resume).
   *  A positive value implies the job was already running, so the clock starts
   *  immediately rather than waiting for the next non-pending status. */
  resumeElapsedSec?: number;
  /** Clock source — injectable for tests. Defaults to Date.now. */
  now?: () => number;
}

export interface GenerationTimer {
  /** The limit this timer enforces, in minutes. Messages must quote this rather
   *  than re-reading Settings: a value changed mid-job does not move the timer,
   *  so the old reading reported a limit that never fired. */
  readonly timeoutMinutes: number;
  /** Feed the latest server job status. Call once per poll iteration. */
  tick(status: string | undefined): GenerationTimerTick;
}

/** Create a timer whose elapsed/timeout clock ignores server-queue wait time. */
export function createGenerationTimer(options: GenerationTimerOptions = {}): GenerationTimer {
  const now = options.now ?? (() => Date.now());
  const timeoutMinutes = options.timeoutMinutes ?? getGenerationTimeoutMinutes();
  const timeoutMs = timeoutMinutes * 60_000;

  let startedAt: number | null =
    options.resumeElapsedSec && options.resumeElapsedSec > 0
      ? now() - options.resumeElapsedSec * 1000
      : null;

  return {
    timeoutMinutes,
    tick(status: string | undefined): GenerationTimerTick {
      if (startedAt === null && !isQueued(status)) startedAt = now();
      if (startedAt === null) return { started: false, elapsed: 0, timedOut: false };
      const elapsedMs = now() - startedAt;
      return {
        started: true,
        elapsed: Math.round(elapsedMs / 1000),
        timedOut: elapsedMs > timeoutMs,
      };
    },
  };
}
