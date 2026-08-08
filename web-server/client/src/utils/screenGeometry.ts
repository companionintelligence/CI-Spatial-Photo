/**
 * Physical display calibration: from "it's a 27-inch monitor" to "the canvas is
 * 0.412 m wide", which is the only thing the magic window actually needs.
 *
 * Why this file exists at all: `mapHeadPoseToEye` converts the head pose into
 * world units by ASSUMING that at the moment the user pressed Recentre the
 * physical screen subtended exactly the virtual camera's field of view. That is
 * self-consistent and it is honestly documented, but it is not calibrated to any
 * real display — a 27" monitor and a 13" laptop produce identical parallax for
 * the same head movement, which is physically wrong by a factor of two. The
 * correct parallax ratio is
 *
 *     ndc_shift  =  (head displacement in metres) / (screen half-width in metres)
 *
 * and there is no way to evaluate the denominator without being told how big the
 * screen is. The browser will not tell us: there is no API for physical display
 * size, `devicePixelRatio` is a rendering ratio and not a physical one, and the
 * CSS `mm` unit is defined as exactly 96/25.4 px, i.e. a fiction. So we ask.
 *
 * ── The unit chain, stated once and completely ──────────────────────────────
 *
 * The user supplies the DIAGONAL in inches, because that is the number printed
 * on the box and the only display dimension anyone knows off the top of their
 * head. Getting from there to the canvas rectangle takes four steps, and each
 * one has an assumption attached:
 *
 *   1.  diagonal_mm = diagonal_in x 25.4                       (exact)
 *
 *   2.  diagonal -> width/height needs the panel's ASPECT. With w/h = a,
 *
 *           w^2 + h^2 = D^2   and   w = a*h
 *       =>  h = D / sqrt(a^2 + 1),   w = D*a / sqrt(a^2 + 1)
 *
 *       The aspect is taken from `screen.width / screen.height` rather than
 *       assumed to be 16:9, because 16:10 laptops, 3:2 Surfaces and 21:9
 *       ultrawides are all common and a wrong aspect biases the width directly.
 *       This assumes square pixels, which is true of every display this app
 *       will meet, and that the OS is not reporting a rotated resolution for a
 *       physically unrotated panel.
 *
 *   3.  mm per CSS pixel = monitor_w_mm / screen.width
 *
 *       `screen.width` is in CSS pixels, NOT device pixels. This is the step
 *       where `devicePixelRatio` wants to be introduced and must not be: on a
 *       2x Retina panel `screen.width` already reports the CSS-pixel width
 *       (1512, not 3024), so multiplying by dpr would halve the answer.
 *
 *   4.  canvas_w_mm = canvas.clientWidth x mm-per-CSS-pixel
 *
 *       `clientWidth` is also in CSS pixels, which is what makes the whole
 *       chain collapse to something robust:
 *
 *           canvas_w_mm = monitor_w_mm * (canvas.clientWidth / screen.width)
 *
 *       — the monitor's physical width times the FRACTION of the screen the
 *       canvas covers. Both operands of that fraction are in the same unit, so
 *       BROWSER ZOOM CANCELS: at 200% zoom Chrome reports half as many CSS
 *       pixels for both `screen.width` and `clientWidth`, and the ratio is
 *       unchanged. That is the reason this module never reads
 *       `devicePixelRatio` and never tries to detect the zoom level.
 *
 *       The cancellation is only exact for browsers that report `screen.width`
 *       in the same zoomed CSS pixels they report element sizes in. Chromium
 *       does. Firefox reports `screen.width` in unzoomed pixels, so a Firefox
 *       user at a non-100% zoom gets a calibration off by exactly the zoom
 *       factor. That is a known, bounded error, it is documented in the panel,
 *       and Recentre plus the parallax slider absorb it — it is the same class
 *       of error as the assumed webcam field of view in `headPose.ts`.
 *
 * The other assumption worth naming: the window is on the display the user
 * measured. `window.screen` reports the screen the window is currently on in
 * every modern browser, so dragging between a laptop panel and an external
 * monitor changes `screen.width`/`height` and therefore silently re-derives the
 * mm-per-pixel from the WRONG diagonal. There is no fix short of the
 * Window Management API and per-display settings; the failure is graceful (the
 * parallax gain is off, nothing breaks) and it is called out in the UI copy.
 */

/** Exact, by definition of the international inch. */
export const MM_PER_INCH = 25.4;

/**
 * Bounds on the diagonal the user may enter. Not taste — a mistyped "270" would
 * make the calibrated parallax gain ten times too small and read as the feature
 * being broken, and a "0" would divide by zero two steps later.
 */
