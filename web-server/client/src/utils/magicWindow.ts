import * as THREE from 'three';
import type { HeadPose } from '../hooks/useHeadTracking';

/**
 * Off-axis ("generalized") perspective projection — the maths that makes the
 * monitor behave like a hole in a wall rather than a camera you steer.
 *
 * The version this replaces moved the camera to the tracked head position and
 * called `lookAt(0, 0, 0)`. That is a *camera on a gimbal*, not a window: the
 * frustum stays symmetric, so the scene swings across the screen as you lean
 * and the screen edges are not attached to anything in the world. The tell is
 * easy to state and easy to test — with a real window, the four corners of the
 * glass stay nailed to the four corners of the screen no matter where your eye
 * is. `magicWindow.test.ts` asserts exactly that, and asserts that the old
 * `lookAt` construction fails it.
 *
 * Robert Kooima, "Generalized Perspective Projection" (2008), states the
 * general case: given the screen's three corners `pa` (lower-left), `pb`
 * (lower-right), `pc` (upper-left) and the eye `pe`, build the screen basis
 *
 *     vr = normalize(pb - pa)        vu = normalize(pc - pa)
 *     vn = normalize(cross(vr, vu))            (out of the screen, towards the eye)
 *
 * take the eye-relative corner vectors `va = pa - pe`, `vb = pb - pe`,
 * `vc = pc - pe`, the eye-to-screen distance `d = -dot(vn, va)`, and then
 *
 *     l = dot(vr, va) * n / d        r = dot(vr, vb) * n / d
 *     b = dot(vu, va) * n / d        t = dot(vu, vc) * n / d
 *
 * with the final matrix `frustum(l, r, b, t, n, f)` and the camera oriented by
 * the SCREEN's basis — never aimed at the subject.
 *
 * This module works in *screen space*: origin at the centre of the glass, +x
 * along the screen's right, +y up, +z out of the screen towards the viewer. In
 * that frame Kooima collapses to the four expressions in
 * `computeOffAxisFrustum`, which is the whole reason the caller (SplatViewer)
 * only has to hand over an eye position and a window size. The general form is
 * still available as `computeOffAxisFrustumFromCorners` for a non-rectangular
 * or tilted screen, and the specialization is checked against it in the tests.
 */

export interface ScreenSpaceEye {
  /** Metres/world-units right of the window centre. */
  x: number;
  /** Metres/world-units above the window centre. */
  y: number;
  /** Distance in front of the glass. Strictly positive. */
  z: number;
}

export interface Frustum {
  left: number;
  right: number;
  bottom: number;
  top: number;
  near: number;
  far: number;
}

export interface OffAxisFrustumInput {
  /** Half the window's width, in world units. */
  halfWidth: number;
  /** Half the window's height, in world units. */
  halfHeight: number;
  /** Eye position in screen space. */
  eye: ScreenSpaceEye;
  near: number;
  far: number;
}

/**
 * The eye can legally get arbitrarily close to the glass, but the near plane
 * cannot pass through it: at `near >= eye.z` the frustum inverts and the scene
 * turns inside out. Clamping here rather than at the call site keeps the
 * invariant with the maths that depends on it.
 */
const NEAR_SAFETY = 0.9;

export const computeOffAxisFrustum = ({
  halfWidth,
  halfHeight,
  eye,
  near,
  far,
}: OffAxisFrustumInput): Frustum => {
  const z = Math.max(eye.z, 1e-6);
  const n = Math.max(Math.min(near, z * NEAR_SAFETY), 1e-6);
  const scale = n / z;

  return {
    left: (-halfWidth - eye.x) * scale,
    right: (halfWidth - eye.x) * scale,
    bottom: (-halfHeight - eye.y) * scale,
    top: (halfHeight - eye.y) * scale,
    near: n,
    far: Math.max(far, n * 1.001),
  };
};

/**
 * Kooima's general form, for a screen that is not axis-aligned with the eye
 * frame. Nothing in the app calls this today — SplatViewer builds its window
 * from the camera's own basis, so the specialization above is exact — but the
 * tests use it to prove the specialization is not a different projection with
 * the same name.
 */
