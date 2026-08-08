import * as THREE from 'three';
import {
  ArPlacement,
  MAX_SURFACE_DISTANCE_M,
  MAX_WORLD_SIZE_M,
  MIN_PINCH_SPAN_PX,
  MIN_WORLD_SIZE_M,
  PointerView,
  applyPlacement,
  assetFrameFromBounds,
  beginDrag,
  beginTwoFinger,
  composePlacementMatrix,
  computeArrivalScale,
  matrixFromHitPose,
  placementFromHitPose,
  planeFromHitPose,
  surfacePointUnderPointer,
  updateDrag,
  updateTwoFinger,
  wrapAngle,
  yawTowardViewer,
} from './arPlacement';

/**
 * There is no device in CI, so every assertion here is either a closed-form
 * number derived in the comment above it or a round trip through THREE's own
 * maths. Nothing is compared against the formula under test.
 *
 * Two conventions are load-bearing and are re-derived in the tests that depend
 * on them, because getting either backwards produces a result that still looks
 * like a plausible AR app until you try to use it:
 *
 *   • pointer y grows DOWNWARD, NDC y grows UPWARD;
 *   • yaw about +Y is counter-clockwise seen from above, screen twist is
 *     clockwise-positive, so they carry opposite signs.
 */

/** A column-major WebXR-style pose array from a position and a rotation. */
const poseMatrix = (position: THREE.Vector3, quaternion = new THREE.Quaternion()): number[] =>
  new THREE.Matrix4().compose(position, quaternion, new THREE.Vector3(1, 1, 1)).toArray();

const placementAt = (x: number, y: number, z: number, yaw = 0, scale = 1): ArPlacement => ({
  position: new THREE.Vector3(x, y, z),
  yaw,
  scale,
});

describe('wrapAngle', () => {
  it('leaves an in-range angle bit-identical', () => {
    // Not pedantry: a memory that is placed and never twisted must keep exactly
    // the yaw the hit test implied, or a `toBe` somewhere downstream starts
    // failing by one ulp for no reason anyone can find.
    for (const a of [0, 0.1, -0.1, 1.2345678901234, Math.PI, -Math.PI + 1e-12]) {
      expect(wrapAngle(a)).toBe(a);
    }
  });

  it('folds anything else into (-PI, PI]', () => {
    expect(wrapAngle(Math.PI * 1.5)).toBeCloseTo(-Math.PI / 2, 12);
    expect(wrapAngle(-Math.PI * 1.5)).toBeCloseTo(Math.PI / 2, 12);
    expect(wrapAngle(Math.PI * 2)).toBeCloseTo(0, 12);
    expect(wrapAngle(Math.PI * 7)).toBeCloseTo(Math.PI, 12);
    // The one value the modulo puts on the wrong end of the half-open range.
    expect(wrapAngle(-Math.PI)).toBe(Math.PI);
  });

  it('turns a non-finite angle into zero rather than into a NaN matrix', () => {
    expect(wrapAngle(NaN)).toBe(0);
    expect(wrapAngle(Infinity)).toBe(0);
  });
});

describe('matrixFromHitPose', () => {
  it('reads the column-major XR layout without transposing it', () => {
    // `Matrix4.set` takes ROW-major arguments. Using it here instead of
    // `fromArray` would move the translation into the bottom row, where it
    // reads as a projective term and the asset lands somewhere unrelated.
    const position = new THREE.Vector3(0.3, -1.1, 2.7);
    const m = matrixFromHitPose(poseMatrix(position));
    expect(m).not.toBeNull();
    const out = new THREE.Vector3().setFromMatrixPosition(m as THREE.Matrix4);
    expect(out.x).toBeCloseTo(0.3, 12);
    expect(out.y).toBeCloseTo(-1.1, 12);
    expect(out.z).toBeCloseTo(2.7, 12);
  });

  it('rejects a pose that is not sixteen finite numbers', () => {
    // A hit test read in the same frame tracking drops can contain NaNs, and a
    // NaN in an object matrix removes the object from the render silently.
    const bad = poseMatrix(new THREE.Vector3(1, 2, 3));
    bad[5] = NaN;
    expect(matrixFromHitPose(bad)).toBeNull();
    expect(matrixFromHitPose([1, 2, 3])).toBeNull();
    expect(matrixFromHitPose(new Float32Array(16).fill(Infinity))).toBeNull();
  });
});

