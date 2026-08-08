import {
  MM_PER_INCH,
  MIN_DIAGONAL_INCHES,
  MAX_DIAGONAL_INCHES,
  isValidDiagonalInches,
  monitorSizeMm,
  computeScreenMetrics,
  canvasRectMetres,
  measureCanvasRectMetres,
  readScreenSize,
  DISPLAY_DIAGONAL_STORAGE_KEY,
  readStoredDiagonalInches,
  writeStoredDiagonalInches,
  getDisplayDiagonalInches,
  setDisplayDiagonalInches,
  subscribeDisplayCalibration,
  resetDisplayCalibrationCache,
} from './screenGeometry';

/**
 * The unit chain is the whole module, so it is tested against numbers computed
 * by hand rather than against a re-implementation of the same formula — a
 * re-implementation would agree with a transposed aspect or a stray
 * `devicePixelRatio` just as happily as with the right answer.
 *
 * Three real displays, with the millimetre figures worked out from
 * `h = D * 25.4 / sqrt(a^2 + 1)`, `w = a * h`:
 *
 *   27" 16:9 @ 2560x1440   D = 685.80 mm   h = 336.221158   w = 597.726503
 *   13" 16:10 @ 1440x900   D = 330.20 mm   h = 175.005650   w = 280.009040
 *   24" 16:10 @ 1920x1200  D = 609.60 mm   h = 323.087354   w = 516.939766
 *
 * Each one carries a SECOND, independent check: the pixel density these imply
 * are the published figures for those panels — 108.79, 130.62 and 94.34 PPI —
 * and PPI is computed from the pixel diagonal and the inch diagonal without
 * going through the aspect at all. If step 2 of the chain were wrong (aspect
 * transposed, `sqrt(a^2+1)` mis-derived) the millimetres and the PPI would stop
 * agreeing, which no single assertion can catch on its own.
 */
interface Display {
  label: string;
  diagonalInches: number;
  cssWidth: number;
  cssHeight: number;
  widthMm: number;
  heightMm: number;
  mmPerCssPx: number;
  /** Published pixel density, cross-checked below from the pixel diagonal. */
  ppi: number;
}

const MONITOR_27: Display = {
  label: '27-inch 16:9 @ 2560x1440',
  diagonalInches: 27,
  cssWidth: 2560,
  cssHeight: 1440,
  widthMm: 597.726503,
  heightMm: 336.221158,
  mmPerCssPx: 0.2334869154,
  ppi: 108.7855,
};

const LAPTOP_13: Display = {
  label: '13-inch 16:10 @ 1440x900',
  diagonalInches: 13,
  cssWidth: 1440,
  cssHeight: 900,
  widthMm: 280.009040,
  heightMm: 175.005650,
  mmPerCssPx: 0.1944507222,
  ppi: 130.6244,
};

const MONITOR_24: Display = {
  label: '24-inch 16:10 @ 1920x1200',
  diagonalInches: 24,
  cssWidth: 1920,
  cssHeight: 1200,
  widthMm: 516.939766,
  heightMm: 323.087354,
  mmPerCssPx: 0.2692394615,
  ppi: 94.3398,
};

const DISPLAYS = [MONITOR_27, LAPTOP_13, MONITOR_24];

const screenOf = (d: Display) => ({ cssWidth: d.cssWidth, cssHeight: d.cssHeight });

