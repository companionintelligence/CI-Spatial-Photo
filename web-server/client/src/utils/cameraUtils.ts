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
