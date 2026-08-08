import * as THREE from 'three';
import {
  computeOffAxisFrustum,
  computeOffAxisFrustumFromCorners,
  makeOffAxisProjection,
  mapHeadPoseToEye,
  ScreenSpaceEye,
  computeAngularScale,
  calibrationDistanceMeters,
  computeWindowGeometry,
  WindowGeometry,
  DEFAULT_VIEWING_DISTANCE_M,
  MIN_ANGULAR_SCALE,
  MAX_ANGULAR_SCALE,
} from './magicWindow';
import { measureCanvasRectMetres } from './screenGeometry';

/**
 * As in cameraUtils.test.ts, the assertions are made against THREE's own
 * projection maths rather than against the formula under test: build a real
 * camera, hand it the matrix, and look at the normalised device coordinates
 * that come back out of `Vector3.project`.
 *
 * The scene is set up so that screen space IS world space — the window lies in
 * the z = 0 plane, centred on the origin, and the eye is somewhere at z > 0
 * looking down -Z. That is the frame `computeOffAxisFrustum` is defined in, so
 * no change of basis muddies what is being tested.
 */
const HALF_WIDTH = 1.6;
const HALF_HEIGHT = 0.9;
const NEAR = 0.05;
const FAR = 100;

const cameraAt = (eye: ScreenSpaceEye, projection: THREE.Matrix4) => {
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(eye.x, eye.y, eye.z);
  camera.quaternion.identity(); // looking down -Z: straight through the glass
  camera.updateMatrixWorld(true);
  camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
  camera.projectionMatrix.copy(projection);
  camera.projectionMatrixInverse.copy(projection).invert();
  return camera;
};

const offAxisCamera = (eye: ScreenSpaceEye) =>
  cameraAt(
    eye,
    makeOffAxisProjection(
      computeOffAxisFrustum({
        halfWidth: HALF_WIDTH,
        halfHeight: HALF_HEIGHT,
        eye,
        near: NEAR,
        far: FAR,
      }),
    ),
  );

/** The four corners of the glass, in the z = 0 plane. */
const WINDOW_CORNERS = [
  new THREE.Vector3(-HALF_WIDTH, -HALF_HEIGHT, 0),
  new THREE.Vector3(HALF_WIDTH, -HALF_HEIGHT, 0),
  new THREE.Vector3(-HALF_WIDTH, HALF_HEIGHT, 0),
  new THREE.Vector3(HALF_WIDTH, HALF_HEIGHT, 0),
];

/** Eye positions worth checking: centred, hard left, high, leaning in, leaning out. */
const EYES: ScreenSpaceEye[] = [
  { x: 0, y: 0, z: 2 },
  { x: 0.7, y: 0, z: 2 },
  { x: -0.7, y: 0.35, z: 2 },
  { x: 0.4, y: -0.5, z: 0.9 },
  { x: -0.25, y: 0.15, z: 4.5 },
];

describe('computeOffAxisFrustum', () => {
  it('welds the window corners to the corners of the viewport, wherever the eye is', () => {
    // This is the definition of a magic window: the glass does not move when
    // your head does. Everything else in this module exists to make it true.
    for (const eye of EYES) {
      const camera = offAxisCamera(eye);
      for (const corner of WINDOW_CORNERS) {
        const ndc = corner.clone().project(camera);
        expect(Math.abs(ndc.x)).toBeCloseTo(1, 9);
        expect(Math.abs(ndc.y)).toBeCloseTo(1, 9);
        expect(Math.sign(ndc.x)).toBe(Math.sign(corner.x));
        expect(Math.sign(ndc.y)).toBe(Math.sign(corner.y));
      }
    }
  });

  it('is not what "move the camera and lookAt the subject" does', () => {
    // The construction being replaced. It fails the test above by a mile, which
    // is why the feature never read as a window: the whole scene, glass
    // included, swung across the screen as the viewer leaned.
    const eye = { x: 0.7, y: 0, z: 2 };
    const camera = new THREE.PerspectiveCamera(
      // Same field of view as the centred off-axis case, so the comparison is
      // about the asymmetry and not about zoom.
      2 * THREE.MathUtils.radToDeg(Math.atan(HALF_HEIGHT / eye.z)),
      HALF_WIDTH / HALF_HEIGHT,
      NEAR,
      FAR,
    );
    camera.position.set(eye.x, eye.y, eye.z);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();

    const drift = WINDOW_CORNERS.map((c) => Math.abs(Math.abs(c.clone().project(camera).x) - 1));
    expect(Math.max(...drift)).toBeGreaterThan(0.1);
  });

  it('reduces to an ordinary symmetric perspective camera when the eye is centred', () => {
    const eye = { x: 0, y: 0, z: 2.5 };
    const frustum = computeOffAxisFrustum({
      halfWidth: HALF_WIDTH,
      halfHeight: HALF_HEIGHT,
      eye,
      near: NEAR,
      far: FAR,
    });
    expect(frustum.left).toBeCloseTo(-frustum.right, 12);
    expect(frustum.bottom).toBeCloseTo(-frustum.top, 12);

    const symmetric = new THREE.PerspectiveCamera(
      2 * THREE.MathUtils.radToDeg(Math.atan(HALF_HEIGHT / eye.z)),
      HALF_WIDTH / HALF_HEIGHT,
      NEAR,
      FAR,
    );
    symmetric.updateProjectionMatrix();
    const mine = makeOffAxisProjection(frustum);
    mine.elements.forEach((v, i) => expect(v).toBeCloseTo(symmetric.projectionMatrix.elements[i], 9));
  });

  it('agrees with the general three-corner form of Kooima 2008', () => {
    // The axis-aligned specialization must not be a different projection that
    // happens to share a name with the published derivation.
    for (const eye of EYES) {
      const specialized = computeOffAxisFrustum({
        halfWidth: HALF_WIDTH,
        halfHeight: HALF_HEIGHT,
        eye,
        near: NEAR,
        far: FAR,
      });
      const general = computeOffAxisFrustumFromCorners(
        new THREE.Vector3(-HALF_WIDTH, -HALF_HEIGHT, 0),
        new THREE.Vector3(HALF_WIDTH, -HALF_HEIGHT, 0),
        new THREE.Vector3(-HALF_WIDTH, HALF_HEIGHT, 0),
        new THREE.Vector3(eye.x, eye.y, eye.z),
        NEAR,
        FAR,
      );
      expect(general.left).toBeCloseTo(specialized.left, 12);
      expect(general.right).toBeCloseTo(specialized.right, 12);
      expect(general.bottom).toBeCloseTo(specialized.bottom, 12);
      expect(general.top).toBeCloseTo(specialized.top, 12);
    }
  });

  it('parallaxes what is behind the glass by exactly the pinhole amount', () => {
    // A point `p` behind the glass, seen from an eye `e` off to the side, lands
    // on the glass at e * p / (p + z). Nothing about that is a tuning constant;
    // if this drifts, the depth cue is wrong.
    const depth = 1.4;
    const point = new THREE.Vector3(0, 0, -depth);
    for (const eye of EYES) {
      const ndc = point.clone().project(offAxisCamera(eye));
      const expectedX = (eye.x * depth) / (depth + eye.z) / HALF_WIDTH;
      const expectedY = (eye.y * depth) / (depth + eye.z) / HALF_HEIGHT;
      expect(ndc.x).toBeCloseTo(expectedX, 9);
      expect(ndc.y).toBeCloseTo(expectedY, 9);
    }
  });

  it('never lets the near plane reach the glass', () => {
    // Leaning right up to the screen must not invert the frustum. A near plane
    // at or beyond the eye distance turns the scene inside out.
    const frustum = computeOffAxisFrustum({
      halfWidth: HALF_WIDTH,
      halfHeight: HALF_HEIGHT,
      eye: { x: 0, y: 0, z: 0.02 },
      near: 0.5,
      far: FAR,
    });
    expect(frustum.near).toBeLessThan(0.02);
    expect(frustum.right).toBeGreaterThan(frustum.left);
    expect(frustum.top).toBeGreaterThan(frustum.bottom);
    expect(frustum.far).toBeGreaterThan(frustum.near);
  });

  it('writes into a caller-supplied matrix so the render loop can avoid allocating', () => {
    const target = new THREE.Matrix4();
    const returned = makeOffAxisProjection(
      computeOffAxisFrustum({
        halfWidth: HALF_WIDTH,
        halfHeight: HALF_HEIGHT,
        eye: EYES[1],
        near: NEAR,
        far: FAR,
      }),
      target,
    );
    expect(returned).toBe(target);
  });
});