describe('monitorSizeMm — diagonal inches to physical width and height', () => {
  it('produces the hand-computed millimetres for real displays', () => {
    for (const d of DISPLAYS) {
      const size = monitorSizeMm(d.diagonalInches, {
        width: d.cssWidth,
        height: d.cssHeight,
      });
      expect(size).not.toBeNull();
      // 1e-4 mm is a tenth of a micron; the tolerance is only here because the
      // expected values above are written to six decimal places.
      expect(size!.widthMm).toBeCloseTo(d.widthMm, 4);
      expect(size!.heightMm).toBeCloseTo(d.heightMm, 4);
    }
  });

  it('returns a rectangle whose diagonal really is the diagonal it was given', () => {
    // Pythagoras is the definition the derivation is inverting, so asserting it
    // catches any algebra slip in `sqrt(a^2 + 1)` regardless of aspect.
    for (const d of DISPLAYS) {
      const size = monitorSizeMm(d.diagonalInches, { width: d.cssWidth, height: d.cssHeight })!;
      const diagonal = Math.sqrt(size.widthMm ** 2 + size.heightMm ** 2);
      expect(diagonal).toBeCloseTo(d.diagonalInches * MM_PER_INCH, 9);
      expect(size.widthMm / size.heightMm).toBeCloseTo(d.cssWidth / d.cssHeight, 12);
    }
  });

  it('implies the published pixel density of each panel', () => {
    // PPI from the pixel diagonal never touches the aspect maths, so this is a
    // genuinely independent oracle for the millimetres above.
    for (const d of DISPLAYS) {
      const size = monitorSizeMm(d.diagonalInches, { width: d.cssWidth, height: d.cssHeight })!;
      const pixelDiagonal = Math.hypot(d.cssWidth, d.cssHeight);
      expect(pixelDiagonal / d.diagonalInches).toBeCloseTo(d.ppi, 3);
      expect(MM_PER_INCH / (size.widthMm / d.cssWidth)).toBeCloseTo(d.ppi, 3);
    }
  });

  it('reproduces the 16:9 shorthand quoted in the derivation', () => {
    // The comment claims "for 16:9 that is D * 0.8716 by D * 0.4903". If someone
    // ever replaces the general form with those constants, this pins them.
    const size = monitorSizeMm(100, { width: 16, height: 9 })!;
    expect(size.widthMm / (100 * MM_PER_INCH)).toBeCloseTo(0.871576, 6);
    expect(size.heightMm / (100 * MM_PER_INCH)).toBeCloseTo(0.490261, 6);
  });

  it('uses the aspect it is given, not the one it could guess', () => {
    // A 3:2 Surface and a 21:9 ultrawide of the same diagonal are very
    // different widths. Getting this wrong biases the parallax gain directly.
    const surface = monitorSizeMm(13, { width: 3, height: 2 })!;
    const ultrawide = monitorSizeMm(13, { width: 21, height: 9 })!;
    expect(surface.widthMm).toBeCloseTo(274.743007, 4);
    expect(ultrawide.widthMm).toBeCloseTo(303.501689, 4);
    // Same diagonal, wider panel, so it must also be shorter.
    expect(ultrawide.heightMm).toBeLessThan(surface.heightMm);
  });

  it('is scale-free in the aspect: only the ratio is read', () => {
    const a = monitorSizeMm(27, { width: 16, height: 9 })!;
    const b = monitorSizeMm(27, { width: 2560, height: 1440 })!;
    expect(a.widthMm).toBeCloseTo(b.widthMm, 12);
    expect(a.heightMm).toBeCloseTo(b.heightMm, 12);
  });

  it('refuses a diagonal that cannot be a display', () => {
    const aspect = { width: 16, height: 9 };
    for (const bad of [0, -27, NaN, Infinity, -Infinity]) {
      expect(monitorSizeMm(bad, aspect)).toBeNull();
    }
    // Out of the sane band. A mistyped "270" is the one that matters: it would
    // silently make the calibrated parallax ten times too weak rather than
    // failing, and read as the feature being broken.
    expect(monitorSizeMm(3.9, aspect)).toBeNull();
    expect(monitorSizeMm(270, aspect)).toBeNull();
    // The bounds themselves are inclusive.
    expect(monitorSizeMm(MIN_DIAGONAL_INCHES, aspect)).not.toBeNull();
    expect(monitorSizeMm(MAX_DIAGONAL_INCHES, aspect)).not.toBeNull();
  });

  it('refuses a degenerate aspect rather than dividing by zero', () => {
    for (const bad of [
      { width: 0, height: 9 },
      { width: 16, height: 0 },
      { width: -16, height: 9 },
      { width: NaN, height: 9 },
      { width: 16, height: Infinity },
    ]) {
      expect(monitorSizeMm(27, bad)).toBeNull();
    }
  });

  it('rejects non-numeric input that TypeScript cannot stop at runtime', () => {
    // The diagonal arrives from a text input and from localStorage, both of
    // which are `string` at the boundary; `isValidDiagonalInches` is the guard.
    expect(isValidDiagonalInches('27' as unknown)).toBe(false);
    expect(isValidDiagonalInches(null)).toBe(false);
    expect(isValidDiagonalInches(undefined)).toBe(false);
    expect(isValidDiagonalInches(27)).toBe(true);
  });
});

