import * as THREE from 'three';

/**
 * AR placement: where a reconstructed memory stands in the room, and how a
 * finger on the glass moves it.
 *
 * This module is the arithmetic half of immersive-ar. It owns four questions
 * and deliberately nothing else — no session management, no `navigator.xr`, no
 * React, no Object3D graph. Every function here is a value in, value out, which
 * is the only reason any of it can be tested: there is no device in CI, and the
 * numbers below are exactly the ones that are wrong when a memory lands on its
 * back, a hundred metres wide, behind the user's head.
 *
 *   1. A hit test gives a POSE on a surface. Turn it into a placement.
 *   2. The asset arrives in arbitrary units. Turn it into a believable size.
 *   3. Compose placement + asset into a transform the viewer can apply.
 *   4. Turn pointer events into new placements.
 *
 * ── Frames and conventions, stated once ─────────────────────────────────────
 *
 * WORLD is the WebXR reference space three renders in: +Y up, metres, right
 * handed. Everything called `...M` or "metres" is in that space.
 *
 * ASSET space is whatever the reconstruction emitted. `server/app/plywriter.py`
 * puts the Preview postcard in the z = 0 plane spanning [-aspect, aspect] x
 * [-1, 1] with +Y up and the image facing +Z, and `depth_to_gaussian_cloud`
 * deliberately normalises the depth engines onto the same framing. So the
 * asset's FRONT is its local +Z, and that is the axis this module turns to face
 * the viewer. Its units, however, are arbitrary and engine-dependent — that is
 * the whole reason `computeArrivalScale` exists.
 *
 * SCREEN space is CSS pixels from the top-left of the canvas, y growing
 * DOWNWARD, which is what `PointerEvent.clientX/clientY` minus the canvas rect
 * gives you. Every screen-to-world conversion in here flips y exactly once; the
 * sign is the single most likely thing to be wrong, so it is derived in the
 * comment above each place it happens rather than asserted.
 *
 * ── A note on where this file may be imported from ──────────────────────────
 *
 * It imports three, so it must stay reachable ONLY from the lazily-loaded
 * viewer chunk. Importing it from `App.tsx` (or from anything App imports
 * eagerly) drags three.js back into `main.js` and silently undoes the code
 * split documented at the top of that file. No test can catch that; the only
 * defence is this paragraph.
 */

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** CSS pixels from the top-left of the CANVAS — not the page, not the window. */
export interface PointerSample {
  x: number;
  y: number;
}

/** The canvas's CSS-pixel size. `clientWidth`/`clientHeight`, not `canvas.width`. */
export interface ViewportSize {
  width: number;
  height: number;
}

export interface PointerView {
  /**
   * The camera whose projection is actually on screen.
   *
   * In a WebXR session that is `renderer.xr.getCamera().cameras[0]`, not the
   * app's own PerspectiveCamera and not the ArrayCamera itself: three builds
   * the ArrayCamera's projection as the UNION of its sub-frusta, so unprojecting
   * through it is only correct by accident when there is exactly one view.
   * immersive-ar is monoscopic today, so the accident holds — but it stops
   * holding the moment this runs on a headset, and a placement that is right on
   * a phone and half a metre off on a Quest is a miserable thing to debug.
   *
   * Whatever is passed must have current `matrixWorld` and
   * `projectionMatrixInverse`. `Vector3.unproject` reads both and returns
   * plausible garbage from stale ones rather than failing.
   */
  camera: THREE.Camera;
  viewport: ViewportSize;
}

/**
 * Where a memory stands. Three numbers, because a memory sitting on the floor
 * has exactly three degrees of freedom the user cares about.
 *
 * There is no tilt and no roll on purpose — see `placementFromHitPose`. There
 * is no per-axis scale because a non-uniform scale on a Gaussian splat does not
 * mean what it looks like it means: Spark transforms the splat centres by the
 * object matrix but the per-splat covariances do not survive a non-uniform
 * scale as an ellipsoid you would have chosen, so squashing an asset makes it
 * bloom rather than squash.
 *
 * Instances are treated as immutable. Every function here returns a NEW
 * placement with a NEW Vector3 and never writes to its input, so a caller can
 * park one in React state, keep the pre-gesture value for undo, or compare two
 * by identity.
 */
export interface ArPlacement {
  /** World point the asset's anchor sits on, in metres. */
  position: THREE.Vector3;
  /** Rotation about world +Y, radians, wrapped to (-PI, PI]. */
  yaw: number;
  /** Uniform multiplier from ASSET units to metres. */
  scale: number;
}

