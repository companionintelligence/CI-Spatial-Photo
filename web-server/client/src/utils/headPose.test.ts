import {
  DEFAULT_BIOCULAR_WIDTH_M,
  DEFAULT_CAMERA_HFOV_DEG,
  Landmark,
  OUTER_EYE_CORNER_A,
  OUTER_EYE_CORNER_B,
  estimateHeadPose,
} from './headPose';

/**
 * A forward model of the thing being inverted: place a head at a known metric
 * position and orientation, run it through an ideal pinhole camera, and emit
 * MediaPipe-shaped normalized landmarks. `estimateHeadPose` then has to recover
 * what went in.
 *
 * Camera frame: +X to the CAMERA's right, +Y up, +Z away from the camera. The
 * user faces the camera, so the user's right is -X — the sign flip that makes a
 * magic window track the correct way round, and the one thing here that cannot
 * be verified without a real webcam pointed at a real person.
 */
const FACE_LANDMARK_COUNT = 478;

interface SyntheticFace {
  /** Metres from the camera. */
  distance: number;
  /** Metres to the USER's right of the optical axis. */
  xMeters?: number;
  /** Metres above the optical axis. */
  yMeters?: number;
  /** Head turn, radians. Foreshortens the eye span in the image. */
  yaw?: number;
  /** Head tilt, radians. Rotates the eye span in the image plane. */
  roll?: number;
  aspect?: number;
  hFovDeg?: number;
  eyeWidth?: number;
}

const synthesizeFace = ({
  distance,
  xMeters = 0,
  yMeters = 0,
  yaw = 0,
  roll = 0,
  aspect = 4 / 3,
  hFovDeg = DEFAULT_CAMERA_HFOV_DEG,
  eyeWidth = DEFAULT_BIOCULAR_WIDTH_M,
}: SyntheticFace): Landmark[] => {
  const halfTan = Math.tan((hFovDeg * Math.PI) / 360);
  const centre = { x: -xMeters, y: yMeters, z: distance };

  // Unit vector along the inter-eye axis, in camera coordinates.
  const dir = {
    x: Math.cos(yaw) * Math.cos(roll),
    y: Math.sin(roll),
    z: Math.sin(yaw) * Math.cos(roll),
  };

  const project = (p: { x: number; y: number; z: number }): Landmark => ({
    // ndc in [-1, 1] across the frame width; y is normalized by HEIGHT, hence
    // the aspect factor, and grows downwards.
    x: (p.x / p.z / halfTan + 1) / 2,
    y: (1 - (p.y / p.z / (halfTan / aspect))) / 2,
    // MediaPipe: depth relative to the head centre, in roughly x's scale,
    // smaller when closer to the camera.
    z: (p.z - centre.z) / (2 * centre.z * halfTan),
  });

  const landmarks: Landmark[] = new Array(FACE_LANDMARK_COUNT)
    .fill(null)
    .map(() => ({ x: 0.5, y: 0.5, z: 0 }));
  const half = eyeWidth / 2;
  landmarks[OUTER_EYE_CORNER_A] = project({
    x: centre.x - dir.x * half,
    y: centre.y - dir.y * half,
    z: centre.z - dir.z * half,
  });
  landmarks[OUTER_EYE_CORNER_B] = project({
    x: centre.x + dir.x * half,
    y: centre.y + dir.y * half,
    z: centre.z + dir.z * half,
  });
  return landmarks;
};

const ASPECT = 4 / 3;