describe('computeScreenMetrics — millimetres per CSS pixel', () => {
  it('matches the hand-computed mm-per-CSS-pixel of each display', () => {
    for (const d of DISPLAYS) {
      const m = computeScreenMetrics({ diagonalInches: d.diagonalInches, screen: screenOf(d) })!;
      expect(m).not.toBeNull();
      expect(m.mmPerCssPxX).toBeCloseTo(d.mmPerCssPx, 9);
      // Square pixels: the two axes must agree when the aspect is derived from
      // the resolution. If they ever diverge here, step 2 and step 3 disagree.
      expect(m.mmPerCssPxY).toBeCloseTo(m.mmPerCssPxX, 12);
      expect(m.monitorWidthMm).toBeCloseTo(d.widthMm, 4);
      expect(m.monitorHeightMm).toBeCloseTo(d.heightMm, 4);
      expect(m.diagonalInches).toBe(d.diagonalInches);
      expect(m.screenCssWidth).toBe(d.cssWidth);
      expect(m.screenCssHeight).toBe(d.cssHeight);
    }
  });

  it('keeps the axes honest when a supplied aspect contradicts the resolution', () => {
    // A 21:9 ultrawide running a 16:9 desktop mode has non-square pixels. The
    // module deliberately does not average the two axes away, so x and y must
    // come out different — and each must still reconstruct its own dimension.
    const m = computeScreenMetrics({
      diagonalInches: 34,
      screen: { cssWidth: 2560, cssHeight: 1440 },
      aspect: { width: 21, height: 9 },
    })!;
    expect(m.mmPerCssPxX).not.toBeCloseTo(m.mmPerCssPxY, 6);
    expect(m.mmPerCssPxX * 2560).toBeCloseTo(m.monitorWidthMm, 9);
    expect(m.mmPerCssPxY * 1440).toBeCloseTo(m.monitorHeightMm, 9);
    expect(m.monitorWidthMm / m.monitorHeightMm).toBeCloseTo(21 / 9, 12);
  });

  it('falls back to the resolution aspect when the override is unusable', () => {
    const derived = computeScreenMetrics({ diagonalInches: 27, screen: screenOf(MONITOR_27) })!;
    for (const bad of [null, undefined, { width: 0, height: 9 }, { width: NaN, height: NaN }]) {
      const m = computeScreenMetrics({
        diagonalInches: 27,
        screen: screenOf(MONITOR_27),
        aspect: bad as never,
      })!;
      expect(m.mmPerCssPxX).toBeCloseTo(derived.mmPerCssPxX, 12);
    }
  });

  it('returns null for a screen the browser reports as zero-sized', () => {
    // jsdom does exactly this, and so can a headless capture before first
    // layout. Null is what lets the caller stay on the uncalibrated projection
    // instead of rendering a confidently wrong one.
    for (const screen of [
      { cssWidth: 0, cssHeight: 0 },
      { cssWidth: 2560, cssHeight: 0 },
      { cssWidth: -2560, cssHeight: 1440 },
      { cssWidth: NaN, cssHeight: 1440 },
      { cssWidth: Infinity, cssHeight: 1440 },
    ]) {
      expect(computeScreenMetrics({ diagonalInches: 27, screen })).toBeNull();
    }
  });

  it('returns null for a bad diagonal even when the screen is fine', () => {
    for (const bad of [0, -13, NaN, 1000]) {
      expect(
        computeScreenMetrics({ diagonalInches: bad, screen: screenOf(MONITOR_27) }),
      ).toBeNull();
    }
  });
});

