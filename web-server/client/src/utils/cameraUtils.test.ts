import * as THREE from 'three';
import { fitDistanceToBox, Vec3Tuple } from './cameraUtils';

/**
 * These assertions are made against THREE's own projection maths rather than
 * against the formula under test: place a real PerspectiveCamera where
 * fitDistanceToBox says to, project the eight corners of the subject with
 * `Vector3.project`, and look at the normalised device coordinates that come
 * back. |ndc| <= 1 on both axes means the corner is inside the frame.
 */
const projectCorners = (
  halfSize: Vec3Tuple,
  direction: Vec3Tuple,
  fovDeg: number,
  aspect: number,
  distance: number,
) => {
  const camera = new THREE.PerspectiveCamera(fovDeg, aspect, 0.01, 500);
  const dir = new THREE.Vector3(...direction).normalize();
  camera.position.copy(dir).multiplyScalar(distance);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);

  let maxX = 0;
  let maxY = 0;
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const ndc = new THREE.Vector3(sx * halfSize[0], sy * halfSize[1], sz * halfSize[2]).project(
          camera,
        );
        maxX = Math.max(maxX, Math.abs(ndc.x));
        maxY = Math.max(maxY, Math.abs(ndc.y));
      }
    }
  }
  return { maxX, maxY };
};

/** What server/app/plywriter.py writes for a 1280x720 photo: a flat plane, y in [-1, 1]. */
const PREVIEW_PLANE: Vec3Tuple = [16 / 9, 1, 0.001];
/** The viewer's camera (SplatViewer.tsx) and its default view direction. */
const FOV = 60;
const DIR: Vec3Tuple = [0.34, 0.17, 1];

describe('fitDistanceToBox', () => {
  it('fills the frame to the edge at margin 1, without cropping', () => {
    for (const aspect of [16 / 9, 1280 / 720, 1, 360 / 640, 0.4]) {
      const d = fitDistanceToBox(PREVIEW_PLANE, DIR, FOV, aspect, 1);
      const { maxX, maxY } = projectCorners(PREVIEW_PLANE, DIR, FOV, aspect, d);
      // Nothing outside the frame...
      expect(maxX).toBeLessThanOrEqual(1 + 1e-6);
      expect(maxY).toBeLessThanOrEqual(1 + 1e-6);
      // ...and one axis touching it exactly, i.e. no slack left over.
      expect(Math.max(maxX, maxY)).toBeGreaterThan(1 - 1e-6);
    }
  });

  it('leaves exactly the margin it is asked for', () => {
    const margin = 1.12;
    const d = fitDistanceToBox(PREVIEW_PLANE, DIR, FOV, 16 / 9, margin);
    const { maxX, maxY } = projectCorners(PREVIEW_PLANE, DIR, FOV, 16 / 9, d);
    expect(Math.max(maxX, maxY)).toBeCloseTo(1 / margin, 3);
  });

  it('honours the horizontal field of view on a portrait viewport', () => {
    // The old code fitted the vertical FOV only. On a 360x640 phone that leaves
    // a 16:9 plane hanging out of both sides of the frame.
    const aspect = 360 / 640;
    const radius = Math.hypot(...PREVIEW_PLANE);
    const verticalOnly = radius / Math.tan((FOV * Math.PI) / 360);
    expect(projectCorners(PREVIEW_PLANE, DIR, FOV, aspect, verticalOnly).maxX).toBeGreaterThan(1);

    const d = fitDistanceToBox(PREVIEW_PLANE, DIR, FOV, aspect, 1.12);
    expect(projectCorners(PREVIEW_PLANE, DIR, FOV, aspect, d).maxX).toBeLessThan(1);
  });

  it('is much closer than the (d, d, d) offset it replaces', () => {
    // The regression itself: `position = centre + (d, d, d)` is |(1,1,1)| = sqrt(3)
    // times the distance that was computed, so the subject rendered at ~1/3 size.
    const aspect = 16 / 9;
    const radius = Math.hypot(...PREVIEW_PLANE);
    const oldD = (radius / Math.tan((FOV * Math.PI) / 360)) * Math.sqrt(3);
    const old = projectCorners(PREVIEW_PLANE, [1, 1, 1], FOV, aspect, oldD);
    // 0.47 of the half-frame, i.e. the subject covered 47% of the frame height —
    // which is what viewer-orbit.png measures, so this reproduces the shot.
    expect(Math.max(old.maxX, old.maxY)).toBeCloseTo(0.47, 2);

    const d = fitDistanceToBox(PREVIEW_PLANE, DIR, FOV, aspect, 1.12);
    const now = projectCorners(PREVIEW_PLANE, DIR, FOV, aspect, d);
    expect(Math.max(now.maxX, now.maxY)).toBeCloseTo(1 / 1.12, 3);
  });

  it('scales with the subject and refuses degenerate input', () => {
    const small = fitDistanceToBox([0.5, 0.5, 0.5], DIR, FOV, 1.5, 1.1);
    const big = fitDistanceToBox([5, 5, 5], DIR, FOV, 1.5, 1.1);
    expect(big / small).toBeCloseTo(10, 6);
    expect(fitDistanceToBox(PREVIEW_PLANE, [0, 0, 0], FOV, 1.5)).toBe(0);
    expect(fitDistanceToBox(PREVIEW_PLANE, DIR, 0, 1.5)).toBe(0);
    expect(fitDistanceToBox(PREVIEW_PLANE, DIR, FOV, 0)).toBe(0);
  });

  it('handles a subject viewed from (nearly) straight above', () => {
    const box: Vec3Tuple = [1, 0.2, 1];
    const nearly: Vec3Tuple = [0.02, 1, 0];
    const d = fitDistanceToBox(box, nearly, FOV, 16 / 9, 1);
    expect(Math.max(...Object.values(projectCorners(box, nearly, FOV, 16 / 9, d)))).toBeCloseTo(
      1,
      5,
    );

    // Exactly vertical is degenerate for a +Y-up camera — THREE's own lookAt
    // picks an arbitrary roll there — so only require containment, not an exact
    // touch. Nothing in the app reaches this direction; the guard is for reuse.
    const straight = fitDistanceToBox(box, [0, 1, 0], FOV, 16 / 9, 1.05);
    const { maxX, maxY } = projectCorners(box, [0, 1, 0], FOV, 16 / 9, straight);
    expect(Math.max(maxX, maxY)).toBeLessThan(1);
  });
});
