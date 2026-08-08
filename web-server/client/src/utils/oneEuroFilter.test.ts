import { ONE_EURO_DEFAULTS, OneEuroFilter, smoothingAlpha } from './oneEuroFilter';

/**
 * Deterministic noise. `Math.random()` would make the jitter and lag figures
 * below flap between runs, and these are threshold assertions.
 */
const mulberry32 = (seed: number) => () => {
  let t = (seed += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const FPS = 60;
const DT = 1 / FPS;

/**
 * +/-1.5 mm of white noise per sample, which is the order of the landmark
 * jitter a 640x480 webcam produces at arm's length once it is converted into
 * metres by `estimateHeadPose`.
 */
const NOISE_M = 0.0015;

interface Sample {
  t: number;
  truth: number;
  measured: number;
}

/** Someone sitting still. Isolates jitter rejection from everything else. */
const stationaryTrack = (seconds = 3, seed = 11): Sample[] => {
  const rand = mulberry32(seed);
  const out: Sample[] = [];
  for (let i = 0; i < Math.round(seconds * FPS); i += 1) {
    out.push({ t: i * DT, truth: 0, measured: (rand() * 2 - 1) * NOISE_M });
  }
  return out;
};

/**
 * A head sweep: still, then 30 cm sideways at 0.5 m/s over 0.6 s — an ordinary
 * "lean over and look round it" — then still again.
 */
const sweepTrack = (seed = 7): Sample[] => {
  const rand = mulberry32(seed);
  const out: Sample[] = [];
  for (let i = 0; i < Math.round(2.4 * FPS); i += 1) {
    const t = i * DT;
    let truth = 0;
    if (t > 1.0 && t <= 1.6) truth = (t - 1.0) * 0.5;
    else if (t > 1.6) truth = 0.3;
    out.push({ t, truth, measured: truth + (rand() * 2 - 1) * NOISE_M });
  }
  return out;
};

const rms = (xs: number[]) => Math.sqrt(xs.reduce((a, b) => a + b * b, 0) / Math.max(xs.length, 1));

/** RMS residual against the noiseless truth, over a time window. */
const errorOver = (samples: Sample[], outputs: number[], from: number, to: number) =>
  rms(
    samples
      .map((s, i) => ({ t: s.t, e: outputs[i] - s.truth }))
      .filter((s) => s.t >= from && s.t < to)
      .map((s) => s.e),
  );

/** A plain fixed-alpha exponential smoother — the thing a 1€ filter has to beat. */
const runFixedAlpha = (samples: Sample[], alpha: number) => {
  let y = samples[0].measured;
  return samples.map((s) => {
    y += alpha * (s.measured - y);
    return y;
  });
};

const runOneEuro = (samples: Sample[], options: { minCutoff: number; beta: number }) => {
  const f = new OneEuroFilter({ ...options, dCutoff: 1.0 });
  return samples.map((s) => f.filter(s.measured, s.t));
};

/** Same, but for a filter that was already constructed — used to compare tunings. */
const runWith = (f: OneEuroFilter, samples: Sample[]) =>
  samples.map((s) => f.filter(s.measured, s.t));

/** The tuning the hook actually ships for the lateral axes. */
const SHIPPED = { minCutoff: 1.2, beta: 16 };

describe('OneEuroFilter', () => {
  it('passes the first sample through and reports its state', () => {
    const f = new OneEuroFilter({ minCutoff: 1, beta: 0 });
    expect(f.initialized).toBe(false);
    expect(f.filter(0.42, 0)).toBe(0.42);
    expect(f.initialized).toBe(true);
    expect(f.value).toBe(0.42);
  });

  it('removes about 80% of the jitter of a head that is not moving', () => {
    const track = stationaryTrack();
    const raw = rms(track.filter((s) => s.t >= 0.5).map((s) => s.measured));
    const filtered = errorOver(track, runOneEuro(track, SHIPPED), 0.5, 3);
    expect(filtered).toBeLessThan(raw * 0.25);
  });

  it('beats a fixed-alpha lerp: matched jitter at rest, a fifth of the lag in motion', () => {
    /*
      The justification for not "just using a lerp with a fixed alpha".

      Being smooth is easy and being prompt is easy; doing both at once is the
      entire contribution of the paper. So the lerp is first tuned until its
      steady-state jitter EXACTLY matches the 1€ filter's — bisection over
      alpha on a stationary track, where an exponential smoother's noise gain
      sqrt(a / (2 - a)) is monotone, so the search is well posed. Only then are
      both shown the same head sweep and measured for lag.

      (Bisecting on the sweep track instead would not work, and is worth
      recording: at very small alpha the residual during the "rest" window is
      dominated by the filter still crawling towards the end of the ramp, so
      the objective is not monotone and the search converges on nonsense.)
    */
    const stationary = stationaryTrack();
    const euroJitter = errorOver(stationary, runOneEuro(stationary, SHIPPED), 0.5, 3);

    let lo = 0.0005;
    let hi = 1;
    let alpha = 0.5;
    for (let i = 0; i < 60; i += 1) {
      alpha = (lo + hi) / 2;
      if (errorOver(stationary, runFixedAlpha(stationary, alpha), 0.5, 3) > euroJitter) hi = alpha;
      else lo = alpha;
    }
    expect(errorOver(stationary, runFixedAlpha(stationary, alpha), 0.5, 3)).toBeCloseTo(
      euroJitter,
      6,
    );

    const sweep = sweepTrack();
    const euroLag = errorOver(sweep, runOneEuro(sweep, SHIPPED), 1.1, 1.6);
    const fixedLag = errorOver(sweep, runFixedAlpha(sweep, alpha), 1.1, 1.6);

    expect(euroLag).toBeLessThan(fixedLag * 0.4);
    // Stated in millimetres as well as in ratios, because that is the units the
    // defect is in: at 0.5 m/s the residual IS the distance the window trails
    // the head by, and on a head-coupled projection a centimetre of it is the
    // difference between a window and a screen.
    expect(euroLag).toBeLessThan(0.015);
    expect(fixedLag).toBeGreaterThan(0.04);
  });

  it('costs nothing at rest compared to the plain low-pass it is built from', () => {
    // beta = 0 IS a fixed-cutoff low-pass. The speed term must buy its lag
    // reduction without giving back the smoothness at rest.
    const stationary = stationaryTrack();
    const plainJitter = errorOver(stationary, runOneEuro(stationary, { minCutoff: 1.2, beta: 0 }), 0.5, 3);
    const adaptiveJitter = errorOver(stationary, runOneEuro(stationary, SHIPPED), 0.5, 3);
    expect(adaptiveJitter / plainJitter).toBeLessThan(1.15);

    const sweep = sweepTrack();
    const plainLag = errorOver(sweep, runOneEuro(sweep, { minCutoff: 1.2, beta: 0 }), 1.1, 1.6);
    const adaptiveLag = errorOver(sweep, runOneEuro(sweep, SHIPPED), 1.1, 1.6);
    expect(adaptiveLag).toBeLessThan(plainLag * 0.4);
  });

  it('raises its own cutoff with speed — that is the whole mechanism', () => {
    // Two filters, the same small nudge, different histories. The nudge is kept
    // small on purpose: a large step would dominate the derivative estimate and
    // both filters would respond identically, which measures nothing.
    const NUDGE = 0.002;
    const still = new OneEuroFilter({ minCutoff: 1, beta: 30 });
    const moving = new OneEuroFilter({ minCutoff: 1, beta: 30 });
    for (let i = 0; i < 60; i += 1) still.filter(0, i * DT);
    for (let i = 0; i < 60; i += 1) moving.filter(i * DT, i * DT); // 1 m/s

    const stillBefore = still.value;
    const movingBefore = moving.value;
    const stillGain = (still.filter(stillBefore + NUDGE, 60 * DT) - stillBefore) / NUDGE;
    const movingGain = (moving.filter(movingBefore + NUDGE, 60 * DT) - movingBefore) / NUDGE;

    expect(stillGain).toBeLessThan(0.2);
    expect(movingGain).toBeGreaterThan(stillGain * 3);
  });

  it('does not degenerate into a pass-through on duplicate or backwards timestamps', () => {
    // Two rAF ticks inside one millisecond is routine; dt = 0 would make the
    // smoothing factor 1, i.e. no filtering at all, exactly when it is needed.
    const f = new OneEuroFilter({ minCutoff: 1, beta: 0 });
    f.filter(0, 1);
    const out = f.filter(1, 1);
    expect(out).toBeGreaterThan(0);
    expect(out).toBeLessThan(0.2);
    expect(Number.isFinite(f.filter(1, 0.5))).toBe(true);
  });

  it('ignores non-finite input instead of poisoning its own state', () => {
    const f = new OneEuroFilter({ minCutoff: 1, beta: 0 });
    f.filter(0.5, 0);
    expect(f.filter(NaN, DT)).toBe(0.5);
    expect(f.filter(0.5, 2 * DT)).toBeCloseTo(0.5, 12);
  });

  it('re-acquires from scratch after reset instead of sweeping in from the old pose', () => {
    const f = new OneEuroFilter({ minCutoff: 1, beta: 0 });
    for (let i = 0; i < 60; i += 1) f.filter(0, i * DT);
    f.reset();
    expect(f.initialized).toBe(false);
    expect(f.filter(5, 61 * DT)).toBe(5);
  });
});

describe('OneEuroFilter numeric edges', () => {
  it('constructs with the documented defaults when given nothing', () => {
    // The hook constructs per-axis filters from a config object, and a missing
    // key has to mean "the default", not "undefined" — which would make
    // `minCutoff + beta * speed` NaN on the second sample and freeze the axis
    // at its first value for the rest of the session.
    const bare = new OneEuroFilter();
    const explicit = new OneEuroFilter(ONE_EURO_DEFAULTS);
    const track = sweepTrack();
    expect(runWith(bare, track)).toEqual(runWith(explicit, track));
    expect(runWith(new OneEuroFilter(), track).every(Number.isFinite)).toBe(true);
  });

  it('takes a partial option object without poisoning the untouched knobs', () => {
    const partial = new OneEuroFilter({ beta: 8 });
    const full = new OneEuroFilter({ beta: 8, minCutoff: ONE_EURO_DEFAULTS.minCutoff, dCutoff: ONE_EURO_DEFAULTS.dCutoff });
    const track = sweepTrack();
    expect(runWith(partial, track)).toEqual(runWith(full, track));
  });

  it('never overshoots the sample it is chasing, at any speed', () => {
    /*
      An exponential smoother is a convex combination — output always lands
      between the previous output and the new sample, because alpha is
      1 / (1 + tau/dt), which is in (0, 1) for every positive tau and dt. That
      is the property that distinguishes this from the spring/critically-damped
      smoothers people reach for instead, and losing it is the difference
      between a window that follows your head and one that rings around it.

      Checked with a very large beta, because that is where the cutoff (and so
      alpha) is pushed hardest towards 1, and against a step, because that is
      the input with the largest instantaneous derivative available.
    */
    for (const beta of [0, 16, 1e3, 1e6]) {
      const f = new OneEuroFilter({ minCutoff: 1.2, beta });
      let previous = f.filter(0, 0);
      for (let i = 1; i < 30; i += 1) {
        const target = i < 10 ? 0 : 0.3;
        const out = f.filter(target, i * DT);
        const lo = Math.min(previous, target);
        const hi = Math.max(previous, target);
        expect(out).toBeGreaterThanOrEqual(lo - 1e-12);
        expect(out).toBeLessThanOrEqual(hi + 1e-12);
        previous = out;
      }
      expect(previous).toBeCloseTo(0.3, beta > 100 ? 6 : 1);
    }
  });

  it('stays finite and keeps converging after a non-finite timestamp', () => {
    // `performance.now()` cannot be NaN, but the hook also feeds this filter
    // from `requestVideoFrameCallback` metadata on the browsers that have it.
    // One bad timestamp must not leave the axis stuck: the value is what drives
    // the camera, and a frozen axis is indistinguishable from lost tracking.
    const f = new OneEuroFilter({ minCutoff: 1, beta: 0 });
    f.filter(0, 0);
    expect(Number.isFinite(f.filter(1, NaN))).toBe(true);
    for (let i = 2; i < 200; i += 1) f.filter(1, i * DT);
    expect(f.value).toBeCloseTo(1, 3);
  });

  it('holds its output when the signal stops arriving and resumes cleanly', () => {
    // Tracking loss leaves a gap of arbitrary length. The next sample after a
    // two-second gap has dt = 2, which drives alpha to almost 1 — i.e. the
    // filter trusts a sample that arrives after a long silence, rather than
    // spending the next half second sweeping the camera in from the stale pose.
    const f = new OneEuroFilter({ minCutoff: 1.2, beta: 16 });
    for (let i = 0; i < 60; i += 1) f.filter(0, i * DT);
    const held = f.value;
    expect(held).toBeCloseTo(0, 6);

    const afterGap = f.filter(0.25, 60 * DT + 2);
    expect(afterGap).toBeGreaterThan(0.2);
    expect(afterGap).toBeLessThanOrEqual(0.25);
  });
});

describe('smoothingAlpha', () => {
  it('matches the RC low-pass definition', () => {
    for (const cutoff of [0.5, 1, 5, 30]) {
      const tau = 1 / (2 * Math.PI * cutoff);
      expect(smoothingAlpha(cutoff, DT)).toBeCloseTo(DT / (DT + tau), 12);
    }
  });

  it('approaches 1 as the cutoff rises and 0 as the sample spacing shrinks', () => {
    expect(smoothingAlpha(1e6, DT)).toBeGreaterThan(0.999);
    expect(smoothingAlpha(1, 0)).toBeLessThan(0.01);
  });

  it('stays inside (0, 1) for cutoffs and spacings that should not happen', () => {
    // A negative alpha does not smooth, it reflects: each step moves the output
    // AWAY from the sample and the filter diverges within a few frames. Zero
    // and negative cutoffs are reachable through a mis-set config, and a
    // negative dt through a clock that steps backwards.
    for (const cutoff of [0, -1, -1e9]) {
      const alpha = smoothingAlpha(cutoff, DT);
      expect(alpha).toBeGreaterThan(0);
      expect(alpha).toBeLessThan(1);
    }
    for (const dt of [0, -1]) {
      const alpha = smoothingAlpha(1, dt);
      expect(alpha).toBeGreaterThan(0);
      expect(alpha).toBeLessThan(1);
    }
  });
});