describe('devicePixelRatio and browser zoom', () => {
  const originalDpr = window.devicePixelRatio;
  afterEach(() => {
    Object.defineProperty(window, 'devicePixelRatio', {
      configurable: true,
      value: originalDpr,
    });
  });

  const setDpr = (value: number) =>
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value });

  it('is completely unaffected by devicePixelRatio', () => {
    // `screen.width` is already in CSS pixels on a Retina panel (1512, not
    // 3024). The module must never read dpr; this asserts it cannot have,
    // because the answer does not move when dpr does.
    const reference = computeScreenMetrics({
      diagonalInches: 13,
      screen: screenOf(LAPTOP_13),
    })!;
    for (const dpr of [1, 2, 2.5, 3]) {
      setDpr(dpr);
      const m = computeScreenMetrics({ diagonalInches: 13, screen: screenOf(LAPTOP_13) })!;
      expect(m.mmPerCssPxX).toBe(reference.mmPerCssPxX);
      expect(m.mmPerCssPxY).toBe(reference.mmPerCssPxY);
    }
  });

  it('would give a visibly different answer if dpr HAD been applied', () => {
    // Proof that the test above is not vacuous: the wrong answer is a factor of
    // dpr away, not a rounding difference. On a 2x Retina panel it halves the
    // canvas rect, which halves the calibrated parallax — plausible enough to
    // survive review, which is why it is spelled out here as well as in the
    // module comment.
    const m = computeScreenMetrics({ diagonalInches: 13, screen: screenOf(LAPTOP_13) })!;
    const wrong = computeScreenMetrics({
      diagonalInches: 13,
      screen: { cssWidth: LAPTOP_13.cssWidth * 2, cssHeight: LAPTOP_13.cssHeight * 2 },
    })!;
    expect(wrong.mmPerCssPxX).toBeCloseTo(m.mmPerCssPxX / 2, 12);
  });

  it('cancels browser zoom exactly, because both operands are CSS pixels', () => {
    // At 200% zoom Chromium reports half as many CSS pixels for `screen.width`
    // AND for `clientWidth`. The canvas rect is the monitor width times the
    // FRACTION of the screen the canvas covers, so the zoom divides out. Not
    // "approximately" — the assertion is exact equality of the metres.
    const canvasFractionW = 1600 / MONITOR_27.cssWidth;
    const canvasFractionH = 900 / MONITOR_27.cssHeight;
    let unzoomed: { widthM: number; heightM: number } | null = null;

    for (const zoom of [1, 1.25, 2, 0.5]) {
      const rect = measureCanvasRectMetres({
        diagonalInches: 27,
        screen: {
          cssWidth: MONITOR_27.cssWidth / zoom,
          cssHeight: MONITOR_27.cssHeight / zoom,
        },
        cssWidth: (MONITOR_27.cssWidth * canvasFractionW) / zoom,
        cssHeight: (MONITOR_27.cssHeight * canvasFractionH) / zoom,
      })!;
      if (!unzoomed) unzoomed = rect;
      expect(rect.widthM).toBeCloseTo(unzoomed.widthM, 12);
      expect(rect.heightM).toBeCloseTo(unzoomed.heightM, 12);
    }
    expect(unzoomed!.widthM).toBeCloseTo(0.3735790646, 9);
  });
});

