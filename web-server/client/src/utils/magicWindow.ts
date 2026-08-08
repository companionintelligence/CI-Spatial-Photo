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
