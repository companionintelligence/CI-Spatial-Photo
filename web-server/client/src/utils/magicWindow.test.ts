import * as THREE from 'three';
import {
  computeOffAxisFrustum,
  computeOffAxisFrustumFromCorners,
  makeOffAxisProjection,
  mapHeadPoseToEye,
  ScreenSpaceEye,
} from './magicWindow';

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