describe('canvasRectMetres — the canvas rectangle in metres', () => {
  const metrics27 = computeScreenMetrics({
    diagonalInches: 27,
    screen: screenOf(MONITOR_27),
  })!;

  it('gives the full panel when the canvas fills the screen', () => {
    const rect = canvasRectMetres(metrics27, MONITOR_27.cssWidth, MONITOR_27.cssHeight)!;
    expect(rect.widthM).toBeCloseTo(MONITOR_27.widthMm / 1000, 7);
    expect(rect.heightM).toBeCloseTo(MONITOR_27.heightMm / 1000, 7);
    expect(rect.halfWidthM).toBeCloseTo(rect.widthM / 2, 12);
    expect(rect.halfHeightM).toBeCloseTo(rect.heightM / 2, 12);
  });

  it('scales linearly with the fraction of the screen the canvas covers', () => {
    // 1600x900 CSS px of a 2560x1440 27-inch panel: 1600 * 0.2334869154 mm.
    const rect = canvasRectMetres(metrics27, 1600, 900)!;
    expect(rect.widthM).toBeCloseTo(0.3735790646, 9);
    expect(rect.heightM).toBeCloseTo(0.2101382238, 9);
    // The canvas rect's own aspect must equal the canvas's pixel aspect, which
    // is what lets `computeWindowGeometry` carry only the half-HEIGHT and pin
    // the half-width to the viewport aspect.
    expect(rect.widthM / rect.heightM).toBeCloseTo(1600 / 900, 12);
  });

  it('inflates by exactly the pixel ratio if handed the backing store size', () => {
    // The mistake the module comment names: `canvas.width` is
    // `clientWidth * devicePixelRatio`, not `clientWidth`. On a 2x panel it
    // doubles the rect, which HALVES the calibrated parallax. Documented here
    // so the failure has a numeric signature rather than a vibe.
    const right = canvasRectMetres(metrics27, 1600, 900)!;
    const backingStore = canvasRectMetres(metrics27, 1600 * 2, 900 * 2)!;
    expect(backingStore.widthM / right.widthM).toBeCloseTo(2, 12);
  });

  it('returns null for a canvas that has no size yet', () => {
    for (const [w, h] of [
      [0, 900],
      [1600, 0],
      [-1600, 900],
      [NaN, 900],
      [Infinity, 900],
    ]) {
      expect(canvasRectMetres(metrics27, w, h)).toBeNull();
    }
  });

  it('measureCanvasRectMetres is exactly the two steps composed', () => {
    const composed = canvasRectMetres(metrics27, 1600, 900)!;
    const oneShot = measureCanvasRectMetres({
      diagonalInches: 27,
      screen: screenOf(MONITOR_27),
      cssWidth: 1600,
      cssHeight: 900,
    })!;
    expect(oneShot.widthM).toBe(composed.widthM);
    expect(oneShot.heightM).toBe(composed.heightM);
  });

  it('measureCanvasRectMetres propagates null from either step', () => {
    expect(
      measureCanvasRectMetres({
        diagonalInches: 27,
        screen: { cssWidth: 0, cssHeight: 0 },
        cssWidth: 1600,
        cssHeight: 900,
      }),
    ).toBeNull();
    expect(
      measureCanvasRectMetres({
        diagonalInches: 270,
        screen: screenOf(MONITOR_27),
        cssWidth: 1600,
        cssHeight: 900,
      }),
    ).toBeNull();
    expect(
      measureCanvasRectMetres({
        diagonalInches: 27,
        screen: screenOf(MONITOR_27),
        cssWidth: 0,
        cssHeight: 900,
      }),
    ).toBeNull();
  });
});

/* ────────────────────────────────────────────────────────────────────────────
   Hostile environments.

   These are the cases that decide whether a missing calibration is a degraded
   feature or a blank page. The bar is the same in every one: no throw, and a
   null that the caller can read as "uncalibrated".
   ──────────────────────────────────────────────────────────────────────────── */

const originalScreenDescriptor = Object.getOwnPropertyDescriptor(window, 'screen');
const originalStorageDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');

const replaceWindowProperty = (name: 'screen' | 'localStorage', get: () => unknown) => {
  Object.defineProperty(window, name, { configurable: true, get });
};

const restoreWindowProperty = (
  name: 'screen' | 'localStorage',
  descriptor: PropertyDescriptor | undefined,
) => {
  if (descriptor) Object.defineProperty(window, name, descriptor);
  else delete (window as unknown as Record<string, unknown>)[name];
};