describe('placementFromHitPose', () => {
  it('stands the asset exactly where the ray met the surface', () => {
    const hit = new THREE.Vector3(0.42, -0.9, -1.75);
    const placement = placementFromHitPose({
      hit: poseMatrix(hit),
      viewer: new THREE.Vector3(0, 0.2, 0),
      scale: 0.01,
    });
    expect(placement).not.toBeNull();
    expect((placement as ArPlacement).position.x).toBeCloseTo(0.42, 12);
    expect((placement as ArPlacement).position.y).toBeCloseTo(-0.9, 12);
    expect((placement as ArPlacement).position.z).toBeCloseTo(-1.75, 12);
    expect((placement as ArPlacement).scale).toBe(0.01);
  });

  it('turns the asset front (+Z) toward the viewer, and only about +Y', () => {
    // The asset's front is +Z: plywriter puts the postcard in the z = 0 plane
    // facing the camera that photographed it.
    const hit = new THREE.Vector3(0, 0, 0);
    const viewers: Array<[THREE.Vector3, THREE.Vector3]> = [
      [new THREE.Vector3(0, 1.5, 3), new THREE.Vector3(0, 0, 1)],
      [new THREE.Vector3(3, 1.5, 0), new THREE.Vector3(1, 0, 0)],
      [new THREE.Vector3(-3, 1.5, 0), new THREE.Vector3(-1, 0, 0)],
      [new THREE.Vector3(0, 1.5, -3), new THREE.Vector3(0, 0, -1)],
      [new THREE.Vector3(2, 1.5, 2), new THREE.Vector3(Math.SQRT1_2, 0, Math.SQRT1_2)],
    ];
    for (const [viewer, expectedFront] of viewers) {
      const placement = placementFromHitPose({ hit: poseMatrix(hit), viewer, scale: 1 });
      const q = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0),
        (placement as ArPlacement).yaw,
      );
      const front = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
      expect(front.x).toBeCloseTo(expectedFront.x, 12);
      expect(front.y).toBeCloseTo(0, 12);
      expect(front.z).toBeCloseTo(expectedFront.z, 12);

      // Upright: the asset's own up survives the rotation untouched. The viewer
      // is 1.5 m above the anchor in every case, so a full look-at would tip it.
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
      expect(up.y).toBeCloseTo(1, 12);
    }
  });

  it('discards the hit pose orientation, so a wall hit does not lie down', () => {
    // WebXR only promises that a hit pose's +Y is the surface normal. On a wall
    // that tips the pose ninety degrees; inheriting it would paste the memory
    // flat onto the wall like wallpaper seen edge-on.
    const wall = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
    const placement = placementFromHitPose({
      hit: poseMatrix(new THREE.Vector3(0, 1, -2), wall),
      viewer: new THREE.Vector3(0, 1.5, 0),
      scale: 1,
    }) as ArPlacement;

    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), placement.yaw);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    expect(up.x).toBeCloseTo(0, 12);
    expect(up.y).toBeCloseTo(1, 12);
    expect(up.z).toBeCloseTo(0, 12);

    // Still turned to face the viewer, who is two metres in front of the wall.
    const front = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    expect(front.z).toBeCloseTo(1, 12);
  });

  it('keeps the fallback yaw when the viewer is directly overhead', () => {
    // atan2 of two numbers that are both pose jitter is a random walk, and the
    // memory would spin while the user held still.
    const placement = placementFromHitPose({
      hit: poseMatrix(new THREE.Vector3(0, 0, 0)),
      viewer: new THREE.Vector3(0.004, 1.4, -0.002),
      scale: 1,
      fallbackYaw: 1.25,
    }) as ArPlacement;
    expect(placement.yaw).toBe(1.25);
  });

  it('refuses an unusable pose or scale instead of emitting a NaN transform', () => {
    expect(placementFromHitPose({ hit: [1, 2, 3], viewer: new THREE.Vector3(), scale: 1 })).toBeNull();
    expect(
      placementFromHitPose({
        hit: poseMatrix(new THREE.Vector3()),
        viewer: new THREE.Vector3(NaN, 0, 0),
        scale: 1,
      }),
    ).toBeNull();
    expect(
      placementFromHitPose({ hit: poseMatrix(new THREE.Vector3()), viewer: new THREE.Vector3(), scale: 0 }),
    ).toBeNull();
  });

  it('yawTowardViewer works on plain objects, not just Vector3', () => {
    expect(yawTowardViewer({ x: 0, y: 0, z: 0 }, { x: 5, y: 9, z: 0 })).toBeCloseTo(Math.PI / 2, 12);
  });
});

