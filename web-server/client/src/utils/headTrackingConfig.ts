/**
 * Where the head-tracking model and its WASM runtime are fetched from.
 *
 * The product claim this app is built on is "nothing left your hardware" — it
 * is the narration line over the viewer shot in `video/storyboard.json`. The
 * head tracker itself honours that (frames are decoded and discarded in the
 * page; no image data is ever uploaded), but the previous code hard-coded two
 * public CDN hostnames for the runtime, so enabling XR made an unavoidable
 * outbound request to `cdn.jsdelivr.net` and `storage.googleapis.com`. On an
 * appliance that is deliberately air-gapped, that is not a privacy leak so much
 * as a feature that simply does not start.
 *
 * So both locations are configurable. The CDN stays the default because it is
 * what works out of the box on a fresh clone, and because vendoring an 11 MB
 * WASM blob into the repo to serve a feature that is off by default is a bad
 * trade. See `docs/UI-GUIDE.md` for the self-hosting recipe.
 */

/**
 * Pinned to the version of `@mediapipe/tasks-vision` in package.json.
 *
 * This is not cosmetic. The JS in the bundle and the WASM it loads are one
 * program split across two files; MediaPipe does not version-negotiate between
 * them. The previous default asked jsDelivr for the `0.10.0` WASM while npm had
 * installed the `0.10.x` (currently 0.10.35) JS glue, which is a combination
 * nobody tests and which fails at `createFromOptions` with an unhelpful abort
 * inside the Emscripten runtime rather than a readable error.
 *
 * Keep this in sync when bumping the dependency. It cannot be read from
 * package.json at runtime: CRA's ModuleScopePlugin refuses imports from outside
 * `src/`.
 */
export const MEDIAPIPE_TASKS_VISION_VERSION = '0.10.35';

export const DEFAULT_MEDIAPIPE_WASM_BASE =
  `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_TASKS_VISION_VERSION}/wasm`;

export const DEFAULT_FACE_LANDMARKER_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

export type LandmarkerDelegate = 'GPU' | 'CPU';

export interface HeadTrackingAssets {
  /** Directory containing `vision_wasm_internal.{js,wasm}` and friends. No trailing slash. */
  wasmBase: string;
  /** Absolute or same-origin URL of the `face_landmarker.task` bundle. */
  modelUrl: string;
  /** Which MediaPipe delegate to try first. */
  delegate: LandmarkerDelegate;
  /** True when neither location points at a third-party host. Surfaced in the UI. */
  selfHosted: boolean;
}

export interface HeadTrackingAssetOverrides {
  wasmBase?: string;
  modelUrl?: string;
  delegate?: string;
}

/**
 * Read the build-time configuration.
 *
 * There is no `process` in a browser: these are substituted into the bundle by
 * webpack's DefinePlugin during `npm run build`, which means (a) they are fixed
 * at BUILD time and setting them on a running container does nothing — the same
 * rule `REACT_APP_API_BASE` already lives under in `client/Dockerfile` — and (b)
 * each one is written out as a literal member expression on `process.env`.
 * react-scripts 5 happens to define the whole `process.env` object, so indexing
 * it dynamically would survive here, but every other bundler (Vite, Next,
 * esbuild) defines per-key and would silently yield `undefined`. Keeping the
 * literal form costs nothing and removes the trap.
 *
 * The whole thing is behind a function taking overrides so the resolution rules
 * can be unit-tested without a build.
 */
const readEnv = (): HeadTrackingAssetOverrides => ({
  wasmBase: process.env.REACT_APP_MEDIAPIPE_WASM_BASE,
  modelUrl: process.env.REACT_APP_FACE_LANDMARKER_MODEL_URL,
  delegate: process.env.REACT_APP_FACE_LANDMARKER_DELEGATE,
});

const trimTrailingSlash = (s: string) => s.replace(/\/+$/, '');

/** True for anything that is not an absolute URL to a different origin. */
const isLocalUrl = (url: string): boolean => {
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url) && !url.startsWith('//')) return true;
  if (typeof window === 'undefined') return false;
  try {
    return new URL(url, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
};

export const resolveHeadTrackingAssets = (
  overrides: HeadTrackingAssetOverrides = readEnv(),
): HeadTrackingAssets => {
  const wasmBase = trimTrailingSlash(
    (overrides.wasmBase || '').trim() || DEFAULT_MEDIAPIPE_WASM_BASE,
  );
  const modelUrl = (overrides.modelUrl || '').trim() || DEFAULT_FACE_LANDMARKER_MODEL_URL;
  const requested = (overrides.delegate || '').trim().toUpperCase();
  const delegate: LandmarkerDelegate = requested === 'CPU' ? 'CPU' : 'GPU';

  return {
    wasmBase,
    modelUrl,
    delegate,
    selfHosted: isLocalUrl(wasmBase) && isLocalUrl(modelUrl),
  };
};