export const MIN_DIAGONAL_INCHES = 4;
export const MAX_DIAGONAL_INCHES = 150;

export interface DisplayAspect {
  /** Any two numbers in the panel's width:height ratio. Only the ratio is used. */
  width: number;
  height: number;
}

/** What the browser can tell us about the screen. Injected so this is testable. */
export interface ScreenSize {
  /** `window.screen.width`, in CSS pixels. */
  cssWidth: number;
  /** `window.screen.height`, in CSS pixels. */
  cssHeight: number;
}

export interface ScreenMetricsInput {
  diagonalInches: number;
  screen: ScreenSize;
  /**
   * Override the panel aspect. Defaults to `screen.cssWidth / screen.cssHeight`,
   * which is right whenever pixels are square.
   */
  aspect?: DisplayAspect | null;
}

export interface ScreenMetrics {
  /** Physical width of the whole panel. */
  monitorWidthMm: number;
  monitorHeightMm: number;
  /** The conversion the rest of the app wants. Separate axes so a supplied
   *  aspect that disagrees with the reported resolution stays honest instead of
   *  being silently averaged away. */
  mmPerCssPxX: number;
  mmPerCssPxY: number;
  /** Echoed back so a caller can show its working. */
  screenCssWidth: number;
  screenCssHeight: number;
  diagonalInches: number;
}

export interface MetricRect {
  widthM: number;
  heightM: number;
  halfWidthM: number;
  halfHeightM: number;
}

const isPositiveFinite = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0;

export const isValidDiagonalInches = (v: unknown): v is number =>
  isPositiveFinite(v) && v >= MIN_DIAGONAL_INCHES && v <= MAX_DIAGONAL_INCHES;

/**
 * Step 1 + 2 of the chain: diagonal and aspect to physical width/height.
 *
 * Derivation, because "diagonal times 16/18.36" appears in a lot of code with no
 * explanation: for a rectangle of aspect a = w/h, w^2 + h^2 = D^2 gives
 * h = D / sqrt(a^2 + 1) and w = a*h. For 16:9 that is D * 0.8716 by D * 0.4903.
 */
export const monitorSizeMm = (
  diagonalInches: number,
  aspect: DisplayAspect,
): { widthMm: number; heightMm: number } | null => {
  if (!isValidDiagonalInches(diagonalInches)) return null;
  if (!isPositiveFinite(aspect.width) || !isPositiveFinite(aspect.height)) return null;

  const a = aspect.width / aspect.height;
  const diagonalMm = diagonalInches * MM_PER_INCH;
  const heightMm = diagonalMm / Math.sqrt(a * a + 1);
  return { widthMm: a * heightMm, heightMm };
};

/**
 * Steps 1-3: everything that depends on the display but not on the canvas.
 *
 * @returns null when the inputs cannot support a physical answer — a diagonal
 *          outside the sane range, or a screen the browser reports as 0 wide
 *          (which jsdom does, and which a headless capture can too). Returning
 *          null rather than a plausible-looking number is what lets the caller
 *          fall back to the uncalibrated projection instead of rendering a
 *          confidently wrong one.
 */
export const computeScreenMetrics = ({
  diagonalInches,
  screen,
  aspect,
}: ScreenMetricsInput): ScreenMetrics | null => {
  if (!isPositiveFinite(screen.cssWidth) || !isPositiveFinite(screen.cssHeight)) return null;

  const panelAspect: DisplayAspect =
    aspect && isPositiveFinite(aspect.width) && isPositiveFinite(aspect.height)
      ? aspect
      : { width: screen.cssWidth, height: screen.cssHeight };

  const size = monitorSizeMm(diagonalInches, panelAspect);
  if (!size) return null;

  return {
    monitorWidthMm: size.widthMm,
    monitorHeightMm: size.heightMm,
    mmPerCssPxX: size.widthMm / screen.cssWidth,
    mmPerCssPxY: size.heightMm / screen.cssHeight,
    screenCssWidth: screen.cssWidth,
    screenCssHeight: screen.cssHeight,
    diagonalInches,
  };
};

/**
 * Step 4: the canvas's own rectangle, in metres.
 *
 * `cssWidth`/`cssHeight` are the canvas element's CSS-pixel size —
 * `clientWidth`/`clientHeight`, or the container's, NOT `canvas.width` (which is
 * the backing store and is `clientWidth * devicePixelRatio` here; see
 * `SplatViewer`'s `handleResize`). Passing the backing store size would inflate
 * the physical rect by the pixel ratio, which on a Retina laptop makes the
 * calibrated parallax exactly half as strong as it should be — a plausible
 * enough error to survive review, which is why it is spelled out.
 */
