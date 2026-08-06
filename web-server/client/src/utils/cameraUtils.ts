import * as THREE from 'three';

export const makeAxisFlipCvToGl = () =>
  new THREE.Matrix4().set(1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1);

const quantileSorted = (sorted: number[], q: number) => {
  if (!sorted.length) return 0;
  const clampedQ = Math.max(0, Math.min(1, q));
  const pos = (sorted.length - 1) * clampedQ;
  const lower = Math.floor(pos);
  const upper = Math.ceil(pos);
  if (lower === upper) return sorted[lower];
  const weight = pos - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
};

export const computeMlSharpDepthFocus = (
  mesh: any,
  { qFocus = 0.1, minDepthFocus = 2.0, maxSamples = 50_000 } = {},
) => {
  const numSplats = mesh?.packedSplats?.numSplats ?? 0;
  if (!numSplats) return minDepthFocus;

  const step = Math.max(1, Math.floor(numSplats / maxSamples));
  const depths = [];
  for (let i = 0; i < numSplats; i += step) {
    const { center } = mesh.packedSplats.getSplat(i);
    const z = center.z;
    if (Number.isFinite(z) && z > 0) depths.push(z);
  }

  if (!depths.length) return minDepthFocus;
  depths.sort((a, b) => a - b);
  const q = quantileSorted(depths, qFocus);
  if (!Number.isFinite(q)) return minDepthFocus;
  return Math.max(minDepthFocus, q);
};

export type Vec3Tuple = [number, number, number];

/**
 * The distance from a box's centre at which the WHOLE box fits inside a
 * perspective frustum, looking at the centre from `direction`.
 *
 * This exists because the old fallback framing in SplatViewer was wrong in a way
 * that is easy to miss: it computed the correct distance and then used it as
 * EVERY COMPONENT of the offset — `position = centre + (d, d, d)` — which puts
 * the camera at `d * sqrt(3)`, so the subject rendered at roughly a third of the
 * size it was fitted for. It also only ever considered the vertical field of
 * view, so a wide subject on a narrow (portrait) viewport was cropped at the
 * sides even at the intended distance.
 *
 * The solve is exact rather than a bounding-sphere approximation, because the
 * preview engine produces a FLAT plane (server/app/plywriter.py) whose bounding
 * sphere is far larger than the plane itself: fitting the sphere would leave the
 * photo at ~70% of the frame with the error growing as the subject gets wider.
 * For every corner `p` of the box, relative to the centre, with the camera at
 * `centre + direction * d`:
 *
 *     depth   = d - p·direction
 *     |p·right| <= depth * tan(hFov/2)      and     |p·up| <= depth * tan(vFov/2)
 *
 * which rearranges to a required `d` per corner; the answer is their maximum.
 *
 * @param halfSize  Half the box's WORLD-space size (x, y, z), all >= 0.
 * @param direction From the centre towards the camera. Need not be normalised.
 * @param fovDeg    The camera's vertical field of view, in degrees.
 * @param aspect    Viewport width / height.
 * @param margin    >1 leaves breathing room; 1.0 fits the box edge-to-edge.
 */
export const fitDistanceToBox = (
  halfSize: Vec3Tuple,
  direction: Vec3Tuple,
  fovDeg: number,
  aspect: number,
  margin = 1.1,
): number => {
  const len = Math.hypot(...direction);
  if (!(len > 0) || !(fovDeg > 0) || !(aspect > 0)) return 0;
  const dir: Vec3Tuple = [direction[0] / len, direction[1] / len, direction[2] / len];

  // A camera basis around `dir`. THREE's PerspectiveCamera keeps its up vector
  // as +Y, so `right` is the horizontal of the rendered image; the degenerate
  // case (looking straight down the Y axis) falls back to the X axis.
  const cross = (a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const normalise = (v: Vec3Tuple): Vec3Tuple => {
    const l = Math.hypot(...v);
    return l > 1e-9 ? [v[0] / l, v[1] / l, v[2] / l] : [1, 0, 0];
  };
  const right = normalise(cross([0, 1, 0], dir));
  const up = normalise(cross(dir, right));

  const tanV = Math.tan((fovDeg * Math.PI) / 360) / Math.max(margin, 1e-3);
  const tanH = tanV * aspect;

  const dot = (a: Vec3Tuple, b: Vec3Tuple) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  let distance = 0;
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const p: Vec3Tuple = [
          sx * Math.abs(halfSize[0]),
          sy * Math.abs(halfSize[1]),
          sz * Math.abs(halfSize[2]),
        ];
        const needed = dot(p, dir) + Math.max(Math.abs(dot(p, right)) / tanH, Math.abs(dot(p, up)) / tanV);
        if (needed > distance) distance = needed;
      }
    }
  }
  return distance;
};

export const makeProjectionFromIntrinsics = ({
  fx,
  fy,
  cx,
  cy,
  width,
  height,
  near,
  far,
}: {
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  width: number;
  height: number;
  near: number;
  far: number;
}) => {
  const left = (-cx * near) / fx;
  const right = ((width - cx) * near) / fx;
  const top = (cy * near) / fy;
  const bottom = (-(height - cy) * near) / fy;

  return new THREE.Matrix4().set(
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
};