/** Absolute bounds on `ArPlacement.scale`. Derive with `scaleLimitsFromWorldSize`. */
export interface ScaleLimits {
  min: number;
  max: number;
}

/**
 * The asset-local point that should land on the surface the user tapped.
 *
 * A splat's origin is wherever the reconstruction happened to put it, which for
 * a depth cloud is the median-depth plane of the original photo and for an
 * imported PLY is anyone's guess. Placing the ORIGIN on the hit point therefore
 * puts a perfectly good memory half a metre underground, or floating, or a
 * couple of metres to the left of the spot the user aimed at — and because the
 * error is a property of the asset it looks like the hit test is broken.
 * Anchoring the bounding box's bottom centre instead makes "tap here" mean
 * "stand it here" for every asset.
 */
export interface AssetFrame {
  anchor: THREE.Vector3;
}

/** A placement resolved against an asset: drop straight onto an Object3D. */
export interface PlacementTransform {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scale: number;
}

/** Never mutate. Shared by every yaw and every default surface normal here. */
export const WORLD_UP = new THREE.Vector3(0, 1, 0);

const TWO_PI = Math.PI * 2;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Fold an angle into (-PI, PI].
 *
 * The fast path is not an optimisation, it is an exactness guarantee: an angle
 * already in range comes back bit-identical, so a placement that is never
 * twisted keeps precisely the yaw the hit test implied. The general path costs
 * an ulp or two to the modulo, which is invisible in a rotation but would show
 * up as a failing `toBe` in any test that round-trips a yaw.
 */
export const wrapAngle = (radians: number): number => {
  if (!isFiniteNumber(radians)) return 0;
  if (radians > -Math.PI && radians <= Math.PI) return radians;
  const folded = (((radians + Math.PI) % TWO_PI) + TWO_PI) % TWO_PI - Math.PI;
  // The modulo produces [-PI, PI); the convention here is (-PI, PI], and a
  // half turn is the one value that lands on the wrong end of it.
  return folded === -Math.PI ? Math.PI : folded;
};

/* ────────────────────────────────────────────────────────────────────────────
   1. Hit pose to placement.
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * Below this horizontal separation the direction from the anchor to the viewer
 * is not a direction, it is pose noise. Every ARCore/ARKit session jitters the
 * camera by the better part of a centimetre even when the phone is on a table,
 * so a memory placed directly beneath the phone would pick a yaw from a random
 * walk — and, worse, would pick a DIFFERENT one on each of the several hit
 * tests a tap usually produces.
 */
const MIN_YAW_SEPARATION_M = 0.05;

/**
 * Read a WebXR pose matrix.
 *
 * `XRRigidTransform.matrix` is a 16-element column-major Float32Array, which is
 * the same layout `Matrix4.elements` uses, so this is `fromArray` and NOT
 * `set` — `set` takes arguments in ROW-major order and would transpose the
 * pose, turning a translation into a shear that mostly looks like the asset
 * being in the wrong place.
 *
 * @returns null for anything that is not 16 finite numbers. A hit test can
 *          hand back NaNs when tracking drops in the same frame the results are
 *          read, and a NaN that reaches an object's matrix does not throw: the
 *          object simply stops being drawn, with no error anywhere, exactly
 *          like the NaN projection matrix `magicWindow` guards against.
 */
export const matrixFromHitPose = (
  matrix: THREE.Matrix4 | ArrayLike<number>,
  target: THREE.Matrix4 = new THREE.Matrix4(),
): THREE.Matrix4 | null => {
  if (matrix instanceof THREE.Matrix4) {
    for (let i = 0; i < 16; i += 1) {
      if (!isFiniteNumber(matrix.elements[i])) return null;
    }
    return target.copy(matrix);
  }
  if (!matrix || matrix.length !== 16) return null;
  for (let i = 0; i < 16; i += 1) {
    if (!isFiniteNumber(matrix[i])) return null;
  }
  return target.fromArray(matrix as ArrayLike<number>);
};

/**
 * The plane the hit test found, for dragging along a surface that is not the
 * floor.
 *
 * WebXR guarantees only one thing about a hit result's orientation: its local
 * +Y is the estimated surface normal. Everything else about the rotation is
 * unspecified and, in ARCore, effectively arbitrary — which is why the yaw is
 * recomputed from the viewer rather than taken from the pose.
 */
export const planeFromHitPose = (
  matrix: THREE.Matrix4 | ArrayLike<number>,
  target: THREE.Plane = new THREE.Plane(),
): THREE.Plane | null => {
  const m = matrixFromHitPose(matrix, new THREE.Matrix4());
  if (!m) return null;
  const e = m.elements;
  const normal = new THREE.Vector3(e[4], e[5], e[6]);
  if (normal.lengthSq() < 1e-12) return null;
  normal.normalize();
  const point = new THREE.Vector3(e[12], e[13], e[14]);
  return target.setFromNormalAndCoplanarPoint(normal, point);
};