export const computeOffAxisFrustumFromCorners = (
  lowerLeft: THREE.Vector3,
  lowerRight: THREE.Vector3,
  upperLeft: THREE.Vector3,
  eye: THREE.Vector3,
  near: number,
  far: number,
): Frustum => {
  const vr = lowerRight.clone().sub(lowerLeft).normalize();
  const vu = upperLeft.clone().sub(lowerLeft).normalize();
  const vn = vr.clone().cross(vu).normalize();

  const va = lowerLeft.clone().sub(eye);
  const vb = lowerRight.clone().sub(eye);
  const vc = upperLeft.clone().sub(eye);

  const d = Math.max(-vn.dot(va), 1e-6);
  const n = Math.max(Math.min(near, d * NEAR_SAFETY), 1e-6);
  const scale = n / d;

  return {
    left: vr.dot(va) * scale,
    right: vr.dot(vb) * scale,
    bottom: vu.dot(va) * scale,
    top: vu.dot(vc) * scale,
    near: n,
    far: Math.max(far, n * 1.001),
  };
};

/**
 * The OpenGL asymmetric frustum matrix. Written out rather than delegating to
 * `Matrix4.makePerspective` because that method's argument order changed in
 * three r160 (left, right, TOP, BOTTOM vs. the older left, right, bottom, top)
 * and it now takes a coordinate-system flag; a silent swap there mirrors the
 * scene vertically only when the frustum is asymmetric, i.e. only once head
 * tracking is on, which is the hardest possible place to notice it. This is the
 * same layout `makeProjectionFromIntrinsics` in cameraUtils.ts already uses.
 *
 * @param target Optional matrix to write into, so the render loop can avoid
 *               allocating a Matrix4 per frame.
 */
export const makeOffAxisProjection = (
  { left, right, bottom, top, near, far }: Frustum,
  target: THREE.Matrix4 = new THREE.Matrix4(),
): THREE.Matrix4 =>
  target.set(
    (2 * near) / (right - left),
    0,
    (right + left) / (right - left),
    0,
    0,
    (2 * near) / (top - bottom),
    (top + bottom) / (top - bottom),
    0,
    0,
    0,
    -(far + near) / (far - near),
    (-2 * far * near) / (far - near),
    0,
    0,
    -1,
    0,
  );

export interface EyeMappingInput {
  /** The live pose from `useHeadTracking`. Units are calibrated-distance-relative. */
  pose: Pick<HeadPose, 'x' | 'y' | 'z'>;
  /** World-space distance from the calibrated eye to the plane of the glass. */
  windowDistance: number;
  /** 1 = physically faithful. >1 exaggerates the parallax. */
  sensitivity: number;
  /** 0 = neutral (dead centre), 1 = fully head-driven. Ramped while tracking fades in/out. */
  blend: number;
}

/**
 * How far off-axis the eye may travel, as a multiple of the window distance.
 * At 0.8 the eye is ~39 degrees off the window normal, which is already past
 * what a laptop webcam can see; the clamp exists so that a single mis-detected
 * frame (a face found in a poster on the wall behind you) cannot fling the
 * frustum somewhere it takes a second of smoothing to come back from.
 */
const MAX_LATERAL_RATIO = 0.8;
/** Leaning in past this would put the eye through the glass. */
const MIN_DEPTH_RATIO = 0.3;
/** Leaning back further than this just shrinks the window to a postage stamp. */
const MAX_DEPTH_RATIO = 2.5;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/**
 * Turn the display-independent head pose into a screen-space eye position.
 *
 * The hook reports lateral offset in units of the calibrated viewing distance
 * (a dimensionless angle-like quantity) and depth as a ratio against the
 * calibrated distance. That is deliberate: the hook has no idea how big the
 * monitor is or how big the scene is, and it must not have to. Multiplying the
 * lateral terms by `windowDistance` converts them into world units under the
 * one assumption that makes everything self-consistent — that at the moment the
 * user pressed recentre, the physical screen subtended exactly the virtual
 * camera's field of view. Under that assumption `sensitivity: 1` is not a
 * tuning value, it is the physically correct answer, and the projection at the
 * calibrated pose is bit-identical to the ordinary orbit view.
 *
 * `blend` exists because tracking drops out — you look away, someone walks
 * between you and the camera, the lighting changes. Snapping the frustum back
 * to centre in one frame is a visible lurch; ramping `blend` to 0 over a few
 * hundred milliseconds reads as the window settling.
 */