describe('readScreenSize', () => {
  afterEach(() => restoreWindowProperty('screen', originalScreenDescriptor));

  it('returns null on jsdom, whose screen is 0x0', () => {
    // Not an artefact of the test rig — this is the real reason the whole
    // module has a null path, and it is the state the product-video capture
    // runs in. Nothing may throw here.
    expect(window.screen.width).toBe(0);
    expect(readScreenSize()).toBeNull();
  });

  it('reads a real screen through unchanged', () => {
    replaceWindowProperty('screen', () => ({ width: 2560, height: 1440 }));
    expect(readScreenSize()).toEqual({ cssWidth: 2560, cssHeight: 1440 });
  });

  it('returns null when window.screen is missing entirely', () => {
    replaceWindowProperty('screen', () => undefined);
    expect(readScreenSize()).toBeNull();
  });

  it('returns null for a screen reporting nonsense', () => {
    for (const fake of [
      { width: 0, height: 0 },
      { width: 2560, height: NaN },
      { width: '2560', height: '1440' },
      {},
    ]) {
      replaceWindowProperty('screen', () => fake);
      expect(readScreenSize()).toBeNull();
    }
  });
});

describe('localStorage persistence', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetDisplayCalibrationCache();
  });

  afterEach(() => {
    restoreWindowProperty('localStorage', originalStorageDescriptor);
    window.localStorage.clear();
    resetDisplayCalibrationCache();
  });

  it('round-trips a diagonal', () => {
    writeStoredDiagonalInches(27);
    expect(window.localStorage.getItem(DISPLAY_DIAGONAL_STORAGE_KEY)).toBe('27');
    expect(readStoredDiagonalInches()).toBe(27);

    writeStoredDiagonalInches(13.3);
    expect(readStoredDiagonalInches()).toBeCloseTo(13.3, 12);

    writeStoredDiagonalInches(null);
    expect(window.localStorage.getItem(DISPLAY_DIAGONAL_STORAGE_KEY)).toBeNull();
    expect(readStoredDiagonalInches()).toBeNull();
  });

  it('treats every corrupt stored value as uncalibrated', () => {
    // localStorage is shared with anything else on the origin and survives
    // across app versions, so the stored string is untrusted input.
    for (const raw of [
      '',
      '   ',
      'abc',
      'null',
      'undefined',
      'NaN',
      'Infinity',
      '-27',
      '0',
      '1e999', // parses to Infinity
      '3.9', // below MIN_DIAGONAL_INCHES
      '151', // above MAX_DIAGONAL_INCHES
      '{"diagonalInches":27}',
    ]) {
      window.localStorage.setItem(DISPLAY_DIAGONAL_STORAGE_KEY, raw);
      expect(readStoredDiagonalInches()).toBeNull();
    }
  });

  it('accepts the values a number input actually emits', () => {
    for (const [raw, expected] of [
      ['27', 27],
      ['27.0', 27],
      [' 27 ', 27], // parseFloat skips leading whitespace
      ['13.3', 13.3],
      ['+24', 24],
    ] as const) {
      window.localStorage.setItem(DISPLAY_DIAGONAL_STORAGE_KEY, raw);
      expect(readStoredDiagonalInches()).toBeCloseTo(expected, 12);
    }
  });

  it('does not propagate a storage that throws on property access', () => {
    // Safari private browsing with a zero quota, and any origin with site data
    // disabled: even `window.localStorage` — the property read itself — throws
    // a SecurityError. Uncaught, that happens during TopBar's first render and
    // the page is blank for the sake of a setting nobody asked for.
    let accesses = 0;
    replaceWindowProperty('localStorage', () => {
      accesses += 1;
      throw new Error('SecurityError: The operation is insecure.');
    });

    expect(() => readStoredDiagonalInches()).not.toThrow();
    expect(readStoredDiagonalInches()).toBeNull();
    expect(() => writeStoredDiagonalInches(27)).not.toThrow();
    expect(() => writeStoredDiagonalInches(null)).not.toThrow();
    expect(() => getDisplayDiagonalInches()).not.toThrow();
    expect(() => setDisplayDiagonalInches(27)).not.toThrow();
    // The stub really was exercised, so the assertions above are not passing
    // because the module happened to skip storage entirely.
    expect(accesses).toBeGreaterThan(0);
  });

  it('keeps the in-memory value when only the WRITE throws', () => {
    // The quota case: reads work, `setItem` throws. Losing persistence across
    // reloads is acceptable; losing the calibration mid-session is not.
    replaceWindowProperty('localStorage', () => ({
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {
        throw new Error('QuotaExceededError');
      },
      clear: () => undefined,
      key: () => null,
      length: 0,
    }));

    resetDisplayCalibrationCache();
    expect(() => setDisplayDiagonalInches(27)).not.toThrow();
    expect(getDisplayDiagonalInches()).toBe(27);
    expect(() => setDisplayDiagonalInches(null)).not.toThrow();
    expect(getDisplayDiagonalInches()).toBeNull();
  });

  it('survives a storage object that is missing altogether', () => {
    replaceWindowProperty('localStorage', () => null);
    expect(readStoredDiagonalInches()).toBeNull();
    expect(() => writeStoredDiagonalInches(27)).not.toThrow();
  });
});