describe('planeFromHitPose', () => {
  it('takes the surface normal from the pose +Y axis', () => {
    const wall = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
    // +Y rotated 90 degrees about +X becomes -Z... check against THREE rather
    // than against intuition.
    const expected = new THREE.Vector3(0, 1, 0).applyQuaternion(wall);
    const plane = planeFromHitPose(poseMatrix(new THREE.Vector3(0, 1, -2), wall));
    expect(plane).not.toBeNull();
    expect((plane as THREE.Plane).normal.dot(expected)).toBeCloseTo(1, 12);
    // The hit point is on the plane, by construction.
    expect((plane as THREE.Plane).distanceToPoint(new THREE.Vector3(0, 1, -2))).toBeCloseTo(0, 12);
  });
});

describe('computeArrivalScale', () => {
  it('cancels the asset units: a hundred-unit photo plane arrives one metre wide', () => {
    // The failure this exists to prevent. Scale 1 would put a 100 m photograph
    // in the room, with the user standing inside it.
    const { scale, extent } = computeArrivalScale({ size: { x: 100, y: 56.25, z: 0 } });
    expect(extent).toBe(100);
    expect(scale).toBeCloseTo(0.01, 12);
    expect(100 * scale).toBeCloseTo(1, 12);
  });

  it('gives the same physical size whatever units the reconstruction used', () => {
    // Same 16:9 photo emitted by three engines at wildly different scales.
    const sizes = [
      { x: 3.5555, y: 2, z: 0 },
      { x: 1600, y: 900, z: 0 },
      { x: 0.0032, y: 0.0018, z: 0 },
    ];
    for (const size of sizes) {
      const { scale } = computeArrivalScale({ size });
      expect(Math.max(size.x, size.y, size.z) * scale).toBeCloseTo(1, 9);
    }
  });

  it('honours an explicit target and normalises by the LARGEST extent', () => {
    // A portrait photo is a metre TALL, a landscape one a metre WIDE. The
    // guarantee is "no dimension exceeds the target", which is what keeps the
    // two feeling like the same kind of object.
    const portrait = computeArrivalScale({ size: { x: 2, y: 3, z: 0.4 }, targetSizeM: 1.5 });
    expect(3 * portrait.scale).toBeCloseTo(1.5, 12);
    expect(2 * portrait.scale).toBeCloseTo(1, 12);
  });

  it('publishes gesture limits that mean a physical size', () => {
    const { limits, extent } = computeArrivalScale({ size: { x: 4, y: 2, z: 2 } });
    expect(extent).toBe(4);
    expect(extent * limits.min).toBeCloseTo(MIN_WORLD_SIZE_M, 12);
    expect(extent * limits.max).toBeCloseTo(MAX_WORLD_SIZE_M, 12);
  });

  it('degrades to an identity scale on an unmeasurable box', () => {
    // A box that is a point, or NaN, must not produce Infinity — that would
    // un-draw the asset with no error to find.
    for (const size of [
      { x: 0, y: 0, z: 0 },
      { x: NaN, y: NaN, z: NaN },
      { x: Infinity, y: 1, z: 1 },
    ]) {
      const { scale } = computeArrivalScale({ size });
      expect(Number.isFinite(scale)).toBe(true);
      expect(scale).toBeGreaterThan(0);
    }
    expect(computeArrivalScale({ size: { x: 0, y: 0, z: 0 } }).scale).toBe(1);
  });
});