/**
 * Yaw that turns the asset's local +Z toward the viewer, about world +Y only.
 *
 * `R_y(a)` carries +Z to `(sin a, 0, cos a)`, so aiming +Z along the horizontal
 * component of `viewer - from` is `atan2(dx, dz)` — note the argument order,
 * which is the transpose of the usual `atan2(y, x)` and is the other classic
 * way to get this ninety degrees wrong.
 *
 * The vertical component is dropped rather than included: a phone is held
 * above a floor anchor, so a full look-at would tip the memory backwards to
 * stare up at the lens, and it would keep tipping as the user stood up.
 */
export const yawTowardViewer = (from: Vec3Like, viewer: Vec3Like, fallbackYaw = 0): number => {
  const dx = viewer.x - from.x;
  const dz = viewer.z - from.z;
  if (!isFiniteNumber(dx) || !isFiniteNumber(dz)) return wrapAngle(fallbackYaw);
  if (Math.sqrt(dx * dx + dz * dz) < MIN_YAW_SEPARATION_M) return wrapAngle(fallbackYaw);
  return wrapAngle(Math.atan2(dx, dz));
};

export interface HitPlacementInput {
  /** `XRPose.transform.matrix`, or a Matrix4 already built from it. */
  hit: THREE.Matrix4 | ArrayLike<number>;
  /** World position of the XR camera at the moment of the tap. */
  viewer: Vec3Like;
  /** From `computeArrivalScale`. */
  scale: number;
  /** Kept when the viewer is directly over the hit point; also the value used
   *  when re-placing an asset that already has a yaw the user chose. */
  fallbackYaw?: number;
}

/**
 * A hit pose becomes: stand it exactly where the ray met the surface, turn it
 * to face the viewer, and keep it upright.
 *
 * The hit pose's own rotation is thrown away apart from its position, and that
 * is the substantive decision in this function. Using it would mean:
 *
 *   • on a floor, inheriting an arbitrary yaw — ARCore's hit poses are not
 *     oriented toward anything a user can perceive, so the memory would land
 *     facing a random direction and the user would have to twist it every time;
 *
 *   • on a wall or a ceiling, inheriting the TILT, because the pose's +Y is the
 *     surface normal. A memory placed on a wall would lie flat against it like
 *     wallpaper seen edge-on, and one placed on a ceiling would be upside down.
 *
 * "Upright and facing me" is what every AR placement UI does and what people
 * expect from putting a framed photo down on a table. If a wall-mounted mode is
 * ever wanted it is a different function, not a flag here.
 *
 * @returns null when the pose is unusable, so the caller can skip the frame
 *          rather than commit a NaN.
 */
export const placementFromHitPose = ({
  hit,
  viewer,
  scale,
  fallbackYaw = 0,
}: HitPlacementInput): ArPlacement | null => {
  const m = matrixFromHitPose(hit, new THREE.Matrix4());
  if (!m) return null;
  if (!isFiniteNumber(scale) || scale <= 0) return null;
  if (!isFiniteNumber(viewer.x) || !isFiniteNumber(viewer.y) || !isFiniteNumber(viewer.z)) {
    return null;
  }

  const e = m.elements;
  const position = new THREE.Vector3(e[12], e[13], e[14]);
  return {
    position,
    yaw: yawTowardViewer(position, viewer, fallbackYaw),
    scale,
  };
};