export const mapHeadPoseToEye = ({
  pose,
  windowDistance,
  sensitivity,
  blend,
}: EyeMappingInput): ScreenSpaceEye => {
  const d = Math.max(windowDistance, 1e-6);
  const s = Math.max(sensitivity, 0) * clamp(blend, 0, 1);

  const x = clamp(pose.x * d * s, -d * MAX_LATERAL_RATIO, d * MAX_LATERAL_RATIO);
  const y = clamp(pose.y * d * s, -d * MAX_LATERAL_RATIO, d * MAX_LATERAL_RATIO);

  // `pose.z` is a ratio against the calibrated distance, so `pose.z - 1` is the
  // signed excursion and scaling THAT (rather than `pose.z` itself) keeps the
  // neutral pose at exactly the window distance for every sensitivity — which
  // is what makes the slider safe to drag while the viewer is watching.
  const depthRatio = Number.isFinite(pose.z) ? pose.z : 1;
  const z = d * clamp(1 + s * (depthRatio - 1), MIN_DEPTH_RATIO, MAX_DEPTH_RATIO);

  return { x, y, z };
};

/* ────────────────────────────────────────────────────────────────────────────
   Physical screen calibration.

   Everything above is unit-free: the caller hands over a window half-size and
   an eye position in the SAME units, and the projection depends only on their
   ratios (scale halfWidth, halfHeight and eye by any common factor and
   `computeOffAxisFrustum` returns the identical frustum — the tests assert
   this). That invariance is what lets a physically calibrated window drop in
   without a second projection path.

   The uncalibrated construction assumes the physical screen subtends exactly
   the virtual camera's field of view. Write that assumption out: with the glass
   `d` world units in front of the eye and half-height `h = tan(fov/2)*d`, it
   claims

       h / d  =  halfHeight_metres / viewingDistance_metres

   i.e. tan(theta_virtual) = tan(theta_physical). It is false for every display
   that is not exactly the size the assumption implies, and the error is a pure
   gain on the parallax: a 13" laptop at 60 cm subtends about 16 degrees
   vertically while a 60-degree virtual camera claims 60, so the true parallax
   is understated by a factor of ~3.6.

   ── What calibration actually has to change ─────────────────────────────────

   The physically correct requirement is one ratio:

       ndc_x  =  eye_x_metres / halfWidth_metres          (and the same in y)

   Substituting the window construction, `ndc_x = eye_x_world / halfWidth_world`,
   so the fix is to make the world-space ratio equal the metric one. There are
   two knobs — the glass's world size and the eye's world distance from it — and
   only their ratio matters, so exactly one degree of freedom is real.

   Pin it with the property the product cares about: switching XR on must not
   re-frame the memory. Keep the glass rectangle at the size the uncalibrated
   path gives it (`tan(fov/2) * WINDOW_DEPTH_FRACTION * L`, from the orbit
   camera's own framing) and move the EYE instead, from `d = f*L` back to
   `d = f*L*A` where

       A  =  tan(fov/2) * calibrationDistance_metres / halfHeight_metres
          =  tan(theta_virtual) / tan(theta_physical)

   is the ratio the old assumption asserted was 1. Check both consequences:

     • Parallax.  eye_x_world / halfWidth_world
                  = (pose.x * f*L*A) / (tan(fov/2) * aspect * f*L)
                  = pose.x * calDist / (halfHeight_m * aspect)
                  = (dx_metres / calDist) * calDist / halfWidth_m
                  = dx_metres / halfWidth_m.                      1:1, exactly.

     • Framing.   At the neutral pose the camera sits `d = f*L*A` behind a glass
                  of half-height `tan(fov/2)*f*L`, i.e. `L*A` from the orbit
                  target. Visible half-height at the target plane is
                  `tan(fov/2)*f*L * (L*A)/(f*L*A) = tan(fov/2)*L` — precisely
                  what the orbit camera framed. Unchanged, to the last digit.

   So calibration is a DOLLY, not a zoom: the camera pulls back to `L*A` and the
   projection narrows to the true angle the screen subtends, and the two cancel
   at the neutral pose. The perspective flattens (a longer lens on the same
   subject) — that is not a bug, it is what looking at a small window from a
   normal viewing distance actually looks like, and it is the visible signature
   of the calibration being real.

   `A` is typically 1.5-4 for a desk display, so the calibrated camera is
   genuinely much further from the subject; the caller has to widen `far` to
   match or the subject clips out of the back of the frustum.
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * Fallback eye-to-screen distance when the tracker has not yet produced a
 * metric reading. 0.6 m is the middle of the range people actually sit at from
 * a desk display; it is only ever used for the frames before the first
 * detection and while tracking is lost, and it exists so the calibrated dolly
 * does not lurch between two camera distances every time a face is dropped.
 */
export const DEFAULT_VIEWING_DISTANCE_M = 0.6;