describe('mapHeadPoseToEye', () => {
  const NEUTRAL = { x: 0, y: 0, z: 1 };
  const WINDOW_DISTANCE = 1.375;

  it('puts the neutral pose exactly on the window axis for every sensitivity', () => {
    // What makes the sensitivity slider safe to drag while someone is watching:
    // changing the gain must not move the view unless the head has moved.
    for (const sensitivity of [0.25, 1, 1.5, 3]) {
      const eye = mapHeadPoseToEye({
        pose: NEUTRAL,
        windowDistance: WINDOW_DISTANCE,
        sensitivity,
        blend: 1,
      });
      expect(eye.x).toBe(0);
      expect(eye.y).toBe(0);
      expect(eye.z).toBeCloseTo(WINDOW_DISTANCE, 12);
    }
  });

  it('is linear in the pose and in the sensitivity, at gain 1 being physically faithful', () => {
    const pose = { x: 0.2, y: -0.1, z: 0.85 };
    const one = mapHeadPoseToEye({ pose, windowDistance: WINDOW_DISTANCE, sensitivity: 1, blend: 1 });
    // Lateral offset in units of the calibrated distance, times the window
    // distance, is the offset in world units. No fudge factor.
    expect(one.x).toBeCloseTo(0.2 * WINDOW_DISTANCE, 12);
    expect(one.y).toBeCloseTo(-0.1 * WINDOW_DISTANCE, 12);
    expect(one.z).toBeCloseTo(0.85 * WINDOW_DISTANCE, 12);

    const two = mapHeadPoseToEye({ pose, windowDistance: WINDOW_DISTANCE, sensitivity: 2, blend: 1 });
    expect(two.x).toBeCloseTo(one.x * 2, 12);
    // Depth scales the EXCURSION, not the absolute distance, so the neutral
    // point stays put: 1 + 2*(0.85 - 1) = 0.7.
    expect(two.z).toBeCloseTo(0.7 * WINDOW_DISTANCE, 12);
  });

  it('collapses to the neutral view as the tracking blend falls to zero', () => {
    const pose = { x: 0.3, y: 0.3, z: 0.7 };
    const lost = mapHeadPoseToEye({ pose, windowDistance: WINDOW_DISTANCE, sensitivity: 1.5, blend: 0 });
    expect(lost.x).toBe(0);
    expect(lost.y).toBe(0);
    expect(lost.z).toBeCloseTo(WINDOW_DISTANCE, 12);

    const half = mapHeadPoseToEye({ pose, windowDistance: WINDOW_DISTANCE, sensitivity: 1, blend: 0.5 });
    const full = mapHeadPoseToEye({ pose, windowDistance: WINDOW_DISTANCE, sensitivity: 1, blend: 1 });
    expect(half.x).toBeCloseTo(full.x / 2, 12);
  });

  it('clamps a wild detection instead of flinging the frustum', () => {
    // One frame of a face found in a poster on the wall must not cost a second
    // of smoothing to recover from.
    const eye = mapHeadPoseToEye({
      pose: { x: 40, y: -40, z: 0.01 },
      windowDistance: WINDOW_DISTANCE,
      sensitivity: 3,
      blend: 1,
    });
    expect(Math.abs(eye.x)).toBeLessThanOrEqual(WINDOW_DISTANCE);
    expect(Math.abs(eye.y)).toBeLessThanOrEqual(WINDOW_DISTANCE);
    expect(eye.z).toBeGreaterThan(0);

    const farBack = mapHeadPoseToEye({
      pose: { x: 0, y: 0, z: 99 },
      windowDistance: WINDOW_DISTANCE,
      sensitivity: 3,
      blend: 1,
    });
    expect(farBack.z).toBeLessThanOrEqual(WINDOW_DISTANCE * 2.5 + 1e-9);
  });

  it('survives a non-finite depth ratio rather than producing a NaN matrix', () => {
    // A NaN reaching `projectionMatrix` blanks the canvas with no error at all.
    const eye = mapHeadPoseToEye({
      pose: { x: 0, y: 0, z: NaN },
      windowDistance: WINDOW_DISTANCE,
      sensitivity: 1.5,
      blend: 1,
    });
    expect(Number.isFinite(eye.z)).toBe(true);
    expect(eye.z).toBeCloseTo(WINDOW_DISTANCE, 12);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
   Physical screen calibration.

   The claim under test is not "the numbers look plausible", it is a chain of
   three specific properties, each of which the module's block comment derives
   and each of which is asserted here against an independently worked-out value
   rather than against a second copy of the same formula:

     1.  The projection is scale-free — glass, eye and scene may be measured in
         any common unit. This is what allows a metric calibration to be dropped
         into a world-unit renderer without a second projection path.
     2.  At the neutral pose the calibrated and uncalibrated views frame the
         subject identically, so enabling XR does not re-frame the memory.
     3.  Once calibrated, a head movement of X metres shifts the background by
         X / (screen half-width in metres) in NDC. Exactly, not approximately.

   Property 2 needs stating carefully, because the loose version of it is false
   and the tests below would be worthless if they asserted the loose version:
   the two PROJECTION MATRICES are NOT equal and must not be. Calibration is a
   dolly — the camera pulls back to `L * A` and the lens narrows by the same `A`
   — so the frustum is literally `1/A` times as wide. What is identical, to the
   last digit, is where every point IN THE TARGET PLANE lands on screen. Points
   off that plane move, and that flattening is the visible signature of the
   calibration being real rather than a gain tweak.
   ──────────────────────────────────────────────────────────────────────────── */

describe('computeAngularScale', () => {
  // A 27-inch 16:9 panel at 2560x1440 with a 1600x900 canvas on it, viewed from
  // 62 cm, against a 50-degree virtual camera. Worked out by hand:
  //   mm per CSS px = 597.726503 / 2560     = 0.2334869154
  //   canvas half-height = 900 * that / 2000 = 0.1050691119 m
  //   A = tan(25 deg) * 0.62 / 0.1050691119
  //     = 0.4663076582 * 0.62 / 0.1050691119 = 2.7516245524
  const HALF_HEIGHT_M = 0.1050691119187530;
  const CAL_DISTANCE_M = 0.62;

  it('is the ratio of the virtual to the physical half-angle', () => {
    const scale = computeAngularScale({
      fovDeg: 50,
      halfHeightM: HALF_HEIGHT_M,
      calibrationDistanceM: CAL_DISTANCE_M,
    });
    expect(scale).toBeCloseTo(2.7516245524, 9);

    // The same number from the definition the comment gives it —
    // tan(theta_virtual) / tan(theta_physical) — reached without going through
    // `tan(fov/2) * d / h` at all.
    const thetaVirtual = THREE.MathUtils.degToRad(50) / 2;
    const thetaPhysical = Math.atan(HALF_HEIGHT_M / CAL_DISTANCE_M);
    expect(scale).toBeCloseTo(Math.tan(thetaVirtual) / Math.tan(thetaPhysical), 12);

    // And the sanity check on the sign of the effect: a 27-inch screen at
    // arm's length subtends far less than 50 degrees, so the real angle is
    // narrower and A must be greater than 1.
    expect(THREE.MathUtils.radToDeg(2 * thetaPhysical)).toBeLessThan(20);
    expect(scale).toBeGreaterThan(1);
  });

  it('is exactly 1 — the old, uncalibrated projection — for every unusable input', () => {
    // Degrading to the previous behaviour bit for bit is the whole point of
    // returning 1 rather than clamping to something near it: a bad calibration
    // must be indistinguishable from no calibration.
    const base = { fovDeg: 50, halfHeightM: HALF_HEIGHT_M, calibrationDistanceM: CAL_DISTANCE_M };
    for (const fovDeg of [0, -50, 180, 181, NaN, Infinity]) {
      expect(computeAngularScale({ ...base, fovDeg })).toBe(1);
    }
    for (const halfHeightM of [0, -0.1, NaN, Infinity]) {
      expect(computeAngularScale({ ...base, halfHeightM })).toBe(1);
    }
    for (const calibrationDistanceM of [0, -0.6, NaN, Infinity]) {
      expect(computeAngularScale({ ...base, calibrationDistanceM })).toBe(1);
    }
  });

  it('clamps rather than parking the camera somewhere unrenderable', () => {
    // A smartwatch-sized rectangle would put A near 140 and the camera 140
    // subject-distances away, where float depth precision gives up; a
    // projector-sized one buries the camera inside the subject.
    expect(
      computeAngularScale({ fovDeg: 50, halfHeightM: 0.002, calibrationDistanceM: 0.6 }),
    ).toBe(MAX_ANGULAR_SCALE);
    expect(
      computeAngularScale({ fovDeg: 50, halfHeightM: 2, calibrationDistanceM: 0.6 }),
    ).toBe(MIN_ANGULAR_SCALE);
  });

  it('is 1 when the display happens to subtend exactly the virtual field of view', () => {
    // Not a failure mode — this is a projector at the right distance, and the
    // caller must still treat it as calibrated.
    const halfHeightM = Math.tan(THREE.MathUtils.degToRad(50) / 2) * 0.62;
    expect(
      computeAngularScale({ fovDeg: 50, halfHeightM, calibrationDistanceM: 0.62 }),
    ).toBeCloseTo(1, 12);
  });
});

describe('calibrationDistanceMeters', () => {
  it('recovers the calibration distance exactly from the two published fields', () => {
    // The hook sets `z = d / cal.distance` and `distanceMeters = d` from the
    // same filtered sample, so the quotient is `cal.distance` with no drift.
    for (const [cal, d] of [
      [0.62, 0.62], // sitting still at the recentre pose
      [0.62, 0.71], // leaned back 9 cm
      [0.45, 0.30], // leaned right in
      [1.8, 2.4],
    ] as const) {
      const pose = { z: d / cal, distanceMeters: d };
      expect(calibrationDistanceMeters(pose)).toBeCloseTo(cal, 12);
    }
  });

  it('falls back before the first face is seen, rather than reporting zero metres', () => {
    // The neutral pose is `{ z: 1, distanceMeters: 0 }`. A zero here would send
    // the angular scale to 0 and collapse the frustum.
    expect(calibrationDistanceMeters({ z: 1, distanceMeters: 0 })).toBe(
      DEFAULT_VIEWING_DISTANCE_M,
    );
    expect(calibrationDistanceMeters({ z: 1, distanceMeters: 0 }, 0.55)).toBe(0.55);
  });

  it('falls back on every non-finite or non-positive reading', () => {
    for (const pose of [
      { z: NaN, distanceMeters: 0.62 },
      { z: 1, distanceMeters: NaN },
      { z: Infinity, distanceMeters: 0.62 },
      { z: 1, distanceMeters: Infinity },
      { z: 0, distanceMeters: 0.62 },
      { z: -1, distanceMeters: 0.62 },
      { z: 1, distanceMeters: -0.62 },
    ]) {
      expect(calibrationDistanceMeters(pose, 0.77)).toBe(0.77);
    }
  });

  it('rejects a quotient that is not a viewing distance', () => {
    // Outside 0.15-4 m the reading is a mis-detection, not a person. Passing
    // the LAST GOOD value as the fallback is what stops the calibrated camera
    // dollying every time tracking drops for a frame.
    expect(calibrationDistanceMeters({ z: 0.5, distanceMeters: 3.9 }, 0.62)).toBe(0.62); // 7.8 m
    expect(calibrationDistanceMeters({ z: 3, distanceMeters: 0.3 }, 0.62)).toBe(0.62); // 0.1 m
    // The bounds themselves are usable.
    expect(calibrationDistanceMeters({ z: 2, distanceMeters: 0.3 }, 0.62)).toBeCloseTo(0.15, 12);
    expect(calibrationDistanceMeters({ z: 2, distanceMeters: 8 }, 0.62)).toBeCloseTo(4, 12);
  });
});

describe('the scale invariance the calibration is built on', () => {
  const EYE = { x: 0.31, y: -0.22, z: 2.4 };
  const NEAR_K = 0.01;
  const FAR_K = 500;
  // 1000 is in the list on purpose: a splat scene reconstructed from phone
  // photos can be scaled in arbitrary units, and the window must not care.
  const FACTORS = [0.25, 0.5, 2, 4, 1000];

  it('leaves the frustum untouched when glass and eye scale together', () => {
    // `l = (-halfWidth - eye.x) * near / eye.z`: multiply halfWidth, eye.x and
    // eye.z by k and the k cancels between numerator and denominator. Near and
    // far are NOT scaled — they are the renderer's own clip planes, not part of
    // the window — which is exactly why the frustum comes out identical rather
    // than merely similar.
    const base = computeOffAxisFrustum({
      halfWidth: HALF_WIDTH,
      halfHeight: HALF_HEIGHT,
      eye: EYE,
      near: NEAR_K,
      far: FAR_K,
    });
    for (const k of FACTORS) {
      const scaled = computeOffAxisFrustum({
        halfWidth: HALF_WIDTH * k,
        halfHeight: HALF_HEIGHT * k,
        eye: { x: EYE.x * k, y: EYE.y * k, z: EYE.z * k },
        near: NEAR_K,
        far: FAR_K,
      });
      expect(scaled.left).toBeCloseTo(base.left, 12);
      expect(scaled.right).toBeCloseTo(base.right, 12);
      expect(scaled.bottom).toBeCloseTo(base.bottom, 12);
      expect(scaled.top).toBeCloseTo(base.top, 12);
      expect(scaled.near).toBe(base.near);
    }
  });

  it('projects a correspondingly scaled scene to the identical pixel', () => {
    // The consequence that actually matters: measuring the whole setup in
    // millimetres instead of metres changes nothing on screen.
    const point = new THREE.Vector3(0.4, -0.3, -1.7);
    const reference = point
      .clone()
      .project(
        cameraAt(
          EYE,
          makeOffAxisProjection(
            computeOffAxisFrustum({
              halfWidth: HALF_WIDTH,
              halfHeight: HALF_HEIGHT,
              eye: EYE,
              near: NEAR_K,
              far: FAR_K,
            }),
          ),
        ),
      );

    for (const k of FACTORS) {
      const eye = { x: EYE.x * k, y: EYE.y * k, z: EYE.z * k };
      const ndc = point
        .clone()
        .multiplyScalar(k)
        .project(
          cameraAt(
            eye,
            makeOffAxisProjection(
              computeOffAxisFrustum({
                halfWidth: HALF_WIDTH * k,
                halfHeight: HALF_HEIGHT * k,
                eye,
                near: NEAR_K * k,
                far: FAR_K * k,
              }),
            ),
          ),
        );
      expect(ndc.x).toBeCloseTo(reference.x, 9);
      expect(ndc.y).toBeCloseTo(reference.y, 9);
    }
  });

  it('makes computeWindowGeometry proportional to the subject distance', () => {
    // Which is why nothing downstream ever has to know that world units are
    // not metres: a scene reconstructed ten times larger produces a window ten
    // times larger and the same picture.
    const shared = {
      depthFraction: 0.55,
      fovDeg: 50,
      aspect: 16 / 9,
      screenRect: { halfHeightM: 0.105069111918753 },
      calibrationDistanceM: 0.62,
    };
    const small = computeWindowGeometry({ ...shared, subjectDistance: 3.2 });
    const large = computeWindowGeometry({ ...shared, subjectDistance: 32 });

    expect(large.halfWidth).toBeCloseTo(small.halfWidth * 10, 9);
    expect(large.halfHeight).toBeCloseTo(small.halfHeight * 10, 9);
    expect(large.windowDistance).toBeCloseTo(small.windowDistance * 10, 9);
    expect(large.glassToTarget).toBeCloseTo(small.glassToTarget * 10, 9);
    // The dolly factor is an ANGLE ratio, so it must not move at all.
    expect(large.angularScale).toBe(small.angularScale);
  });
});

/* The scenario the remaining suites share: a 1600x900 canvas on a 27-inch 16:9
   2560x1440 panel, a viewer 62 cm away, a 50-degree camera 3.2 world units from
   its target, glass at 55% of the way in. Every expected number below was
   worked out from those six inputs by hand; see each comment. */
const FOV_DEG = 50;
const VIEW_ASPECT = 1600 / 900;
const SUBJECT_DISTANCE = 3.2;
const DEPTH_FRACTION = 0.55;
const CAL_DISTANCE_M = 0.62;

const CANVAS_RECT = measureCanvasRectMetres({
  diagonalInches: 27,
  screen: { cssWidth: 2560, cssHeight: 1440 },
  cssWidth: 1600,
  cssHeight: 900,
})!;

const geometryFor = (screenRect: { halfHeightM: number } | null) =>
  computeWindowGeometry({
    subjectDistance: SUBJECT_DISTANCE,
    depthFraction: DEPTH_FRACTION,
    fovDeg: FOV_DEG,
    aspect: VIEW_ASPECT,
    screenRect,
    calibrationDistanceM: CAL_DISTANCE_M,
  });

/**
 * Project a point given in WORLD space through a window geometry.
 *
 * World space here has its origin at the ORBIT TARGET with +z towards the
 * camera, because that is the frame the scene is fixed in — and the frame in
 * which the two modes can be compared at all. The glass is NOT fixed: it sits
 * `glassToTarget` in front of the target, and calibration moves it. Converting
 * to the screen space `computeOffAxisFrustum` is defined in is therefore a
 * single z shift, and getting that shift wrong is the one way this helper could
 * make a broken calibration look correct.
 */
const projectWorldPoint = (
  geometry: WindowGeometry,
  eye: ScreenSpaceEye,
  world: THREE.Vector3,
): THREE.Vector3 => {
  const camera = cameraAt(
    eye,
    makeOffAxisProjection(
      computeOffAxisFrustum({
        halfWidth: geometry.halfWidth,
        halfHeight: geometry.halfHeight,
        eye,
        near: 0.01,
        far: 1e9,
      }),
    ),
  );
  return new THREE.Vector3(world.x, world.y, world.z - geometry.glassToTarget).project(camera);
};

/** The eye at the pose the user calibrated at: dead centre, no excursion. */
const neutralEye = (geometry: WindowGeometry) =>
  mapHeadPoseToEye({
    pose: { x: 0, y: 0, z: 1 },
    windowDistance: geometry.windowDistance,
    sensitivity: 1,
    blend: 1,
  });

describe('computeWindowGeometry', () => {
  it('reproduces the existing SplatViewer construction exactly when uncalibrated', () => {
    // The regression that matters most: with no calibration stored — which is
    // every headless capture, every first run, and every iOS Safari session —
    // the geometry must be the one `applyMagicWindow` already computes from
    // `anchor.distance = subjectDistance * WINDOW_DEPTH_FRACTION`. If this
    // drifts, wiring calibration in silently re-frames the product video.
    const g = geometryFor(null);
    const anchorDistance = SUBJECT_DISTANCE * DEPTH_FRACTION;

    expect(g.mode).toBe('relative');
    expect(g.angularScale).toBe(1);
    expect(g.windowDistance).toBeCloseTo(anchorDistance, 12);
    expect(g.cameraDistance).toBeCloseTo(SUBJECT_DISTANCE, 12);
    expect(g.glassToTarget).toBeCloseTo(SUBJECT_DISTANCE - anchorDistance, 12);
    expect(g.halfHeight).toBeCloseTo(
      Math.tan(THREE.MathUtils.degToRad(FOV_DEG) / 2) * anchorDistance,
      12,
    );
    expect(g.halfWidth).toBeCloseTo(g.halfHeight * VIEW_ASPECT, 12);
    // tan(25 deg) * 0.55 * 3.2 = 0.4663076582 * 1.76
    expect(g.halfHeight).toBeCloseTo(0.8207014784, 9);
  });

  it('dollies the camera back by A and leaves the glass the size it was', () => {
    const uncal = geometryFor(null);
    const cal = geometryFor(CANVAS_RECT);

    expect(cal.mode).toBe('calibrated');
    expect(cal.angularScale).toBeCloseTo(2.7516245524, 9);
    // The glass is the term that must NOT move; it is what makes the two views
    // frame identically.
    expect(cal.halfWidth).toBe(uncal.halfWidth);
    expect(cal.halfHeight).toBe(uncal.halfHeight);
    // Everything else scales by exactly A.
    expect(cal.cameraDistance).toBeCloseTo(uncal.cameraDistance * cal.angularScale, 9);
    expect(cal.windowDistance).toBeCloseTo(uncal.windowDistance * cal.angularScale, 9);
    expect(cal.glassToTarget).toBeCloseTo(uncal.glassToTarget * cal.angularScale, 9);
    // 3.2 * 2.7516245524 and 0.55 * that.
    expect(cal.cameraDistance).toBeCloseTo(8.8051985677, 8);
    expect(cal.windowDistance).toBeCloseTo(4.8428592123, 8);
  });

  it('reports "calibrated" even when the display happens to give A = 1', () => {
    // A screen that subtends exactly the virtual FOV is a legitimate
    // calibration, not a missing one, and the panel copy says so.
    const halfHeightM = Math.tan(THREE.MathUtils.degToRad(FOV_DEG) / 2) * CAL_DISTANCE_M;
    const g = geometryFor({ halfHeightM });
    expect(g.angularScale).toBeCloseTo(1, 12);
    expect(g.mode).toBe('calibrated');
  });

  it('places the eye at the measured distance from the glass, in metres', () => {
    // The single statement that says the calibration is PHYSICAL rather than a
    // gain tweak. The glass is `halfHeight` world units tall and
    // `CANVAS_RECT.halfHeightM` metres tall, so one world unit is
    // `halfHeightM / halfHeight` metres. Convert the eye's world distance with
    // that and it must come back as the 0.62 m the tracker measured.
    const cal = geometryFor(CANVAS_RECT);
    const metresPerWorldUnit = CANVAS_RECT.halfHeightM / cal.halfHeight;
    expect(cal.windowDistance * metresPerWorldUnit).toBeCloseTo(CAL_DISTANCE_M, 12);

    // And the uncalibrated window fails it by exactly A: it puts the viewer
    // 22.5 cm from a 21 cm-tall screen, which is the error the module exists to
    // remove. 0.62 / 2.7516245524 = 0.2253214376.
    const uncal = geometryFor(null);
    expect(uncal.windowDistance * metresPerWorldUnit).toBeCloseTo(0.2253214376, 9);
  });
});

describe('enabling the calibrated window must not re-frame the memory', () => {
  const CAL = geometryFor(CANVAS_RECT);
  const UNCAL = geometryFor(null);

  it('projects every point in the target plane to the identical NDC', () => {
    // This is the property the whole design is pinned on. The subject sits at
    // the orbit target, so if the target plane is unmoved the memory is framed
    // the same before and after the user calibrates.
    const calEye = neutralEye(CAL);
    const uncalEye = neutralEye(UNCAL);

    for (const x of [-1.2, -0.4, 0, 0.7, 1.5]) {
      for (const y of [-0.9, 0, 0.6]) {
        const p = new THREE.Vector3(x, y, 0); // z = 0 is the target plane
        const a = projectWorldPoint(CAL, calEye, p);
        const b = projectWorldPoint(UNCAL, uncalEye, p);
        expect(a.x).toBeCloseTo(b.x, 12);
        expect(a.y).toBeCloseTo(b.y, 12);

        // Both must also match the closed form the orbit camera would give:
        // a symmetric 50-degree camera 3.2 units from the target sees
        // +/- tan(25 deg) * 3.2 vertically, times the aspect horizontally.
        const halfExtentY = Math.tan(THREE.MathUtils.degToRad(FOV_DEG) / 2) * SUBJECT_DISTANCE;
        expect(a.x).toBeCloseTo(x / (halfExtentY * VIEW_ASPECT), 12);
        expect(a.y).toBeCloseTo(y / halfExtentY, 12);
      }
    }
  });

  it('does it by dollying, so the projection matrix itself is NOT the same', () => {
    // Stated explicitly because the loose reading of the property above — "the
    // projections are equal" — is false and would be the wrong thing to assert.
    // The calibrated lens is exactly 1/A as wide; the camera pulls back by A;
    // the two cancel in the target plane and nowhere else.
    const calFrustum = computeOffAxisFrustum({
      halfWidth: CAL.halfWidth,
      halfHeight: CAL.halfHeight,
      eye: neutralEye(CAL),
      near: 0.01,
      far: 1e9,
    });
    const uncalFrustum = computeOffAxisFrustum({
      halfWidth: UNCAL.halfWidth,
      halfHeight: UNCAL.halfHeight,
      eye: neutralEye(UNCAL),
      near: 0.01,
      far: 1e9,
    });
    expect(calFrustum.top).toBeCloseTo(uncalFrustum.top / CAL.angularScale, 12);
    expect(calFrustum.right).toBeCloseTo(uncalFrustum.right / CAL.angularScale, 12);
  });

  it('flattens the perspective off the target plane, which is the point', () => {
    // A point 1.0 world unit in FRONT of the target, 0.9 to the side. The
    // uncalibrated camera is 3.2 away and throws it out to 0.4935; the
    // calibrated camera is 8.805 away — a longer lens on the same subject — and
    // holds it at 0.3827. That difference is what "looking at a small window
    // from a normal viewing distance" actually looks like.
    const p = new THREE.Vector3(0.9, 0, 1.0);
    const calNdc = projectWorldPoint(CAL, neutralEye(CAL), p);
    const uncalNdc = projectWorldPoint(UNCAL, neutralEye(UNCAL), p);
    expect(uncalNdc.x).toBeCloseTo(0.4934802857, 9);
    expect(calNdc.x).toBeCloseTo(0.3827345850, 9);
    expect(Math.abs(calNdc.x - uncalNdc.x)).toBeGreaterThan(0.1);
  });

  it('needs a wider far plane, because the camera really is further away', () => {
    // Called out in the module comment and worth pinning: at A = 2.75 the
    // camera sits 8.8 units from a target it used to sit 3.2 from, so a `far`
    // sized for the uncalibrated view clips the subject out of the back.
    expect(CAL.cameraDistance).toBeGreaterThan(UNCAL.cameraDistance * 2);
  });
});

describe('calibrated parallax is 1:1 with the physical screen', () => {
  const CAL = geometryFor(CANVAS_RECT);

  it('shifts the background by exactly (metres moved) / (screen half-width)', () => {
    // The defining requirement, from the top of screenGeometry.ts:
    //   ndc_shift = head displacement in metres / screen half-width in metres
    // The expected value is computed straight from that, with no reference to
    // the angular scale or the world-unit geometry it came through.
    for (const dxMetres of [0.01, 0.05, -0.08, 0.12]) {
      const eye = mapHeadPoseToEye({
        // The hook publishes lateral offset in units of the calibrated
        // distance, so this is what `dxMetres` of real movement looks like.
        pose: { x: dxMetres / CAL_DISTANCE_M, y: 0, z: 1 },
        windowDistance: CAL.windowDistance,
        sensitivity: 1,
        blend: 1,
      });
      expect(eye.x / CAL.halfWidth).toBeCloseTo(dxMetres / CANVAS_RECT.halfWidthM, 12);
    }
    // 0.05 / 0.1867895323 = 0.2676809529, for a canvas 37.36 cm wide.
    expect(CANVAS_RECT.halfWidthM).toBeCloseTo(0.1867895323, 9);
  });

  it('does the same vertically, against the screen half-height', () => {
    const dyMetres = 0.07;
    const eye = mapHeadPoseToEye({
      pose: { x: 0, y: dyMetres / CAL_DISTANCE_M, z: 1 },
      windowDistance: CAL.windowDistance,
      sensitivity: 1,
      blend: 1,
    });
    expect(eye.y / CAL.halfHeight).toBeCloseTo(dyMetres / CANVAS_RECT.halfHeightM, 12);
  });

  it('delivers that shift through the real projection, not just the ratio', () => {
    // Everything above is algebra on the inputs. This runs it through
    // `makeOffAxisProjection` and `Vector3.project` and measures what actually
    // lands on screen.
    //
    // A point `D` behind the glass with the eye `ez` in front of it shifts by
    // `(ex / halfWidth) * D / (D + ez)` — the pinhole term, which tends to the
    // full `ex / halfWidth` only for a background at infinity. Both the finite
    // and the limiting case are asserted so the 1:1 claim is not quietly being
    // read off a point that happens to be in the target plane.
    const dxMetres = 0.05;
    const eye = mapHeadPoseToEye({
      pose: { x: dxMetres / CAL_DISTANCE_M, y: 0, z: 1 },
      windowDistance: CAL.windowDistance,
      sensitivity: 1,
      blend: 1,
    });
    const centred = neutralEye(CAL);
    const oneToOne = dxMetres / CANVAS_RECT.halfWidthM;

    for (const depthBehindGlass of [2, 20, 500]) {
      const world = new THREE.Vector3(0, 0, CAL.glassToTarget - depthBehindGlass);
      const before = projectWorldPoint(CAL, centred, world);
      const after = projectWorldPoint(CAL, eye, world);
      const predicted =
        (oneToOne * depthBehindGlass) / (depthBehindGlass + CAL.windowDistance);
      expect(after.x - before.x).toBeCloseTo(predicted, 9);
    }

    // The background: 1e7 units behind the glass is 2 million times the eye
    // distance, so the pinhole term is 1 to within 5e-7.
    const sky = new THREE.Vector3(0, 0, CAL.glassToTarget - 1e7);
    const shift =
      projectWorldPoint(CAL, eye, sky).x - projectWorldPoint(CAL, centred, sky).x;
    expect(shift).toBeCloseTo(oneToOne, 5);
  });

  it('is the same 1:1 whatever the sensitivity slider means, at gain 1', () => {
    // `sensitivity: 1` is not a tuning value once the screen is measured — it
    // is the physically correct answer, and 2 is exactly twice as much.
    const pose = { x: 0.06 / CAL_DISTANCE_M, y: 0, z: 1 };
    const one = mapHeadPoseToEye({
      pose,
      windowDistance: CAL.windowDistance,
      sensitivity: 1,
      blend: 1,
    });
    const two = mapHeadPoseToEye({
      pose,
      windowDistance: CAL.windowDistance,
      sensitivity: 2,
      blend: 1,
    });
    expect(one.x / CAL.halfWidth).toBeCloseTo(0.06 / CANVAS_RECT.halfWidthM, 12);
    expect(two.x / CAL.halfWidth).toBeCloseTo((2 * 0.06) / CANVAS_RECT.halfWidthM, 12);
  });

  it('finally distinguishes a 27-inch monitor from a 13-inch laptop', () => {
    // The bug the module opens by describing. Both panels are 16:9 and both
    // canvases are full-screen, so the VIEWPORT is identical and the
    // uncalibrated projection cannot tell them apart at all. The calibrated one
    // separates them by exactly the ratio of the diagonals, 27/13 = 2.0769 —
    // "physically wrong by a factor of two", stated as a number.
    const fullScreen = (diagonalInches: number, cssWidth: number, cssHeight: number) =>
      measureCanvasRectMetres({
        diagonalInches,
        screen: { cssWidth, cssHeight },
        cssWidth,
        cssHeight,
      })!;
    const big = fullScreen(27, 2560, 1440);
    const small = fullScreen(13, 1920, 1080);
    expect(big.halfWidthM / small.halfWidthM).toBeCloseTo(27 / 13, 12);

    const dxMetres = 0.05;
    const pose = { x: dxMetres / CAL_DISTANCE_M, y: 0, z: 1 };
    const shiftOn = (rect: { halfHeightM: number } | null) => {
      const g = computeWindowGeometry({
        subjectDistance: SUBJECT_DISTANCE,
        depthFraction: DEPTH_FRACTION,
        fovDeg: FOV_DEG,
        aspect: 16 / 9,
        screenRect: rect,
        calibrationDistanceM: CAL_DISTANCE_M,
      });
      const eye = mapHeadPoseToEye({
        pose,
        windowDistance: g.windowDistance,
        sensitivity: 1,
        blend: 1,
      });
      return eye.x / g.halfWidth;
    };

    // Uncalibrated: byte-identical for the two displays. That IS the bug.
    expect(shiftOn(null)).toBeCloseTo(0.0972810599, 9);

    // Calibrated: each display gets its own answer, and each is 1:1 with its
    // own glass. 0.05 / 0.2988632517 and 0.05 / 0.1438971212.
    expect(shiftOn(big)).toBeCloseTo(0.1673005956, 9);
    expect(shiftOn(small)).toBeCloseTo(0.3474704677, 9);
    expect(shiftOn(small) / shiftOn(big)).toBeCloseTo(27 / 13, 9);
  });
});

describe('computeWindowGeometry survives a viewport that has no size yet', () => {
  /**
   * `SplatViewer`'s `handleResize` runs once unconditionally on mount, before
   * layout is guaranteed to have given the container a height, and computes
   * `camera.aspect = clientWidth / clientHeight` — `0 / 0`, i.e. NaN — and on
   * the intrinsics path `camera.fov = 2 * atan(clientHeight / …)`, i.e. 0. Both
   * reach this function. A NaN in `projectionMatrix` neither throws nor warns,
   * it just renders nothing, and `[data-splat-status="ready"]` would report that
   * blank frame as a healthy one.
   */
  const finiteGeometry = (input: Partial<Parameters<typeof computeWindowGeometry>[0]>) =>
    computeWindowGeometry({
      subjectDistance: SUBJECT_DISTANCE,
      depthFraction: DEPTH_FRACTION,
      fovDeg: FOV_DEG,
      aspect: VIEW_ASPECT,
      screenRect: null,
      calibrationDistanceM: CAL_DISTANCE_M,
      ...input,
    });

  const expectRenderable = (g: WindowGeometry) => {
    // Reported as a list of `name=value` strings rather than a bare boolean so
    // a failure names the field that went non-finite instead of saying
    // "expected true, got false" six times.
    const nonFinite = Object.entries(g)
      .filter(([, value]) => typeof value === 'number' && !Number.isFinite(value))
      .map(([name, value]) => `${name}=${value}`);
    expect(nonFinite).toEqual([]);
    expect(g.halfWidth).toBeGreaterThan(0);
    expect(g.halfHeight).toBeGreaterThan(0);
    expect(g.windowDistance).toBeGreaterThan(0);

    const projection = makeOffAxisProjection(
      computeOffAxisFrustum({
        halfWidth: g.halfWidth,
        halfHeight: g.halfHeight,
        eye: neutralEye(g),
        near: 0.01,
        far: 1000,
      }),
    );
    for (const element of projection.elements) expect(Number.isFinite(element)).toBe(true);
  };

  it('absorbs a NaN or infinite aspect from a zero-height container', () => {
    expectRenderable(finiteGeometry({ aspect: 0 / 0 }));
    expectRenderable(finiteGeometry({ aspect: 1600 / 0 }));
    expectRenderable(finiteGeometry({ aspect: 0 }));
    expectRenderable(finiteGeometry({ aspect: -1.77 }));
  });

  it('absorbs a zero or non-finite field of view', () => {
    // fov 0 is not a NaN problem — it collapses the glass to a point, which
    // makes `right - left` zero and `2n / (right - left)` an Infinity.
    for (const fovDeg of [0, NaN, Infinity, -50, 180, 1e9]) {
      expectRenderable(finiteGeometry({ fovDeg }));
    }
  });

  it('absorbs a non-finite subject distance or depth fraction', () => {
    for (const subjectDistance of [NaN, Infinity, -Infinity, 0, -3.2]) {
      expectRenderable(finiteGeometry({ subjectDistance }));
    }
    for (const depthFraction of [NaN, Infinity, 0, 1, -0.5]) {
      expectRenderable(finiteGeometry({ depthFraction }));
    }
  });

  it('keeps the framing invariant intact while it is falling back', () => {
    // The subtle half of the fix: the dolly `A` and the glass half-height must
    // be derived from the SAME field of view. `computeAngularScale` returns 1
    // for a NaN fov, so if the glass were built from a fallback fov while A
    // came from the raw one, calibrated and uncalibrated would stop framing the
    // target plane identically — the exact property the design is pinned on,
    // broken only in the frames nobody is looking closely at.
    const cal = finiteGeometry({ fovDeg: NaN, screenRect: CANVAS_RECT });
    const uncal = finiteGeometry({ fovDeg: NaN, screenRect: null });
    expect(cal.angularScale).not.toBe(1);

    const p = new THREE.Vector3(0.7, -0.4, 0);
    const a = projectWorldPoint(cal, neutralEye(cal), p);
    const b = projectWorldPoint(uncal, neutralEye(uncal), p);
    expect(a.x).toBeCloseTo(b.x, 12);
    expect(a.y).toBeCloseTo(b.y, 12);
  });

  it('changes nothing for inputs that were already sane', () => {
    // The guard must be invisible in every real frame.
    const g = finiteGeometry({});
    expect(g.halfHeight).toBeCloseTo(
      Math.tan(THREE.MathUtils.degToRad(FOV_DEG) / 2) * DEPTH_FRACTION * SUBJECT_DISTANCE,
      12,
    );
    expect(g.halfWidth).toBeCloseTo(g.halfHeight * VIEW_ASPECT, 12);
    expect(g.windowDistance).toBeCloseTo(DEPTH_FRACTION * SUBJECT_DISTANCE, 12);
  });
});