describe('estimateHeadPose', () => {
  it('recovers the true distance from the eye span, not from a landmark z', () => {
    // The replaced code used `nose.z` as a "distance factor". This is what an
    // actual distance estimate has to do: track the real one over the whole
    // range someone sits at.
    for (const distance of [0.3, 0.45, 0.6, 0.9, 1.4]) {
      const pose = estimateHeadPose(synthesizeFace({ distance }), { aspect: ASPECT });
      expect(pose).not.toBeNull();
      expect(pose!.distanceMeters).toBeCloseTo(distance, 6);
    }
  });

  it('recovers lateral position in metres, with the mirror handled', () => {
    // Moving to your own right must come back as +x. Getting this backwards
    // produces a window that moves the wrong way, which is the single most
    // disorienting way for this feature to fail.
    const right = estimateHeadPose(synthesizeFace({ distance: 0.55, xMeters: 0.12 }), {
      aspect: ASPECT,
    })!;
    expect(right.xMeters).toBeCloseTo(0.12, 6);
    expect(right.imageX).toBeLessThan(0.5); // the user's right is the camera's left

    const up = estimateHeadPose(synthesizeFace({ distance: 0.55, yMeters: 0.08 }), {
      aspect: ASPECT,
    })!;
    expect(up.yMeters).toBeCloseTo(0.08, 6);
    expect(up.imageY).toBeLessThan(0.5); // image y grows downwards

    const both = estimateHeadPose(
      synthesizeFace({ distance: 0.7, xMeters: -0.09, yMeters: -0.05 }),
      { aspect: ASPECT },
    )!;
    expect(both.xMeters).toBeCloseTo(-0.09, 6);
    expect(both.yMeters).toBeCloseTo(-0.05, 6);
  });

  it('does not mistake a head TILT for the viewer leaning back', () => {
    // MediaPipe normalizes x by frame width and y by frame height. Measuring
    // the eye span without converting y into width units makes the span shrink
    // as the head rolls, and the viewer dollies backwards every time the user
    // tilts their head.
    const distance = 0.55;
    for (const roll of [0, 0.15, 0.35, -0.4]) {
      const pose = estimateHeadPose(synthesizeFace({ distance, roll, aspect: ASPECT }), {
        aspect: ASPECT,
      })!;
      expect(pose.distanceMeters).toBeCloseTo(distance, 6);
    }
  });

  it('does not mistake a head TURN for the viewer moving away', () => {
    // Yaw foreshortens the eye span in the image plane by cos(yaw). Including
    // the landmark z component recovers most of it back.
    const distance = 0.55;
    for (const yaw of [0.2, 0.4, 0.6]) {
      const landmarks = synthesizeFace({ distance, yaw, aspect: ASPECT });
      const pose = estimateHeadPose(landmarks, { aspect: ASPECT })!;
      expect(pose.distanceMeters / distance).toBeGreaterThan(0.95);
      expect(pose.distanceMeters / distance).toBeLessThan(1.05);

      // ...and what it would have been on the image-plane span alone.
      const dxOnly = Math.abs(
        landmarks[OUTER_EYE_CORNER_B].x - landmarks[OUTER_EYE_CORNER_A].x,
      );
      const naive =
        DEFAULT_BIOCULAR_WIDTH_M /
        (2 * dxOnly * Math.tan((DEFAULT_CAMERA_HFOV_DEG * Math.PI) / 360));
      expect(naive).toBeGreaterThan(distance * 1.01);
    }
    // At a 34-degree turn the naive estimate is out by more than 20%: on the
    // depth axis of a magic window that is the subject visibly jumping away.
    const landmarks = synthesizeFace({ distance, yaw: 0.6, aspect: ASPECT });
    const dxOnly = Math.abs(landmarks[OUTER_EYE_CORNER_B].x - landmarks[OUTER_EYE_CORNER_A].x);
    const naive =
      DEFAULT_BIOCULAR_WIDTH_M / (2 * dxOnly * Math.tan((DEFAULT_CAMERA_HFOV_DEG * Math.PI) / 360));
    expect(naive / distance).toBeGreaterThan(1.2);
  });

  it('scales with the assumed optics rather than baking in one webcam', () => {
    const distance = 0.6;
    const wide = estimateHeadPose(synthesizeFace({ distance, hFovDeg: 78, aspect: ASPECT }), {
      aspect: ASPECT,
      cameraHFovDeg: 78,
    })!;
    expect(wide.distanceMeters).toBeCloseTo(distance, 6);

    // Assume the wrong field of view and the absolute distance is wrong by the
    // ratio of the tangents — which is exactly why the hook divides everything
    // through by the distance measured at calibration.
    const mismatched = estimateHeadPose(synthesizeFace({ distance, hFovDeg: 78, aspect: ASPECT }), {
      aspect: ASPECT,
      cameraHFovDeg: 60,
    })!;
    const ratio =
      Math.tan((78 * Math.PI) / 360) / Math.tan((60 * Math.PI) / 360);
    expect(mismatched.distanceMeters).toBeCloseTo(distance * ratio, 6);
  });

  it('honours a per-user interocular width', () => {
    const pose = estimateHeadPose(
      synthesizeFace({ distance: 0.5, eyeWidth: 0.075, aspect: ASPECT }),
      { aspect: ASPECT, biocularWidthM: 0.075 },
    )!;
    expect(pose.distanceMeters).toBeCloseTo(0.5, 6);
  });

  it('clamps to a plausible range instead of emitting a pole', () => {
    // A face detected across a room, or a false positive a few pixels wide,
    // must not produce a 900-metre eye distance that the calibration then
    // divides by.
    const tiny = estimateHeadPose(synthesizeFace({ distance: 40 }), { aspect: ASPECT })!;
    expect(tiny.distanceMeters).toBeLessThanOrEqual(4);
    expect(tiny.distanceMeters).toBeGreaterThan(0);
  });

  it('returns null rather than a garbage pose when it cannot measure', () => {
    // Returning null is what lets the hook say "no face" honestly instead of
    // driving the camera off a division by almost zero.
    expect(estimateHeadPose(undefined, { aspect: ASPECT })).toBeNull();
    expect(estimateHeadPose([], { aspect: ASPECT })).toBeNull();
    expect(estimateHeadPose(synthesizeFace({ distance: 0.5 }), { aspect: 0 })).toBeNull();

    const collapsed = synthesizeFace({ distance: 0.5 });
    collapsed[OUTER_EYE_CORNER_B] = { ...collapsed[OUTER_EYE_CORNER_A] };
    expect(estimateHeadPose(collapsed, { aspect: ASPECT })).toBeNull();

    const broken = synthesizeFace({ distance: 0.5 });
    broken[OUTER_EYE_CORNER_A] = { x: NaN, y: 0.5, z: 0 };
    expect(estimateHeadPose(broken, { aspect: ASPECT })).toBeNull();
  });

  it('puts the reticle on the eyes, not on the nose', () => {
    const pose = estimateHeadPose(synthesizeFace({ distance: 0.55 }), { aspect: ASPECT })!;
    expect(pose.imageX).toBeCloseTo(0.5, 9);
    expect(pose.imageY).toBeCloseTo(0.5, 9);
    expect(pose.span).toBeGreaterThan(0);
  });
});