/**
 * Angular scale `A` above: how much narrower the real screen is than the
 * virtual camera claims.
 *
 * Clamped, because it multiplies the camera's distance from the subject and the
 * inputs are user-supplied. A mistyped 2.7" diagonal would put `A` near 40 and
 * park the camera forty subject-distances away, where the near/far planes and
 * float depth precision both give up; a 270" one would push it under 0.1 and
 * bury the camera inside the subject. Neither is recoverable by the user
 * without understanding what went wrong, so they are bounded to a range that
 * stays renderable and merely looks wrong.
 */
export const MIN_ANGULAR_SCALE = 0.2;
export const MAX_ANGULAR_SCALE = 12;

export interface AngularScaleInput {
  /** Virtual camera's VERTICAL field of view, in degrees. */
  fovDeg: number;
  /** True half-height of the canvas rectangle, in metres. */
  halfHeightM: number;
  /** Metric eye-to-screen distance at the calibration (Recentre) pose. */
  calibrationDistanceM: number;
}

/**
 * @returns the dolly factor, or exactly 1 when any input is unusable — which
 *          reproduces the uncalibrated projection bit for bit, so a bad
 *          calibration degrades to the old behaviour rather than to a broken
 *          one.
 */
export const computeAngularScale = ({
  fovDeg,
  halfHeightM,
  calibrationDistanceM,
}: AngularScaleInput): number => {
  if (!(fovDeg > 0) || !(fovDeg < 180)) return 1;
  if (!(halfHeightM > 0) || !Number.isFinite(halfHeightM)) return 1;
  if (!(calibrationDistanceM > 0) || !Number.isFinite(calibrationDistanceM)) return 1;

  const scale = (Math.tan((fovDeg * Math.PI) / 360) * calibrationDistanceM) / halfHeightM;
  if (!Number.isFinite(scale)) return 1;
  return clamp(scale, MIN_ANGULAR_SCALE, MAX_ANGULAR_SCALE);
};

/**
 * Recover the metric distance the tracker was calibrated at.
 *
 * The hook publishes `z = d / cal.distance` and `distanceMeters = d` from the
 * same filtered sample, so their quotient is `cal.distance` exactly — no drift,
 * no extra state, and nothing new to keep in sync in `useHeadTracking`. It is
 * recovered rather than exposed because `cal.distance` is private to the
 * controller and only becomes meaningful once a face has been seen.
 *
 * @param fallback used whenever no face has been seen yet (the neutral pose has
 *        `distanceMeters === 0`) or the quotient lands outside the range a
 *        seated human can occupy. Passing the LAST GOOD value here — not a
 *        constant — is what stops the calibrated camera dollying every time
 *        tracking drops for a frame.
 */
export const calibrationDistanceMeters = (
  pose: Pick<HeadPose, 'z' | 'distanceMeters'>,
  fallback: number = DEFAULT_VIEWING_DISTANCE_M,
): number => {
  const { z, distanceMeters } = pose;
  if (!Number.isFinite(z) || !Number.isFinite(distanceMeters)) return fallback;
  if (!(z > 0) || !(distanceMeters > 0)) return fallback;
  const distance = distanceMeters / z;
  // Same bounds `headPose.ts` clamps its raw estimate to. Outside them the
  // reading is not a viewing distance, it is a mis-detection.
  if (!(distance >= 0.15) || !(distance <= 4)) return fallback;
  return distance;
};

/** Which regime the window is currently in. Surfaced verbatim in the XR panel. */
export type WindowCalibrationMode = 'calibrated' | 'relative';

export interface WindowGeometryInput {
  /** Distance from the orbit camera to its target, world units. */
  subjectDistance: number;
  /** Fraction of `subjectDistance` at which the glass sits. */
  depthFraction: number;
  /** The live camera's vertical FOV in degrees and viewport aspect. */
  fovDeg: number;
  aspect: number;
  /**
   * The canvas's true rectangle in metres, or null when uncalibrated. Only the
   * half-height is used: the half-width is pinned to the viewport aspect, which
   * the canvas rect already matches (both are the same rectangle) and which
   * stays right if the two ever disagree because the projection has to fill the
   * viewport, not the monitor.
   */
  screenRect: { halfHeightM: number } | null;
  /** Metric eye-to-screen distance at the calibration pose. */
  calibrationDistanceM: number;
}