describe('composePlacementMatrix', () => {
  /** A 100-unit-wide photo plane whose origin is nowhere near its centre. */
  const bounds = new THREE.Box3(
    new THREE.Vector3(-20, 5, -1),
    new THREE.Vector3(80, 61.25, 1),
  );

  it('lands the bounding box bottom centre exactly on the tapped point', () => {
    // The asset origin is 30 units right of centre and 5 units above its own
    // base; without the anchor term the memory floats, and lands a couple of
    // metres from where the user aimed.
    const frame = assetFrameFromBounds(bounds);
    if (!frame) throw new Error('a non-empty box must produce a frame');
    const placement = placementAt(1.5, -0.25, -2, 0.7, 0.01);
    const m = composePlacementMatrix(placement, frame);

    const landed = frame.anchor.clone().applyMatrix4(m);
    expect(landed.x).toBeCloseTo(1.5, 12);
    expect(landed.y).toBeCloseTo(-0.25, 12);
    expect(landed.z).toBeCloseTo(-2, 12);
  });

  it('produces an asset whose largest world dimension is the arrival target', () => {
    const size = new THREE.Vector3();
    bounds.getSize(size);
    const { scale } = computeArrivalScale({ size, targetSizeM: 1.2 });
    const m = composePlacementMatrix(placementAt(0, 0, 0, 0.3, scale), assetFrameFromBounds(bounds));
    const world = bounds.clone().applyMatrix4(m);
    const worldSize = new THREE.Vector3();
    world.getSize(worldSize);
    // Yaw is about +Y, so the height is exact and the footprint is the rotated
    // box's AABB — only the vertical extent is a clean comparison here.
    expect(worldSize.y).toBeCloseTo(size.y * scale, 9);
    expect(Math.max(size.x, size.y, size.z) * scale).toBeCloseTo(1.2, 12);
  });

  it('is a pure TRS, so applyPlacement and the matrix agree exactly', () => {
    // The composition is T(p).R.S.T(-a) but the scale is uniform, so it
    // collapses to a plain position/quaternion/scale. If it did not, an
    // Object3D could not hold it without matrixAutoUpdate = false.
    const frame = assetFrameFromBounds(bounds);
    const placement = placementAt(-0.4, 1.1, 0.9, -2.3, 0.02);
    const object = new THREE.Object3D();
    applyPlacement(object, placement, frame);
    const expected = composePlacementMatrix(placement, frame);
    object.matrix.elements.forEach((v, i) => expect(v).toBeCloseTo(expected.elements[i], 12));
  });

  it('falls back to the placement position when no asset frame is supplied', () => {
    const m = composePlacementMatrix(placementAt(2, 3, 4, 1, 5));
    const p = new THREE.Vector3().setFromMatrixPosition(m);
    expect(p.x).toBeCloseTo(2, 12);
    expect(p.y).toBeCloseTo(3, 12);
    expect(p.z).toBeCloseTo(4, 12);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
   Drag.

   The top-down rig below gives a closed form for metres per pixel. Camera at
   height h looking straight down at the y = 0 plane with screen-up along world
   -Z: the visible half-height on the ground is tan(fov/2) * h across H/2
   pixels, so

       k = 2 * tan(fov/2) * h / H     metres per pixel

   and the same value horizontally, because the aspect that widens the frustum
   is exactly the aspect that widens the viewport. Screen right is world +X and
   screen DOWN is world +Z (screen up is -Z), so a pointer delta (dx, dy) maps
   to a ground delta (k*dx, 0, k*dy).
   ──────────────────────────────────────────────────────────────────────────── */

const VIEWPORT = { width: 800, height: 600 };
const FOV = 60;
const HEIGHT = 2;

const topDownView = (): PointerView => {
  const camera = new THREE.PerspectiveCamera(FOV, VIEWPORT.width / VIEWPORT.height, 0.01, 500);
  camera.position.set(0, HEIGHT, 0);
  camera.up.set(0, 0, -1);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  return { camera, viewport: VIEWPORT };
};

/** Looking at the origin from behind and above, the way a phone actually is. */
const obliqueView = (): PointerView => {
  const camera = new THREE.PerspectiveCamera(FOV, VIEWPORT.width / VIEWPORT.height, 0.01, 500);
  camera.position.set(0, 1.6, 3);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  return { camera, viewport: VIEWPORT };
};

const METRES_PER_PIXEL = (2 * Math.tan((FOV * Math.PI) / 360) * HEIGHT) / VIEWPORT.height;

describe('surfacePointUnderPointer', () => {
  it('maps the viewport centre onto the point the camera is aimed at', () => {
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const hit = surfacePointUnderPointer({ x: 400, y: 300 }, topDownView(), plane);
    expect(hit).not.toBeNull();
    expect((hit as THREE.Vector3).x).toBeCloseTo(0, 9);
    expect((hit as THREE.Vector3).y).toBeCloseTo(0, 9);
    expect((hit as THREE.Vector3).z).toBeCloseTo(0, 9);
  });

  it('flips y exactly once: pointer down is world +Z under a top-down camera', () => {
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const view = topDownView();
    const centre = surfacePointUnderPointer({ x: 400, y: 300 }, view, plane) as THREE.Vector3;
    const lower = surfacePointUnderPointer({ x: 400, y: 400 }, view, plane) as THREE.Vector3;
    const right = surfacePointUnderPointer({ x: 500, y: 300 }, view, plane) as THREE.Vector3;

    expect(lower.z - centre.z).toBeCloseTo(100 * METRES_PER_PIXEL, 9);
    expect(right.x - centre.x).toBeCloseTo(100 * METRES_PER_PIXEL, 9);
  });

  it('returns null above the horizon instead of a point at infinity', () => {
    // The oblique camera is pitched 28.07 degrees down with a 30 degree half
    // FOV, so the top row of the viewport points 1.9 degrees ABOVE horizontal
    // and never meets the ground.
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    expect(surfacePointUnderPointer({ x: 400, y: 0 }, obliqueView(), plane)).toBeNull();
  });

  it('refuses a near-horizon hit rather than flinging the anchor to the horizon', () => {
    // At y = 50 the ray is 2.4 degrees below horizontal, meeting the ground
    // ~38 m out — past the limit. Ray.intersectPlane would happily return it:
    // it only rejects an EXACTLY parallel ray.
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const view = obliqueView();
    expect(surfacePointUnderPointer({ x: 400, y: 50 }, view, plane)).toBeNull();

    const raised = surfacePointUnderPointer({ x: 400, y: 50 }, view, plane, 100) as THREE.Vector3;
    expect(raised).not.toBeNull();
    expect(raised.distanceTo(view.camera.position)).toBeGreaterThan(MAX_SURFACE_DISTANCE_M);
  });

  it('is not a linear pixels-to-metres mapping', () => {
    // The cheap version of this gesture. One hundred pixels near the bottom of
    // an obliquely viewed floor is a fraction of what the same hundred pixels
    // is halfway up the screen, and the ratio here is over 3x — which is how
    // far the memory would slide out from under the finger.
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const view = obliqueView();
    const at = (y: number) => surfacePointUnderPointer({ x: 400, y }, view, plane) as THREE.Vector3;
    const near = at(560).distanceTo(at(460));
    const far = at(300).distanceTo(at(200));
    expect(far / near).toBeGreaterThan(3);
  });

  it('rejects a degenerate viewport instead of dividing by zero', () => {
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const view = topDownView();
    expect(
      surfacePointUnderPointer({ x: 1, y: 1 }, { camera: view.camera, viewport: { width: 0, height: 0 } }, plane),
    ).toBeNull();
  });
});

describe('drag', () => {
  it('moves the anchor by the surface delta the screen delta corresponds to', () => {
    const view = topDownView();
    const start = placementAt(0, 0, 0, 0.5, 0.01);
    // Grab exactly over the anchor so the offset is zero and the delta is the
    // whole story.
    const gesture = beginDrag(start, { x: 400, y: 300 }, view);
    expect(gesture.grabOffset.length()).toBeCloseTo(0, 9);

    const moved = updateDrag(gesture, { x: 460, y: 220 }, view);
    expect(moved.position.x).toBeCloseTo(60 * METRES_PER_PIXEL, 9);
    expect(moved.position.z).toBeCloseTo(-80 * METRES_PER_PIXEL, 9);
    expect(moved.position.y).toBeCloseTo(0, 9);
  });

  it('keeps the grab offset, so the memory does not jump to the finger', () => {
    // The finger lands on the visible body of the memory, which stands above
    // the anchor and so appears well up the screen from it. Without the offset
    // the first move teleports the anchor by most of the asset's height.
    const view = topDownView();
    const start = placementAt(0, 0, 0, 0, 1);
    const grabPoint = { x: 520, y: 240 };
    const gesture = beginDrag(start, grabPoint, view);

    // Offset is anchor minus the surface point under the finger.
    expect(gesture.grabOffset.x).toBeCloseTo(-120 * METRES_PER_PIXEL, 9);
    expect(gesture.grabOffset.z).toBeCloseTo(60 * METRES_PER_PIXEL, 9);

    // Re-issuing the same pointer must be a no-op, whatever the offset was.
    const still = updateDrag(gesture, grabPoint, view);
    expect(still.position.x).toBeCloseTo(0, 9);
    expect(still.position.z).toBeCloseTo(0, 9);

    const moved = updateDrag(gesture, { x: 620, y: 240 }, view);
    expect(moved.position.x).toBeCloseTo(100 * METRES_PER_PIXEL, 9);
    expect(moved.position.z).toBeCloseTo(0, 9);
  });

  it('stays on the surface plane the placement was standing on', () => {
    const view = topDownView();
    // A table 0.75 m off the floor: the drag must stay on the table top.
    const start = placementAt(0.2, 0.75, -0.3, 0, 1);
    const gesture = beginDrag(start, { x: 400, y: 300 }, view);
    const moved = updateDrag(gesture, { x: 300, y: 500 }, view);
    expect(moved.position.y).toBeCloseTo(0.75, 9);
  });

  it('carries yaw and scale through untouched', () => {
    const view = topDownView();
    const start = placementAt(0, 0, 0, -1.234, 0.017);
    const moved = updateDrag(beginDrag(start, { x: 400, y: 300 }, view), { x: 410, y: 310 }, view);
    expect(moved.yaw).toBe(-1.234);
    expect(moved.scale).toBe(0.017);
  });

  it('returns the pre-drag placement unchanged when the ray misses the surface', () => {
    // Dragging up past the horizon must park the memory, not launch it.
    const view = obliqueView();
    const start = placementAt(0, 0, 0, 0.25, 0.5);
    const gesture = beginDrag(start, { x: 400, y: 300 }, view);
    const missed = updateDrag(gesture, { x: 400, y: 0 }, view);
    expect(missed).toBe(start);
    expect(Number.isFinite(missed.position.x)).toBe(true);
  });

  it('returns to the exact starting point when the finger comes back', () => {
    // The reason the gesture holds a fixed reference instead of integrating
    // per-event deltas. An accumulating drag leaves a residue after a there and
    // back trip that the user can grow without limit by wiggling.
    const view = obliqueView();
    const start = placementAt(0, 0, 0, 0.2, 0.03);
    const gesture = beginDrag(start, { x: 400, y: 420 }, view);
    let last = start;
    for (const p of [
      { x: 410, y: 415 },
      { x: 480, y: 380 },
      { x: 520, y: 340 },
      { x: 470, y: 390 },
      { x: 400, y: 420 },
    ]) {
      last = updateDrag(gesture, p, view);
    }
    expect(last.position.x).toBeCloseTo(start.position.x, 12);
    expect(last.position.y).toBeCloseTo(start.position.y, 12);
    expect(last.position.z).toBeCloseTo(start.position.z, 12);
  });

  it('never writes to the placement it was given', () => {
    const view = topDownView();
    const start = placementAt(0, 0, 0, 0, 1);
    const before = start.position.clone();
    updateDrag(beginDrag(start, { x: 400, y: 300 }, view), { x: 700, y: 100 }, view);
    expect(start.position.equals(before)).toBe(true);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
   Pinch and twist.

   Pointer pairs are generated by placing two fingers `span` pixels apart at a
   screen angle `theta`, measured with y DOWNWARD so it increases clockwise.
   ──────────────────────────────────────────────────────────────────────────── */

const fingers = (span: number, theta: number, cx = 400, cy = 300): [{ x: number; y: number }, { x: number; y: number }] => [
  { x: cx - (Math.cos(theta) * span) / 2, y: cy - (Math.sin(theta) * span) / 2 },
  { x: cx + (Math.cos(theta) * span) / 2, y: cy + (Math.sin(theta) * span) / 2 },
];

describe('pinch', () => {
  const START = placementAt(0.5, 0, -1, 0.4, 0.02);
  const LIMITS = { min: 0.002, max: 0.4 };

  it('scales by exactly the ratio the fingers moved apart', () => {
    const [a, b] = fingers(200, 0);
    const gesture = beginTwoFinger(START, a, b);
    for (const factor of [0.5, 1, 1.5, 2, 4]) {
      const [c, d] = fingers(200 * factor, 0);
      const next = updateTwoFinger(gesture, c, d, LIMITS);
      expect(next.scale).toBeCloseTo(START.scale * factor, 12);
    }
  });

  it('is a ratio against the gesture start, not an accumulation', () => {
    // Pinch out and back must return the object to the size it started at, to
    // the last digit. Integrating per-event deltas leaves a drift the user can
    // reproduce on demand.
    const [a, b] = fingers(150, 0.3);
    const gesture = beginTwoFinger(START, a, b);
    let last = START;
    for (const span of [160, 190, 240, 300, 240, 190, 160, 150]) {
      const [c, d] = fingers(span, 0.3);
      last = updateTwoFinger(gesture, c, d, LIMITS);
    }
    expect(last.scale).toBe(START.scale);
  });

  it('clamps at both limits', () => {
    // START.scale is 0.02 against limits [0.002, 0.4], so the clamps bite at
    // ratios of 0.1 and 20. Starting from a 1000 px span leaves room to reach
    // the lower one without the fingers getting closer than MIN_PINCH_SPAN_PX,
    // where the ratio is discarded rather than clamped.
    const gesture = beginTwoFinger(START, ...fingers(1000, 0));

    const huge = updateTwoFinger(gesture, ...fingers(1000 * 500, 0), LIMITS);
    expect(huge.scale).toBe(LIMITS.max);

    const small = updateTwoFinger(gesture, ...fingers(MIN_PINCH_SPAN_PX + 1, 0), LIMITS);
    expect(small.scale).toBe(LIMITS.min);

    // Fingers on top of each other: not a pinch, so nothing changes.
    const tiny = updateTwoFinger(gesture, ...fingers(2, 0), LIMITS);
    expect(tiny.scale).toBe(START.scale);
  });

  it('locks scale when the fingers are too close together to measure', () => {
    // A pinch that begins with the touches a few pixels apart is a digitizer
    // artefact, and dividing by that span turns a one-pixel tremor into a
    // doubling.
    const gesture = beginTwoFinger(START, ...fingers(MIN_PINCH_SPAN_PX - 1, 0));
    expect(gesture.usable).toBe(false);
    const next = updateTwoFinger(gesture, ...fingers(400, 1.1), LIMITS);
    expect(next.scale).toBe(START.scale);
    expect(next.yaw).toBe(START.yaw);
  });

  it('leaves the scale unclamped when no limits are supplied', () => {
    const gesture = beginTwoFinger(START, ...fingers(100, 0));
    expect(updateTwoFinger(gesture, ...fingers(100000, 0)).scale).toBeCloseTo(START.scale * 1000, 9);
  });
});

describe('twist', () => {
  const START = placementAt(0, 0, 0, 0, 1);

  it('rotates the memory clockwise from above when the fingers turn clockwise', () => {
    // Screen angle increases clockwise (y is down); yaw about +Y increases
    // counter-clockwise seen from above. So a clockwise twist DECREASES yaw,
    // and the memory turns clockwise in the plan view — the same sense as the
    // fingers, which is the whole point.
    const gesture = beginTwoFinger(START, ...fingers(200, 0));
    for (const theta of [0.2, 0.75, 1.5, -0.6, -2.4]) {
      const next = updateTwoFinger(gesture, ...fingers(200, theta));
      expect(next.yaw).toBeCloseTo(wrapAngle(-theta), 12);
      expect(next.scale).toBeCloseTo(START.scale, 12);
    }
  });

  it('turns the memory the same way on screen as the fingers turned', () => {
    /*
      The assertion above states the sign as a number, which only proves the
      code agrees with the comment. This one proves the comment: it puts the
      memory under a top-down camera (screen right = world +X, screen DOWN =
      world +Z), twists the fingers clockwise, and measures the direction the
      memory's front points IN PIXELS, through THREE's own projection.

      At yaw 0 the front (+Z) projects straight down the screen, a pixel angle
      of +PI/2. A clockwise finger twist of theta must take it to PI/2 + theta,
      because pixel angle and finger angle are measured in the same frame with
      the same y-down convention. If the yaw sign were inverted this comes back
      PI/2 - theta and the memory turns against the fingers.
    */
    const view = topDownView();
    const toPixels = (p: THREE.Vector3) => {
      const ndc = p.clone().project(view.camera);
      return { x: ((ndc.x + 1) / 2) * VIEWPORT.width, y: ((1 - ndc.y) / 2) * VIEWPORT.height };
    };
    const frontAngleOnScreen = (placement: ArPlacement) => {
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), placement.yaw);
      const tip = new THREE.Vector3(0, 0, 0.5).applyQuaternion(q).add(placement.position);
      const origin = toPixels(placement.position);
      const end = toPixels(tip);
      return Math.atan2(end.y - origin.y, end.x - origin.x);
    };

    const start = placementAt(0, 0, 0, 0, 1);
    expect(frontAngleOnScreen(start)).toBeCloseTo(Math.PI / 2, 9);

    const gesture = beginTwoFinger(start, ...fingers(200, 0));
    for (const theta of [0.3, 0.9, -0.4]) {
      const twisted = updateTwoFinger(gesture, ...fingers(200, theta));
      expect(frontAngleOnScreen(twisted)).toBeCloseTo(Math.PI / 2 + theta, 9);
    }
  });

  it('adds to the yaw the memory already had', () => {
    const start = placementAt(0, 0, 0, 1.1, 1);
    const gesture = beginTwoFinger(start, ...fingers(200, 0.4));
    const next = updateTwoFinger(gesture, ...fingers(200, 0.9));
    expect(next.yaw).toBeCloseTo(1.1 - 0.5, 12);
  });

  it('always reports a yaw inside (-PI, PI]', () => {
    const start = placementAt(0, 0, 0, 3, 1);
    const gesture = beginTwoFinger(start, ...fingers(200, 0));
    for (const theta of [-3, -1.5, 0, 1.5, 3]) {
      const yaw = updateTwoFinger(gesture, ...fingers(200, theta)).yaw;
      expect(yaw).toBeGreaterThan(-Math.PI);
      expect(yaw).toBeLessThanOrEqual(Math.PI);
    }
  });

  it('survives the atan2 branch cut without flipping the memory round', () => {
    // The finger pair passing through the -PI/+PI seam makes the raw angle
    // difference jump by a full turn. Compare orientations, not numbers: a
    // 2*PI jump in yaw is not a rotation at all.
    const gesture = beginTwoFinger(START, ...fingers(200, Math.PI - 0.05));
    const before = updateTwoFinger(gesture, ...fingers(200, Math.PI - 0.01));
    const after = updateTwoFinger(gesture, ...fingers(200, -Math.PI + 0.03));

    const dir = (p: ArPlacement) =>
      new THREE.Vector3(0, 0, 1).applyQuaternion(
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.yaw),
      );
    // 0.04 radians of finger travel across the seam is 0.04 radians of yaw.
    expect(dir(before).angleTo(dir(after))).toBeCloseTo(0.04, 9);
  });

  it('pinches and twists in the same update', () => {
    const start = placementAt(1, 0, 1, 0, 0.05);
    const gesture = beginTwoFinger(start, ...fingers(120, 0.1));
    const next = updateTwoFinger(gesture, ...fingers(360, 0.6), { min: 0.001, max: 1 });
    expect(next.scale).toBeCloseTo(0.15, 12);
    expect(next.yaw).toBeCloseTo(-0.5, 12);
    // Two fingers never move the anchor: that is what one finger is for.
    expect(next.position.x).toBeCloseTo(1, 12);
    expect(next.position.z).toBeCloseTo(1, 12);
  });

  it('hands back a fresh position vector so undo state cannot be aliased', () => {
    const start = placementAt(1, 2, 3, 0, 1);
    const next = updateTwoFinger(beginTwoFinger(start, ...fingers(200, 0)), ...fingers(400, 0));
    expect(next.position).not.toBe(start.position);
    next.position.set(9, 9, 9);
    expect(start.position.x).toBe(1);
  });
});

/**
 * Spark seeds `getBoundingBox()` with min=+Infinity / max=-Infinity and only
 * narrows it inside `forEachSplat`, so an asset with no splats hands back an
 * EMPTY Box3 — and `Box3.applyMatrix4` returns early on one, so the sentinels
 * survive into the caller. Averaging them gives NaN, which three then writes
 * into the world matrix without complaint: the memory simply vanishes.
 */
describe('assetFrameFromBounds on an empty bounding box', () => {
  it('returns null rather than a NaN anchor', () => {
    expect(assetFrameFromBounds(new THREE.Box3())).toBeNull();
  });

  it('leaves the placement finite when there is no frame to anchor to', () => {
    const empty = new THREE.Box3();
    const m = composePlacementMatrix(placementAt(1.5, -0.25, -2, 0.7, 0.01), assetFrameFromBounds(empty));
    expect(m.elements.every(Number.isFinite)).toBe(true);
  });
});