/* ────────────────────────────────────────────────────────────────────────────
   2. Arrival scale.

   A reconstruction has no idea how big the thing in the photo was. The Preview
   postcard is ~3.6 units across for a 16:9 image because that is what
   [-aspect, aspect] works out to; a depth cloud is normalised to match it; an
   imported PLY from some other tool might be in millimetres, or in the
   arbitrary units of whatever SfM run produced it. Dropping any of them into a
   metre-based reference space at scale 1 puts a photograph in the room at
   between one and several hundred metres wide. At 3.6 m the user is standing
   inside it and sees one enormous Gaussian; there is no zoom-to-fit in AR and
   no obvious way back, because the pinch gesture starts from wherever the asset
   already is.

   So the asset's own units are cancelled out entirely: measure the bounding
   box, and scale so that its largest extent is `targetSizeM`.

   ── Why the largest extent, and not the diagonal or the volume ──────────────

   The dominant asset is a nearly flat plane — one of its three extents is
   ~zero. A cube-root-of-volume normalisation divides by zero on it. The
   diagonal is well defined but is `sqrt(w^2 + h^2)` for a plane, so a 16:9
   photo comes out 13% smaller than a 1:1 one for no reason a viewer could
   name. The largest extent gives the simple, statable guarantee "no dimension
   of the asset exceeds the target", which is the property that keeps a portrait
   and a landscape memory feeling like the same kind of object.

   ── The one failure this cannot fix ─────────────────────────────────────────

   A bounding box is a max, so a single stray Gaussian a thousand units from the
   subject makes the extent a thousand and the real content microscopic. That is
   a robust-statistics problem and it belongs upstream, in whatever computes the
   box: a 99th-percentile extent would fix it, an axis-aligned min/max never
   can. Named here because the symptom — "AR placed nothing, the tap did
   nothing" — points at this file, and the cause is not in it.
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * How big a memory should be when it lands.
 *
 * A phone is held roughly 1.5-2 m from the spot the user taps on the floor, and
 * an AR camera's vertical field of view is around 60 degrees, so the frame is
 * about `2 * tan(30 deg) * 1.75 ~ 2.0 m` tall at the anchor. A one-metre object
 * therefore fills about half the frame: big enough to be an object in the room
 * rather than a trinket, small enough that the user can see all of it without
 * backing into a wall. It is also, usefully, about the size of a large framed
 * print — which is the physical thing a reconstructed photo most resembles, so
 * the viewer already has a prior for how far away to stand.
 *
 * Below ~0.3 m the result reads as a doll's-house model of the memory; above
 * ~2 m the top leaves the frame before the user has registered what it is.
 */
export const DEFAULT_TARGET_SIZE_M = 1;

/**
 * How small and how large the user may pinch it afterwards.
 *
 * 5 cm is where a memory on a table becomes a smudge you cannot aim a finger at
 * — and since the drag gesture is the only way to move it, an asset too small
 * to hit is an asset the user has lost. 20 m is past the size of any room this
 * runs in; beyond that the user is inside the splat and every frame is one
 * blurred Gaussian, which reads as the app having crashed.
 */
export const MIN_WORLD_SIZE_M = 0.05;
export const MAX_WORLD_SIZE_M = 20;

/**
 * Pinch range used when the asset's extent is unknown, i.e. when `scale` is a
 * bare multiplier with no metric meaning. Symmetric about 1 because that is the
 * only defensible choice with no size to anchor to.
 */
const FALLBACK_SCALE_RANGE = 20;

export interface ArrivalScaleInput {
  /** The asset's bounding-box SIZE in asset units — `box.getSize(new Vector3())`. */
  size: Vec3Like;
  targetSizeM?: number;
  minSizeM?: number;
  maxSizeM?: number;
}

export interface ArrivalScale {
  /** Multiplier from asset units to metres. Feed into `ArPlacement.scale`. */
  scale: number;
  /** The extent `scale` was computed against, in asset units. */
  extent: number;
  /** Absolute bounds implied by `minSizeM`/`maxSizeM`. Feed into `updateTwoFinger`. */
  limits: ScaleLimits;
}

/** Largest bounding-box extent, or 0 when the box cannot be measured. */
export const assetExtent = (size: Vec3Like): number => {
  const x = isFiniteNumber(size.x) ? Math.abs(size.x) : 0;
  const y = isFiniteNumber(size.y) ? Math.abs(size.y) : 0;
  const z = isFiniteNumber(size.z) ? Math.abs(size.z) : 0;
  return Math.max(x, y, z);
};

/**
 * Turn a physical size range into bounds on the abstract `scale` multiplier.
 * Kept separate so the gesture code never has to know what an asset unit is.
 */
export const scaleLimitsFromWorldSize = (
  extent: number,
  minSizeM: number = MIN_WORLD_SIZE_M,
  maxSizeM: number = MAX_WORLD_SIZE_M,
): ScaleLimits => {
  if (!isFiniteNumber(extent) || extent <= 0) {
    return { min: 1 / FALLBACK_SCALE_RANGE, max: FALLBACK_SCALE_RANGE };
  }
  const lo = isFiniteNumber(minSizeM) && minSizeM > 0 ? minSizeM : MIN_WORLD_SIZE_M;
  const hi = isFiniteNumber(maxSizeM) && maxSizeM > lo ? maxSizeM : Math.max(lo * 2, MAX_WORLD_SIZE_M);
  return { min: lo / extent, max: hi / extent };
};