export interface WindowGeometry {
  /** Half-extents of the glass in WORLD units. Identical in both modes. */
  halfWidth: number;
  halfHeight: number;
  /** Eye-to-glass distance at the neutral pose, world units. */
  windowDistance: number;
  /** Camera-to-target distance at the neutral pose, world units. `L * A`. */
  cameraDistance: number;
  /** Glass-centre-to-target distance, world units. */
  glassToTarget: number;
  angularScale: number;
  mode: WindowCalibrationMode;
}

/**
 * `clamp` above is not NaN-safe and cannot be made so without changing what it
 * means everywhere else: `Math.max(NaN, lo)` is NaN, so a non-finite value walks
 * through every bound untouched. That only matters here, because
 * `computeWindowGeometry` is the one function in this module whose numeric
 * inputs come straight off a live `THREE.PerspectiveCamera` and a DOM
 * measurement, and every one of its outputs lands in `computeOffAxisFrustum`
 * and then in `camera.projectionMatrix`.
 *
 * The reachable case is mundane, not exotic. `SplatViewer`'s `handleResize` runs
 * once unconditionally on mount, before layout is guaranteed to have given the
 * container a height, and does `camera.aspect = clientWidth / clientHeight` —
 * `0 / 0`, i.e. NaN — while on the intrinsics path it also sets
 * `camera.fov = 2 * atan(clientHeight / …)`, i.e. exactly 0. A NaN in the
 * projection matrix throws nothing and warns nothing, it just blanks the canvas;
 * a zero FOV collapses `right - left` to 0 and puts an Infinity there instead.
 * That is the same silent failure `mapHeadPoseToEye` already guards `pose.z`
 * against, and the same one the `[data-splat-status="ready"]` capture would
 * report as a healthy black frame.
 */
const clampFinite = (value: number, lo: number, hi: number, fallback: number): number =>
  Number.isFinite(value) ? clamp(value, lo, hi) : fallback;

/**
 * The one place that decides where the glass is and how far behind it the eye
 * sits. Derived per frame rather than cached on the anchor so that a viewport
 * resize (which changes `aspect`, and `fov` too on the intrinsics path) and a
 * Recentre (which changes `calibrationDistanceM`) are both picked up without
 * re-anchoring — re-anchoring would re-measure from the already-dollied camera
 * and compound the dolly on every resize.
 */
export const computeWindowGeometry = ({
  subjectDistance,
  depthFraction,
  fovDeg,
  aspect,
  screenRect,
  calibrationDistanceM,
}: WindowGeometryInput): WindowGeometry => {
  // Upper bounds as well as lower ones: `Math.max(Infinity, 0.05)` is Infinity,
  // and an infinite half-height produces `Infinity - Infinity` = NaN one step
  // later in the frustum. The fallbacks are only ever reached by a genuinely
  // unusable input, and 0.55 / 50 deg / 1:1 are chosen to be the least
  // surprising thing to render for the frame or two before the next resize.
  const L = clampFinite(subjectDistance, 0.05, 1e6, 0.05);
  const f = clampFinite(depthFraction, 0.05, 0.95, 0.55);
  const fov = clampFinite(fovDeg, 1, 179, 50);
  const viewAspect = clampFinite(aspect, 1e-6, 1e6, 1);

  const angularScale = screenRect
    ? computeAngularScale({
        // The SANITIZED fov, not the raw one. `computeAngularScale` returns 1
        // for a non-finite or zero fov while the glass below would still be
        // built from the 50-degree fallback, and the two disagreeing is exactly
        // what breaks the framing invariant this whole construction is pinned
        // on — the dolly `A` and the glass half-height must come from one fov.
        fovDeg: fov,
        halfHeightM: screenRect.halfHeightM,
        calibrationDistanceM,
      })
    : 1;

  // The glass keeps the size the orbit framing gives it — see the block comment
  // above. This is the term that makes the calibrated and uncalibrated views
  // frame identically at the neutral pose.
  const halfHeight = Math.tan(THREE.MathUtils.degToRad(fov) / 2) * f * L;
  const halfWidth = halfHeight * viewAspect;

  const cameraDistance = L * angularScale;
  const windowDistance = f * cameraDistance;

  return {
    halfWidth,
    halfHeight,
    windowDistance,
    cameraDistance,
    glassToTarget: cameraDistance - windowDistance,
    angularScale,
    // `angularScale === 1` with a screen rect present is not a failure, it just
    // means the display happens to subtend the virtual FOV; the mode still
    // reports calibrated because the parallax IS being computed from a measured
    // screen. Only the absence of a usable rect is "relative".
    mode: screenRect ? 'calibrated' : 'relative',
  };
};