export const canvasRectMetres = (
  metrics: ScreenMetrics,
  cssWidth: number,
  cssHeight: number,
): MetricRect | null => {
  if (!isPositiveFinite(cssWidth) || !isPositiveFinite(cssHeight)) return null;

  const widthM = (cssWidth * metrics.mmPerCssPxX) / 1000;
  const heightM = (cssHeight * metrics.mmPerCssPxY) / 1000;
  if (!isPositiveFinite(widthM) || !isPositiveFinite(heightM)) return null;

  return { widthM, heightM, halfWidthM: widthM / 2, halfHeightM: heightM / 2 };
};

/** The whole chain in one call, for callers that have a live DOM. */
export const measureCanvasRectMetres = ({
  diagonalInches,
  cssWidth,
  cssHeight,
  screen,
  aspect,
}: {
  diagonalInches: number;
  cssWidth: number;
  cssHeight: number;
  screen: ScreenSize;
  aspect?: DisplayAspect | null;
}): MetricRect | null => {
  const metrics = computeScreenMetrics({ diagonalInches, screen, aspect });
  return metrics ? canvasRectMetres(metrics, cssWidth, cssHeight) : null;
};

/** `window.screen` as a plain value, or null off-DOM (SSR, jest node env). */
export const readScreenSize = (): ScreenSize | null => {
  if (typeof window === 'undefined' || !window.screen) return null;
  const { width, height } = window.screen;
  if (!isPositiveFinite(width) || !isPositiveFinite(height)) return null;
  return { cssWidth: width, cssHeight: height };
};

/* ────────────────────────────────────────────────────────────────────────────
   Persistence and the tiny store around it.

   This is a store rather than a prop because of a constraint in the app's
   shape: the control that sets the value lives in `TopBar`, the code that
   consumes it lives in `SplatViewer`, and their only common ancestor is
   `App.tsx` — which this change is not allowed to touch, and which should not
   have to grow a piece of viewer state anyway. A module-level store keyed to
   localStorage is the smaller thing: two subscribers, one value, no plumbing.

   It is deliberately NOT a React context: `SplatViewer` reads the value inside
   its rAF loop, not during render, and a context would drag the viewer into the
   render path for a setting that changes once a year.
   ──────────────────────────────────────────────────────────────────────────── */

export const DISPLAY_DIAGONAL_STORAGE_KEY = 'ptm:display-diagonal-inches';

/**
 * localStorage is not a safe global.
 *
 * Reading or writing it THROWS — it does not return null — in Safari private
 * browsing when the quota is zero, in Chrome when third-party storage is
 * blocked and the app is framed, and in any browser with site data disabled.
 * Even the property access `window.localStorage` can throw a SecurityError. An
 * uncaught throw here happens during TopBar's first render, which means a blank
 * page for a setting nobody asked for, so every access is wrapped and every
 * failure degrades to "uncalibrated".
 */
const safeStorage = (): Storage | null => {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage ?? null;
  } catch {
    return null;
  }
};

export const readStoredDiagonalInches = (): number | null => {
  const store = safeStorage();
  if (!store) return null;
  try {
    const raw = store.getItem(DISPLAY_DIAGONAL_STORAGE_KEY);
    if (raw === null) return null;
    const parsed = Number.parseFloat(raw);
    return isValidDiagonalInches(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

export const writeStoredDiagonalInches = (value: number | null): void => {
  const store = safeStorage();
  if (!store) return;
  try {
    if (value === null) store.removeItem(DISPLAY_DIAGONAL_STORAGE_KEY);
    else store.setItem(DISPLAY_DIAGONAL_STORAGE_KEY, String(value));
  } catch {
    /* Quota, privacy mode, or a disabled origin. The in-memory value below still
       applies for this session; only persistence across reloads is lost. */
  }
};

let current: number | null | undefined;
const listeners = new Set<() => void>();

/**
 * The calibrated diagonal, or null for "uncalibrated".
 *
 * Cached after the first read so that the viewer's frame loop — which asks for
 * this on every frame — does not hit localStorage 60 times a second. A
 * synchronous localStorage read is a main-thread disk read on a cold cache.
 */
export const getDisplayDiagonalInches = (): number | null => {
  if (current === undefined) current = readStoredDiagonalInches();
  return current;
};

export const setDisplayDiagonalInches = (value: number | null): void => {
  const next = value !== null && isValidDiagonalInches(value) ? value : null;
  if (getDisplayDiagonalInches() === next) return;
  current = next;
  writeStoredDiagonalInches(next);
  listeners.forEach((l) => l());
};

export const subscribeDisplayCalibration = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Test seam. Drops the memo so a suite can re-read a mutated localStorage. */
export const resetDisplayCalibrationCache = (): void => {
  current = undefined;
};