export const clampScale = (scale: number, limits: ScaleLimits): number => {
  const lo = Math.min(limits.min, limits.max);
  const hi = Math.max(limits.min, limits.max);
  // A non-finite scale would silently un-draw the asset rather than throw, so
  // it degrades to the closest thing to "unscaled" the limits allow.
  if (!isFiniteNumber(scale) || scale <= 0) return clamp(1, lo, hi);
  return clamp(scale, lo, hi);
};

export const computeArrivalScale = ({
  size,
  targetSizeM = DEFAULT_TARGET_SIZE_M,
  minSizeM = MIN_WORLD_SIZE_M,
  maxSizeM = MAX_WORLD_SIZE_M,
}: ArrivalScaleInput): ArrivalScale => {
  const extent = assetExtent(size);
  const limits = scaleLimitsFromWorldSize(extent, minSizeM, maxSizeM);

  // No measurable box: the honest answer is that we do not know the units, and
  // 1 is the only value that cannot be accused of having invented a size. The
  // gesture limits still apply, so the user can pinch their way out of it.
  if (extent <= 0) return { scale: 1, extent: 0, limits };

  const target = isFiniteNumber(targetSizeM) && targetSizeM > 0 ? targetSizeM : DEFAULT_TARGET_SIZE_M;
  return { scale: clampScale(target / extent, limits), extent, limits };
};

/* ────────────────────────────────────────────────────────────────────────────
   3. Composition.
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * Bottom centre of the bounding box: the point that touches the floor.
 *
 * `min.y` rather than `center.y` because a memory is stood on a surface, not
 * skewered through the middle of it. `center.x/z` rather than `min` because
 * laterally the user aimed at where the thing should BE, not at its left edge.
 */
export const assetFrameFromBounds = (bounds: THREE.Box3): AssetFrame | null => {
  /*
    An EMPTY box is not a degenerate case to average — it is +Infinity/-Infinity.

    Spark's `SplatMesh.getBoundingBox()` seeds min=+Inf / max=-Inf and only
    narrows them inside `forEachSplat`, so an asset with zero splats returns a
    box that is still at those sentinels. `Box3.applyMatrix4` returns early on
    an empty box, so the emptiness survives into here, and the midpoint
    `(+Inf + -Inf) / 2` is NaN. That NaN then flows through
    `placementTransform` into `object.position`, and three propagates it into
    the world matrix — the asset vanishes with no error anywhere, which reads as
    "AR is broken" rather than "this asset has no splats".

    `isEmpty()` is the documented test for exactly this and costs nothing.
    Returning null rather than a zero frame keeps the distinction honest:
    `placementTransform` already treats a missing frame as "no anchor offset",
    which is the correct behaviour for an asset that has no extent to centre.

    The sibling `computeArrivalScale` is already safe by accident — `getSize`
    on an empty box yields (0,0,0) and it falls back to its default — so this
    was the only unguarded path.
  */
  if (bounds.isEmpty()) return null;

  return {
    anchor: new THREE.Vector3(
      (bounds.min.x + bounds.max.x) / 2,
      bounds.min.y,
      (bounds.min.z + bounds.max.z) / 2,
    ),
  };
};

/**
 * Resolve a placement against an asset frame into a plain TRS.
 *
 * The composed transform is `M = T(p) . R_y(yaw) . S(s) . T(-anchor)`, chosen so
 * that the asset-local `anchor` lands exactly on `p`. That is not a general
 * matrix — because the scale is uniform it collapses:
 *
 *     M x = p + R S (x - a) = (p - R S a) + R S x
 *
 * so it is still a pure position/quaternion/scale, which matters because an
 * Object3D can only hold a TRS: writing the full matrix would need
 * `matrixAutoUpdate = false`, and any code that later touched `.position`
 * (three's own XR helpers do) would silently drop the anchor offset.
 */
export const placementTransform = (
  placement: ArPlacement,
  frame?: AssetFrame | null,
): PlacementTransform => {
  const quaternion = new THREE.Quaternion().setFromAxisAngle(WORLD_UP, placement.yaw);
  const scale = placement.scale;
  const position = new THREE.Vector3().copy(placement.position);
  if (frame) {
    position.sub(
      new THREE.Vector3().copy(frame.anchor).multiplyScalar(scale).applyQuaternion(quaternion),
    );
  }
  return { position, quaternion, scale };
};

const scratchScale = new THREE.Vector3();

export const composePlacementMatrix = (
  placement: ArPlacement,
  frame?: AssetFrame | null,
  target: THREE.Matrix4 = new THREE.Matrix4(),
): THREE.Matrix4 => {
  const { position, quaternion, scale } = placementTransform(placement, frame);
  return target.compose(position, quaternion, scratchScale.setScalar(scale));
};

