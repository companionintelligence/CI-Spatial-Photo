/**
 * The 1€ ("One Euro") filter — Casiez, Roussel & Vogel, CHI 2012.
 *
 * Head tracking has two failure modes that pull in opposite directions, and a
 * single fixed-alpha exponential smoother cannot escape the trade-off:
 *
 *   - Hold still and the raw landmarks wander by a pixel or two per frame. On a
 *     magic window that jitter is amplified by the whole depth of the scene, so
 *     a stationary viewer watches the splat shiver. Fixing THAT wants a low
 *     cutoff (heavy smoothing).
 *   - Move your head and a heavily smoothed signal arrives late. Lag on a
 *     head-coupled projection is the thing that breaks the illusion outright:
 *     the "window" visibly slides to catch up with you, which reads as the
 *     scene moving rather than the viewpoint moving.
 *
 * The 1€ filter is an exponential smoother whose cutoff frequency is a function
 * of the signal's own speed: nearly still -> cutoff `minCutoff`, so jitter is
 * crushed; moving fast -> cutoff rises by `beta` per unit of speed, so lag
 * collapses. Two intuitive parameters, O(1) state, no window buffer, and it
 * needs no future samples — which matters here because this runs inside the
 * webcam frame callback.
 *
 * Why not a fixed-alpha lerp: `oneEuroFilter.test.ts` measures both against the
 * same synthetic signal. To match this filter's jitter rejection at rest, a
 * fixed alpha has to be small enough that it lags a head sweep by several times
 * as much. That test is the justification, not this comment.
 */

export interface OneEuroOptions {
  /**
   * Cutoff frequency (Hz) at zero speed. Lower = smoother at rest, but a longer
   * settle after the signal stops moving.
   */
  minCutoff?: number;
  /**
   * Speed coefficient, in Hz per (signal unit / second). This is the knob that
   * buys back the lag: raise it until fast motion stops feeling delayed, then
   * lower `minCutoff` until a held pose stops shivering.
   */
  beta?: number;
  /** Cutoff (Hz) of the low-pass applied to the derivative estimate itself. */
  dCutoff?: number;
}

export const ONE_EURO_DEFAULTS: Required<OneEuroOptions> = {
  minCutoff: 1.0,
  beta: 0.0,
  dCutoff: 1.0,
};

/**
 * The smoothing factor of a first-order low-pass with the given cutoff, for a
 * sample spacing of `dt` seconds. Derived from the RC time constant
 * `tau = 1 / (2*pi*fc)`; alpha = dt / (dt + tau).
 *
 * Written with `tau / dt` rather than `dt / (dt + tau)` so that a very small dt
 * (two landmark results in the same millisecond, which happens when the webcam
 * callback and rAF race) yields alpha -> 0 instead of a 0/0.
 */
export const smoothingAlpha = (cutoffHz: number, dt: number): number => {
  const tau = 1 / (2 * Math.PI * Math.max(cutoffHz, 1e-6));
  return 1 / (1 + tau / Math.max(dt, 1e-6));
};

/** A scalar 1€ filter. One instance per axis; they do not share state. */
export class OneEuroFilter {
  private readonly minCutoff: number;
  private readonly beta: number;
  private readonly dCutoff: number;

  private lastValue = 0;
  private lastFiltered = 0;
  private lastDerivative = 0;
  private lastTime = 0;
  private started = false;

  constructor(options: OneEuroOptions = {}) {
    const { minCutoff, beta, dCutoff } = { ...ONE_EURO_DEFAULTS, ...options };
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
  }

  /** Whether any sample has been accepted since construction or `reset()`. */
  get initialized(): boolean {
    return this.started;
  }

  /** The most recent filtered output. Zero before the first sample. */
  get value(): number {
    return this.lastFiltered;
  }

  /**
   * Feed one sample.
   *
   * @param value             The raw measurement.
   * @param timestampSeconds  Monotonic clock, in SECONDS. Use
   *                          `performance.now() / 1000`, not milliseconds — the
   *                          cutoffs are in Hz and the derivative is per second,
   *                          so a millisecond timestamp silently makes the
   *                          filter behave as if everything moved 1000x slower
   *                          and it degenerates into a fixed, very heavy lerp.
   */
  filter(value: number, timestampSeconds: number): number {
    if (!Number.isFinite(value)) return this.lastFiltered;

    if (!this.started) {
      this.started = true;
      this.lastValue = value;
      this.lastFiltered = value;
      this.lastDerivative = 0;
      this.lastTime = timestampSeconds;
      return value;
    }

    // Non-monotonic or duplicate timestamps are not hypothetical: MediaPipe is
    // driven off `performance.now()` here and two rAF ticks can land in the same
    // millisecond. A dt of 0 would make alpha 1 (pass-through, no smoothing at
    // all) — exactly the jitter this class exists to remove — so floor it.
    const dt = timestampSeconds > this.lastTime ? timestampSeconds - this.lastTime : 1 / 120;
    this.lastTime = timestampSeconds;

    const derivative = (value - this.lastValue) / dt;
    this.lastDerivative =
      this.lastDerivative +
      smoothingAlpha(this.dCutoff, dt) * (derivative - this.lastDerivative);

    const cutoff = this.minCutoff + this.beta * Math.abs(this.lastDerivative);
    this.lastFiltered =
      this.lastFiltered + smoothingAlpha(cutoff, dt) * (value - this.lastFiltered);

    this.lastValue = value;
    return this.lastFiltered;
  }

  /**
   * Forget all history. Called when tracking is lost and again when it is
   * regained, so the filter does not spend half a second sweeping the camera
   * across the room from wherever the last face was to wherever the new one is.
   */
  reset(): void {
    this.started = false;
    this.lastValue = 0;
    this.lastFiltered = 0;
    this.lastDerivative = 0;
    this.lastTime = 0;
  }
}