describe('the calibration store', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetDisplayCalibrationCache();
  });
  afterEach(() => {
    window.localStorage.clear();
    resetDisplayCalibrationCache();
  });

  it('starts uncalibrated and persists what it is given', () => {
    expect(getDisplayDiagonalInches()).toBeNull();
    setDisplayDiagonalInches(27);
    expect(getDisplayDiagonalInches()).toBe(27);
    expect(window.localStorage.getItem(DISPLAY_DIAGONAL_STORAGE_KEY)).toBe('27');

    resetDisplayCalibrationCache();
    expect(getDisplayDiagonalInches()).toBe(27);
  });

  it('coerces an out-of-range value to uncalibrated rather than storing it', () => {
    setDisplayDiagonalInches(27);
    setDisplayDiagonalInches(270);
    expect(getDisplayDiagonalInches()).toBeNull();
    expect(window.localStorage.getItem(DISPLAY_DIAGONAL_STORAGE_KEY)).toBeNull();

    setDisplayDiagonalInches(27);
    setDisplayDiagonalInches(NaN);
    expect(getDisplayDiagonalInches()).toBeNull();
  });

  it('reads localStorage once, not once per frame', () => {
    // The viewer asks for this inside its rAF loop. A synchronous
    // localStorage read is a main-thread disk read on a cold cache, and 60 of
    // them a second is a measurable stall.
    window.localStorage.setItem(DISPLAY_DIAGONAL_STORAGE_KEY, '27');
    resetDisplayCalibrationCache();
    const getItem = jest.spyOn(Storage.prototype, 'getItem');
    for (let i = 0; i < 120; i += 1) getDisplayDiagonalInches();
    expect(getItem).toHaveBeenCalledTimes(1);
    getItem.mockRestore();
  });

  it('notifies subscribers on change and only on change', () => {
    const seen: (number | null)[] = [];
    const unsubscribe = subscribeDisplayCalibration(() => seen.push(getDisplayDiagonalInches()));

    setDisplayDiagonalInches(27);
    setDisplayDiagonalInches(27); // no-op: same value
    setDisplayDiagonalInches(24);
    setDisplayDiagonalInches(null);
    setDisplayDiagonalInches(null); // no-op: already uncalibrated
    expect(seen).toEqual([27, 24, null]);

    unsubscribe();
    setDisplayDiagonalInches(13);
    expect(seen).toEqual([27, 24, null]);
  });

  it('lets a subscriber unsubscribe from inside its own callback', () => {
    // TopBar unmounts on route change while a setDisplayDiagonalInches from the
    // same tick is still fanning out; mutating the listener set mid-iteration
    // must not skip the remaining listeners.
    const calls: string[] = [];
    const stopA = subscribeDisplayCalibration(() => {
      calls.push('a');
      stopA();
    });
    const stopB = subscribeDisplayCalibration(() => calls.push('b'));

    setDisplayDiagonalInches(27);
    expect(calls).toEqual(['a', 'b']);

    setDisplayDiagonalInches(24);
    expect(calls).toEqual(['a', 'b', 'b']);
    stopB();
  });
});