/**
 * The only function in this file that writes to anything. It exists so the
 * viewer cannot get the anchor offset wrong by hand — the subtraction above is
 * easy to forget and its symptom (the memory lands near, but not on, the tap)
 * looks like hit-test inaccuracy rather than like a missing term.
 */
export const applyPlacement = (
  object: THREE.Object3D,
  placement: ArPlacement,
  frame?: AssetFrame | null,
): void => {
  const { position, quaternion, scale } = placementTransform(placement, frame);
  object.position.copy(position);
  object.quaternion.copy(quaternion);
  object.scale.setScalar(scale);
  object.updateMatrixWorld(true);
};

/* ────────────────────────────────────────────────────────────────────────────
   4. Gestures.

   Each gesture is (previous state, pointer input) -> new state, with the
   "previous state" captured once at pointer-down and held constant for the
   whole gesture. Nothing integrates per-event deltas, and that is deliberate on
   both counts:

     • Accumulating deltas accumulates their rounding error, so a slow drag
       across the screen and back does not return the object to where it
       started — an unfixable-feeling drift the user can reproduce at will.

     • With a fixed reference, a dropped or coalesced pointer event costs
       nothing: the next event computes the same answer it would have anyway.
       Integrated deltas turn a dropped event into a permanent offset.

   The corollary is that the caller must call `begin*` on pointerdown (or on the
   transition from one to two fingers) and keep the returned gesture for the
   duration.
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * How far along the surface a drag may reach.
 *
 * Not taste — arithmetic. As the ray approaches parallel with the surface the
 * intersection distance goes to infinity, and `Ray.intersectPlane` only rejects
 * the EXACTLY parallel case (`denominator === 0`), so one pixel of finger
 * movement near the horizon line can move the anchor from 30 m to 300 m. At
 * that point a 1 m memory is a couple of pixels tall, and dragging it back
 * requires hitting the same near-horizon pixel again. Refusing the update
 * instead leaves it where it was, which the user experiences as the drag simply
 * not going any further.
 */
export const MAX_SURFACE_DISTANCE_M = 30;

/**
 * Two touches closer than this are not two fingers.
 *
 * A modern phone reports roughly 5-6 CSS pixels per millimetre, and two
 * fingertips cannot get closer than about 20 mm centre to centre, so a real
 * pinch never starts below ~100 px. The floor is set far below that on purpose:
 * it is a divide-by-nearly-zero guard, not a gesture threshold, and setting it
 * anywhere near the physical minimum would start rejecting real pinches by
 * small hands on dense displays. At 24 px (~4 mm) the only thing being rejected
 * is a digitizer artefact or a palm — and dividing by a span that small turns a
 * one-pixel tremor into a doubling of scale and most of a turn of yaw inside a
 * single frame.
 */
export const MIN_PINCH_SPAN_PX = 24;

/** NDC from canvas pixels. The y flip is the whole content of this function. */
export const pointerToNdc = (pointer: PointerSample, viewport: ViewportSize): { x: number; y: number } | null => {
  if (!isFiniteNumber(viewport.width) || !isFiniteNumber(viewport.height)) return null;
  if (viewport.width <= 0 || viewport.height <= 0) return null;
  if (!isFiniteNumber(pointer.x) || !isFiniteNumber(pointer.y)) return null;
  return {
    x: (pointer.x / viewport.width) * 2 - 1,
    // Pointer y grows downward, NDC y grows upward.
    y: 1 - (pointer.y / viewport.height) * 2,
  };
};

const scratchNear = new THREE.Vector3();
const scratchMid = new THREE.Vector3();
const scratchRay = new THREE.Ray();

/**
 * Where the surface is, under the finger.
 *
 * The ray is built by unprojecting the same NDC point at two depths rather than
 * with `Raycaster.setFromCamera`, for one reason: `setFromCamera` branches on
 * `isPerspectiveCamera`/`isOrthographicCamera`, and three's XR ArrayCamera
 * answers true to the first while carrying a union projection that is not any
 * single view's. Two unprojects are correct for every camera that has a valid
 * `projectionMatrixInverse`, including one handed over by the XR manager, and
 * the maths is visible instead of being three's.
 *
 * NDC z = -1 is the near plane and z = 0 is roughly mid-frustum; the far plane
 * is avoided because at a far/near ratio of 50000 (the viewer runs 0.01/500)
 * the unprojected far point has lost most of its significant figures.
 *
 * ── Why a ray at all, when a screen delta is right there ────────────────────
 *
 * The tempting cheap version is "move the anchor by the pixel delta times some
 * metres-per-pixel". That is only correct for a surface viewed head-on. A floor
 * is viewed at a grazing angle: near the bottom of the screen one pixel is a
 * centimetre of floor, and two thirds of the way up it is a metre. A linear
 * mapping makes the memory slide out from under the finger the moment the drag
 * goes away from the user, and the error grows with distance, so it feels like
 * lag rather than like a wrong constant.
 */
export const surfacePointUnderPointer = (
  pointer: PointerSample,
  view: PointerView,
  plane: THREE.Plane,
  maxDistance: number = MAX_SURFACE_DISTANCE_M,
): THREE.Vector3 | null => {
  const ndc = pointerToNdc(pointer, view.viewport);
  if (!ndc) return null;

  scratchNear.set(ndc.x, ndc.y, -1).unproject(view.camera);
  scratchMid.set(ndc.x, ndc.y, 0).unproject(view.camera);
  scratchRay.origin.copy(scratchNear);
  scratchRay.direction.copy(scratchMid).sub(scratchNear);
  if (scratchRay.direction.lengthSq() < 1e-20) return null;
  scratchRay.direction.normalize();

  const hit = scratchRay.intersectPlane(plane, new THREE.Vector3());
  // Null here means the ray is parallel to the surface or points away from it —
  // in practice, the user dragged above the horizon line. Leaving the placement
  // alone is the only sane answer: the alternative is a point at infinity.
  if (!hit) return null;
  if (!isFiniteNumber(hit.x) || !isFiniteNumber(hit.y) || !isFiniteNumber(hit.z)) return null;
  if (hit.distanceTo(scratchRay.origin) > maxDistance) return null;
  return hit;
};

/** The horizontal plane a placement stands on. Pass an explicit normal for a wall. */
export const surfacePlaneFor = (
  placement: ArPlacement,
  normal: Vec3Like = WORLD_UP,
  target: THREE.Plane = new THREE.Plane(),
): THREE.Plane => {
  const n = new THREE.Vector3(normal.x, normal.y, normal.z);
  if (n.lengthSq() < 1e-12) n.copy(WORLD_UP);
  n.normalize();
  // `setFromNormalAndCoplanarPoint` does not normalise for you, and an
  // unnormalised normal makes `constant` inconsistent with `distanceToPoint`,
  // which makes the ray intersection land at the wrong depth.
  return target.setFromNormalAndCoplanarPoint(n, placement.position);
};

export interface DragGesture {
  /** Placement at pointer-down. Returned unchanged whenever the ray misses. */
  readonly origin: ArPlacement;
  /** The surface the drag is constrained to. */
  readonly plane: THREE.Plane;
  /** `origin.position - (surface point under the finger at pointer-down)`. */
  readonly grabOffset: THREE.Vector3;
  readonly maxDistance: number;
}

export interface DragOptions {
  /** Defaults to the horizontal plane through `placement.position`. */
  plane?: THREE.Plane | null;
  maxDistance?: number;
}

/**
 * The grab offset is why a drag does not begin with a jump.
 *
 * Without it, the first move teleports the anchor to whatever point is under
 * the finger — and since the finger is almost never on the anchor (it is on
 * the visible body of the memory, which stands ABOVE the anchor and so appears
 * well up the screen from it) the asset lurches toward the user by most of its
 * own height before the drag starts tracking. Recording the offset once makes
 * the whole gesture relative.
 */
export const beginDrag = (
  placement: ArPlacement,
  pointer: PointerSample,
  view: PointerView,
  options?: DragOptions,
): DragGesture => {
  const plane = options?.plane ?? surfacePlaneFor(placement);
  const requested = options?.maxDistance;
  const maxDistance =
    isFiniteNumber(requested) && requested > 0 ? requested : MAX_SURFACE_DISTANCE_M;

  const grabbed = surfacePointUnderPointer(pointer, view, plane, maxDistance);
  // A pointer-down that misses the surface (started on the sky, or on the UI
  // over it) degrades to a zero offset: the first successful move centres the
  // anchor under the finger. Visible, but recoverable in the same gesture —
  // unlike refusing to start, which leaves the user pressing on the memory and
  // nothing happening.
  const grabOffset = grabbed
    ? new THREE.Vector3().copy(placement.position).sub(grabbed)
    : new THREE.Vector3();

  return { origin: placement, plane, grabOffset, maxDistance };
};

/**
 * Slide along the surface. Yaw and scale are carried through untouched: a
 * physical object does not spin to keep facing you as you push it across a
 * table, so re-running `yawTowardViewer` here would make the memory pivot to
 * track the user for the whole drag, which reads as the object being haunted
 * rather than as a feature.
 *
 * When the ray misses the surface this returns `gesture.origin` BY REFERENCE,
 * not a copy — so a caller holding it in React state gets an identity-equal
 * value and bails out of the re-render, and `updateDrag(...) === placement` is
 * a usable test for "the drag went nowhere".
 */
export const updateDrag = (
  gesture: DragGesture,
  pointer: PointerSample,
  view: PointerView,
): ArPlacement => {
  const point = surfacePointUnderPointer(pointer, view, gesture.plane, gesture.maxDistance);
  if (!point) return gesture.origin;
  return {
    position: point.add(gesture.grabOffset),
    yaw: gesture.origin.yaw,
    scale: gesture.origin.scale,
  };
};

export interface TwoFingerGesture {
  readonly origin: ArPlacement;
  /** Pixel distance between the two pointers at gesture start. */
  readonly startSpan: number;
  /** `atan2(dy, dx)` of the vector between them at gesture start, y DOWNWARD. */
  readonly startAngle: number;
  /** False when the fingers started too close together to measure. */
  readonly usable: boolean;
}

const spanOf = (a: PointerSample, b: PointerSample) => Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);

/** Screen-space angle of the finger pair. Increases CLOCKWISE, because y is down. */
const angleOf = (a: PointerSample, b: PointerSample) => Math.atan2(b.y - a.y, b.x - a.x);

export const beginTwoFinger = (
  placement: ArPlacement,
  a: PointerSample,
  b: PointerSample,
): TwoFingerGesture => {
  const startSpan = spanOf(a, b);
  const usable = isFiniteNumber(startSpan) && startSpan >= MIN_PINCH_SPAN_PX;
  return {
    origin: placement,
    startSpan,
    startAngle: usable ? angleOf(a, b) : 0,
    usable,
  };
};

/**
 * Pinch to scale, twist to spin.
 *
 * ── Scale ───────────────────────────────────────────────────────────────────
 *
 * `scale = origin.scale * span / startSpan`. A ratio and not a difference: the
 * user's expectation is that moving the fingers from 100 px apart to 200 px
 * doubles the object, and that doing it again doubles it again, whatever the
 * object currently is. A difference-based rule makes the same finger movement
 * mean something different at every size.
 *
 * ── Twist ───────────────────────────────────────────────────────────────────
 *
 * Sign, derived rather than guessed. Look down the world +Y axis at the ground:
 * a plan view with +X to the right of the page and +Z toward the bottom of it.
 * `R_y(+a)` carries +Z to `(sin a, 0, cos a)`, i.e. it moves the bottom of the
 * page toward the right — six o'clock toward three o'clock — which is
 * COUNTER-clockwise. Screen angle is `atan2(dy, dx)` with y measured DOWNWARD,
 * so it increases CLOCKWISE. The two senses are opposite, hence
 *
 *     yaw = origin.yaw - (angle - startAngle)
 *
 * and a clockwise finger twist turns the memory clockwise as seen from above,
 * which is the convention Scene Viewer and Quick Look both use and the only one
 * that stays predictable when the user walks around to the other side.
 *
 * Twisting more than half a turn makes `angle - startAngle` cross the atan2
 * branch cut and jump by 2*PI. That is harmless HERE and only here: yaw is
 * consumed solely as a rotation, and a rotation is periodic, so the object does
 * not move. It would not be harmless if a caller eased toward the yaw value, so
 * the result is wrapped into (-PI, PI] before it leaves.
 */
export const updateTwoFinger = (
  gesture: TwoFingerGesture,
  a: PointerSample,
  b: PointerSample,
  limits?: ScaleLimits,
): ArPlacement => {
  const span = spanOf(a, b);
  const live = gesture.usable && isFiniteNumber(span) && span >= MIN_PINCH_SPAN_PX;

  const ratio = live ? span / gesture.startSpan : 1;
  const raw = gesture.origin.scale * ratio;
  const scale = limits ? clampScale(raw, limits) : raw;

  const deltaYaw = live ? gesture.startAngle - angleOf(a, b) : 0;

  return {
    // A NEW Vector3, not the origin's: a caller that keeps both the pre-gesture
    // placement (for cancel) and the live one would otherwise be holding one
    // object twice, and moving the memory afterwards would rewrite its undo.
    position: new THREE.Vector3().copy(gesture.origin.position),
    yaw: wrapAngle(gesture.origin.yaw + deltaYaw),
    scale: isFiniteNumber(scale) && scale > 0 ? scale : gesture.origin.scale,
  };
};
