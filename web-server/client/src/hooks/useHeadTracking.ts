import { useEffect, useRef } from 'react';
/*
  TYPE-ONLY. `import type` is erased at compile time, so naming FaceLandmarker
  in signatures below costs nothing at runtime — the actual module is fetched by
  the dynamic `import()` in `createLandmarker`, and only when XR is switched on.

  This matters more than it looks. `@mediapipe/tasks-vision` was a value import,
  which put the whole vision runtime in `main.js` for every visitor — including
  the overwhelming majority who open the Create tab, make one memory, and never
  touch the XR button. It is the second-largest thing the app can avoid
  downloading, after three.js and Spark (which App.tsx now splits out via
  React.lazy).

  Keep it `import type`. Adding any value import of this module here silently
  puts it back in the entry chunk, and nothing in CI will tell you.
*/
import type { FaceLandmarker } from '@mediapipe/tasks-vision';
import { OneEuroFilter } from '../utils/oneEuroFilter';
import { estimateHeadPose } from '../utils/headPose';
import { resolveHeadTrackingAssets, HeadTrackingAssets } from '../utils/headTrackingConfig';

/**
 * Webcam head tracking for the magic-window viewer.
 *
 * The single most important thing about this file is what it does NOT do: it
 * does not put the head pose in React state. The previous version called
 * `setHeadPosition` once per webcam frame, which re-rendered App, TopBar and
 * SplatViewer 30-60 times a second — reconciling the entire control panel,
 * the gallery and the tab strip — purely so that a `useEffect` downstream could
 * write three floats onto a THREE camera. Everything that consumes the pose
 * already runs its own rAF loop (the renderer, the preview canvas), so the pose
 * is published by MUTATING one long-lived object, `HeadTracking.pose`, whose
 * identity never changes.
 *
 * React is still involved, but only for things that actually change at human
 * speed: the status ("starting", "tracking", "camera blocked") and the
 * sensitivity value. Those go through `subscribe`/`getSnapshot` so a consumer
 * can pick them up with `useSyncExternalStore` and re-render at most a handful
 * of times per session.
 *
 * A consequence worth stating plainly, because it is what keeps `App.tsx`
 * unchanged: the value this hook returns as `headPosition` is that stable
 * handle, not a per-frame snapshot. Passing it down as a prop is free.
 */

/** Coarse state machine, driven to the UI. One string covers every user-visible case. */
export type HeadTrackingStatus =
  /** XR is off. Nothing has been loaded and no camera has been requested. */
  | 'off'
  /** Camera permission and/or the landmark model are being acquired. */
  | 'starting'
  /** Running, but no face in frame. */
  | 'searching'
  /** Running and locked on. */
  | 'tracking'
  /** The user (or a policy) refused the camera. Recoverable only by the user. */
  | 'denied'
  /** No camera, no secure context, or the model failed to load. */
  | 'unavailable';

/**
 * The live head pose. This object is MUTATED IN PLACE every frame; never store
 * a reference to it expecting a snapshot, and never use it as a React
 * dependency (its identity is deliberately constant).
 *
 * `x`, `y` and `z` are display-independent on purpose — this hook has no idea
 * how large the monitor is or how large the scene is. See `mapHeadPoseToEye`.
 */
export interface HeadPose {
  /** Offset to the viewer's right of the calibration point, in units of the calibrated distance. */
  x: number;
  /** Offset above the calibration point, same units. */
  y: number;
  /** Current distance / calibrated distance. 1 at the calibration pose, <1 leaning in. */
  z: number;
  /** False when no face was detected recently. Consumers should fade out, not freeze. */
  tracking: boolean;
  /** Eye midpoint in the raw (unmirrored) camera image, 0..1. For the preview overlay only. */
  imageX: number;
  imageY: number;
  /** Absolute estimated distance from the webcam, in metres. Diagnostic. */
  distanceMeters: number;
  /** `performance.now()` of the last successful detection. */
  updatedAt: number;
}

/** The slice of state that belongs in React. Immutable; replaced, never mutated. */
export interface HeadTrackingSnapshot {
  status: HeadTrackingStatus;
  /** Human-readable detail for error states. Null when there is nothing to say. */
  message: string | null;
  sensitivity: number;
  /** Whether the model and WASM came from this origin rather than a public CDN. */
  selfHosted: boolean;
}

export interface HeadTracking {
  /** Mutated in place at camera framerate. */
  readonly pose: HeadPose;
  /** Physically faithful at 1. Read every frame by the viewer. */
  readonly sensitivity: number;
  /** Stable references, safe to hand straight to `useSyncExternalStore`. */
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => HeadTrackingSnapshot;
  /** Treat wherever the head is now as dead centre, at the reference distance. */
  recenter: () => void;
  setSensitivity: (value: number) => void;
}

export interface HeadTrackingOptions {
  /** Starting parallax gain. 1 is physically correct; see `mapHeadPoseToEye`. */
  initialSensitivity?: number;
  /** Override the assumed webcam horizontal FOV (degrees) used for the distance estimate. */
  cameraHFovDeg?: number;
}

export const MIN_SENSITIVITY = 0.25;
export const MAX_SENSITIVITY = 3;

/**
 * Slightly above physically faithful. At 1.0 the parallax is correct but small:
 * people barely move their head in front of a laptop (a 10 cm sweep at a 55 cm
 * viewing distance is about 10 degrees), and the illusion needs to be legible
 * before it can be believed. 1.5 keeps the geometry honest at the centre — the
 * neutral pose is still exactly the orbit view — and exaggerates the excursion.
 */
const DEFAULT_SENSITIVITY = 1.5;

/**
 * How long a face may be missing before the UI says so. A single dropped
 * detection is routine (blink, motion blur, a hand across the frame); flipping
 * the badge on every one of them turns a status line into a strobe.
 */
const LOST_FACE_MS = 350;

/**
 * 1€ filter tuning. Lateral and depth are in metres, so `beta` is in Hz per
 * (metre/second).
 *
 * These are not guesses: `oneEuroFilter.test.ts` runs this exact pair against a
 * synthetic 0.5 m/s head sweep carrying +/-1.5 mm of landmark noise. At
 * minCutoff 1.2 / beta 16 the filter removes ~82% of the jitter of a still head
 * and trails a moving one by ~11 mm — where a fixed-alpha smoother tuned to the
 * SAME jitter rejection trails by ~53 mm. Raising beta further keeps buying lag
 * back for almost no jitter, but past this point the residual is smaller than
 * the landmark noise floor, so it is buying nothing real.
 *
 * Depth is filtered a little harder: the distance estimate comes from a ~40
 * pixel eye span and inherits that quantization directly, and depth error shows
 * up as the whole scene breathing rather than as a lateral wobble.
 */
const LATERAL_FILTER = { minCutoff: 1.2, beta: 16, dCutoff: 1.0 };
const DEPTH_FILTER = { minCutoff: 0.8, beta: 12, dCutoff: 1.0 };
/** The preview reticle. Image units, so the speeds — and therefore beta — are much smaller. */
const IMAGE_FILTER = { minCutoff: 2.0, beta: 4, dCutoff: 1.0 };

const NEUTRAL_POSE: HeadPose = {
  x: 0,
  y: 0,
  z: 1,
  tracking: false,
  imageX: 0.5,
  imageY: 0.5,
  distanceMeters: 0,
  updatedAt: 0,
};

class HeadTrackingController implements HeadTracking {
  readonly pose: HeadPose = { ...NEUTRAL_POSE };

  private snapshot: HeadTrackingSnapshot;
  private listeners = new Set<() => void>();

  private readonly filterX = new OneEuroFilter(LATERAL_FILTER);
  private readonly filterY = new OneEuroFilter(LATERAL_FILTER);
  private readonly filterD = new OneEuroFilter(DEPTH_FILTER);
  private readonly filterImageX = new OneEuroFilter(IMAGE_FILTER);
  private readonly filterImageY = new OneEuroFilter(IMAGE_FILTER);

  /** Null until the first good detection after enabling or after `recenter()`. */
  private calibration: { x: number; y: number; distance: number } | null = null;
  private lastSeenAt = 0;

  constructor(sensitivity: number, selfHosted: boolean) {
    this.snapshot = {
      status: 'off',
      message: null,
      sensitivity: clampSensitivity(sensitivity),
      selfHosted,
    };
    // Bound once: `useSyncExternalStore` resubscribes whenever the identity of
    // `subscribe` changes, and an unstable getSnapshot is an infinite loop.
    this.subscribe = this.subscribe.bind(this);
    this.getSnapshot = this.getSnapshot.bind(this);
    this.recenter = this.recenter.bind(this);
    this.setSensitivity = this.setSensitivity.bind(this);
  }

  get sensitivity(): number {
    return this.snapshot.sensitivity;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): HeadTrackingSnapshot {
    return this.snapshot;
  }

  private patch(next: Partial<HeadTrackingSnapshot>): void {
    let changed = false;
    for (const key of Object.keys(next) as (keyof HeadTrackingSnapshot)[]) {
      if (next[key] !== undefined && this.snapshot[key] !== next[key]) changed = true;
    }
    if (!changed) return;
    this.snapshot = { ...this.snapshot, ...next };
    this.listeners.forEach((l) => l());
  }

  setStatus(status: HeadTrackingStatus, message: string | null = null): void {
    this.patch({ status, message });
  }

  setSensitivity(value: number): void {
    this.patch({ sensitivity: clampSensitivity(value) });
  }

  /**
   * Re-zero the tracker. Deliberately does NOT reset the smoothing filters: the
   * user is sitting still when they press this, so the filtered estimate is the
   * best available reading of where "centre" is, and reusing it means the view
   * settles instantly instead of drifting into place over the next second.
   */
  recenter(): void {
    this.calibration = null;
  }

  /** Called on every detection that produced a usable pose. */
  publish(raw: {
    xMeters: number;
    yMeters: number;
    distanceMeters: number;
    imageX: number;
    imageY: number;
  }, nowMs: number): void {
    const t = nowMs / 1000;
    const x = this.filterX.filter(raw.xMeters, t);
    const y = this.filterY.filter(raw.yMeters, t);
    const d = this.filterD.filter(raw.distanceMeters, t);

    if (!this.calibration) {
      this.calibration = { x, y, distance: Math.max(d, 0.1) };
    }
    const cal = this.calibration;

    this.pose.x = (x - cal.x) / cal.distance;
    this.pose.y = (y - cal.y) / cal.distance;
    this.pose.z = d / cal.distance;
    this.pose.imageX = this.filterImageX.filter(raw.imageX, t);
    this.pose.imageY = this.filterImageY.filter(raw.imageY, t);
    this.pose.distanceMeters = d;
    this.pose.tracking = true;
    this.pose.updatedAt = nowMs;

    this.lastSeenAt = nowMs;
    if (this.snapshot.status === 'searching' || this.snapshot.status === 'starting') {
      this.setStatus('tracking');
    }
  }

  /** Called on every detection that found nothing. */
  missed(nowMs: number): void {
    if (this.lastSeenAt === 0) this.lastSeenAt = nowMs;
    if (nowMs - this.lastSeenAt < LOST_FACE_MS) return;

    if (this.pose.tracking) {
      this.pose.tracking = false;
      // Drop the smoothing history with the face. Keeping it means the first
      // frame after re-acquisition is blended against a pose from before you
      // left the frame, and the window sweeps across the room to catch up.
      this.filterX.reset();
      this.filterY.reset();
      this.filterD.reset();
      this.filterImageX.reset();
      this.filterImageY.reset();
    }
    if (this.snapshot.status === 'tracking' || this.snapshot.status === 'starting') {
      this.setStatus('searching');
    }
  }

  /** Back to the state before XR was ever enabled. */
  reset(): void {
    Object.assign(this.pose, NEUTRAL_POSE);
    this.filterX.reset();
    this.filterY.reset();
    this.filterD.reset();
    this.filterImageX.reset();
    this.filterImageY.reset();
    this.calibration = null;
    this.lastSeenAt = 0;
    this.setStatus('off', null);
  }
}

const clampSensitivity = (v: number) =>
  Number.isFinite(v) ? Math.min(Math.max(v, MIN_SENSITIVITY), MAX_SENSITIVITY) : DEFAULT_SENSITIVITY;

/** Turn whatever `getUserMedia`/MediaPipe threw into something a person can act on. */
const describeFailure = (err: unknown): { status: HeadTrackingStatus; message: string } => {
  const name = (err as { name?: string })?.name || '';
  const detail = (err as { message?: string })?.message || String(err);

  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
    return {
      status: 'denied',
      message: 'Camera access was blocked. Allow the camera for this site, then turn XR on again.',
    };
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
    return { status: 'unavailable', message: 'No camera was found on this device.' };
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return { status: 'unavailable', message: 'The camera is already in use by another application.' };
  }
  return { status: 'unavailable', message: detail };
};

/**
 * Build the FaceLandmarker, falling back from the GPU delegate to CPU.
 *
 * The GPU delegate needs a WebGL2 context of its own and fails outright on
 * machines with a blocklisted driver, inside some remote-desktop sessions, and
 * whenever the browser has already handed out its maximum number of contexts —
 * which this app makes likely, because the splat viewer is holding one. The old
 * code hard-coded `delegate: "GPU"` and reported the rejection to the console,
 * so on those machines XR was a button that turned green and did nothing.
 */
const createLandmarker = async (
  assets: HeadTrackingAssets,
): Promise<FaceLandmarker> => {
  /*
    The one place the vision runtime is actually pulled over the wire. This sits
    behind the same `await` chain that already asks for the camera, so the extra
    round trip costs nothing a user can perceive: the permission prompt is the
    slow step, and it happens first (deliberately — see the camera-first comment
    in `start`).

    A rejection here is a genuine failure mode, not a theoretical one: the chunk
    is served from this origin, so an offline PWA-style reload or a stale
    service worker can 404 it while the rest of the app runs fine. Let it
    propagate — `start` classifies it into the 'unavailable' status with an
    actionable message, which is strictly better than the old behaviour of
    failing at page load for everyone.
  */
  const { FaceLandmarker, FilesetResolver } = await import('@mediapipe/tasks-vision');
  const vision = await FilesetResolver.forVisionTasks(assets.wasmBase);
  const build = (delegate: 'GPU' | 'CPU') =>
    FaceLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: assets.modelUrl, delegate },
      runningMode: 'VIDEO',
      numFaces: 1,
      // Blendshapes and the facial transform matrix are extra work per frame and
      // nothing here consumes them. The previous code asked for blendshapes.
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: false,
    });

  if (assets.delegate === 'CPU') return build('CPU');
  try {
    return await build('GPU');
  } catch {
    return build('CPU');
  }
};

export const useHeadTracking = (enabled: boolean, options: HeadTrackingOptions = {}) => {
  const { initialSensitivity = DEFAULT_SENSITIVITY, cameraHFovDeg } = options;

  const assetsRef = useRef<HeadTrackingAssets>();
  if (!assetsRef.current) assetsRef.current = resolveHeadTrackingAssets();

  const controllerRef = useRef<HeadTrackingController>();
  if (!controllerRef.current) {
    controllerRef.current = new HeadTrackingController(
      initialSensitivity,
      assetsRef.current.selfHosted,
    );
  }
  const controller = controllerRef.current;
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (!enabled) {
      controller.reset();
      return;
    }

    const assets = assetsRef.current as HeadTrackingAssets;

    /*
      Every teardown path runs through `cancelled` plus these four locals.

      The previous implementation leaked on the two paths that matter. It never
      called `FaceLandmarker.close()`, so each XR toggle stranded an ~11 MB WASM
      heap and a WebGL context; and because `init()` was fired and forgotten,
      unmounting or toggling off DURING the `await` left `getUserMedia` to
      resolve into nothing — the camera light stayed on with no reference left
      to stop the track. The cleanup below runs against whatever has been
      acquired so far, and each `await` re-checks `cancelled` and disposes what
      it just built if the answer changed while it was suspended.
    */
    let cancelled = false;
    let stream: MediaStream | null = null;
    let landmarker: FaceLandmarker | null = null;
    let video: HTMLVideoElement | null = null;
    let raf = 0;

    const stopStream = (s: MediaStream | null) => s?.getTracks().forEach((t) => t.stop());

    let lastVideoTime = -1;
    let lastTimestamp = 0;
    let consecutiveErrors = 0;

    const loop = () => {
      raf = requestAnimationFrame(loop);
      if (cancelled || !video || !landmarker) return;
      // HAVE_CURRENT_DATA. Below this `detectForVideo` throws on the texture upload.
      if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;

      // Detecting the same frame twice costs a full inference pass and returns
      // the identical landmarks, which then feed the 1€ filter a zero-velocity
      // sample and make it smooth harder than it should. rAF runs at the
      // display's refresh rate; the camera is typically 30 fps.
      if (video.currentTime === lastVideoTime) return;
      lastVideoTime = video.currentTime;

      const nowMs = performance.now();
      // MediaPipe rejects a timestamp that is not strictly greater than the
      // last one, and two rAF ticks can share a millisecond.
      const timestamp = Math.max(nowMs, lastTimestamp + 1);
      lastTimestamp = timestamp;

      let results;
      try {
        results = landmarker.detectForVideo(video, timestamp);
      } catch (err) {
        consecutiveErrors += 1;
        // One-off failures happen when the track is renegotiated mid-stream.
        // A persistent one means the graph is dead and every frame from here on
        // is a wasted inference pass against a broken runtime.
        if (consecutiveErrors > 30) {
          cancelAnimationFrame(raf);
          raf = 0;
          controller.setStatus('unavailable', describeFailure(err).message);
        }
        return;
      }
      consecutiveErrors = 0;

      const landmarks = results.faceLandmarks?.[0];
      const raw = estimateHeadPose(landmarks, {
        aspect: video.videoWidth / video.videoHeight,
        cameraHFovDeg,
      });
      if (raw) controller.publish(raw, nowMs);
      else controller.missed(nowMs);
    };

    const start = async () => {
      controller.setStatus('starting', null);

      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
        // Almost always the secure-context rule rather than a missing feature:
        // browsers hide `mediaDevices` entirely on plain http, and this app is
        // routinely opened at `http://<box>:3000` on a LAN.
        controller.setStatus(
          'unavailable',
          'This browser only shares a camera over HTTPS or on localhost.',
        );
        return;
      }

      try {
        /*
          Camera first, model second — the reverse of the previous order, and
          not just for tidiness. The model plus its WASM runtime is roughly
          12 MB on a cold cache. Fetching that before asking for consent means
          the permission prompt appears several seconds after the click (so the
          button reads as broken), and it means a user who says no has already
          paid for the download. Asking first also puts the prompt inside the
          gesture that caused it, which is what browsers show the friendlier
          dialog for.
        */
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            // 640x480 is plenty: the face spans a few hundred pixels and the
            // model downsamples to 192x192 anyway. Asking for 1080p costs
            // inference time and battery for no accuracy.
            width: { ideal: 640 },
            height: { ideal: 480 },
            frameRate: { ideal: 30 },
            facingMode: 'user',
          },
          audio: false,
        });
        if (cancelled) return stopStream(stream);

        landmarker = await createLandmarker(assets);
        if (cancelled) {
          landmarker.close();
          landmarker = null;
          return stopStream(stream);
        }

        video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.autoplay = true;
        video.srcObject = stream;
        // `autoplay` alone is not reliable for an element that is never inserted
        // into the document, and the previous code depended on it: if the
        // element never played, `loadeddata` never fired and the whole feature
        // silently did nothing. The rejection is ignored because the rAF loop
        // already tolerates a video that is not ready yet.
        await video.play().catch(() => undefined);
        if (cancelled) {
          video.srcObject = null;
          video = null;
          landmarker.close();
          landmarker = null;
          return stopStream(stream);
        }

        videoRef.current = video;
        controller.setStatus('searching', null);
        raf = requestAnimationFrame(loop);
      } catch (err) {
        if (cancelled) return stopStream(stream);
        const { status, message } = describeFailure(err);
        controller.setStatus(status, message);
        stopStream(stream);
        stream = null;
      }
    };

    start();

    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
      if (video) {
        video.pause();
        video.srcObject = null;
      }
      if (videoRef.current === video) videoRef.current = null;
      stopStream(stream);
      // Releases the WASM heap and, on the GPU delegate, the WebGL context. The
      // splat viewer wants that context back.
      landmarker?.close();
      landmarker = null;
      controller.reset();
    };
  }, [enabled, controller, cameraHFovDeg]);

  return {
    /** The live handle. Stable for the lifetime of the component. */
    headTracking: controller as HeadTracking,
    /**
     * Legacy alias. `App.tsx` destructures `headPosition` and passes it to both
     * TopBar and SplatViewer; it is the same handle, and because its identity
     * never changes, threading it through props costs nothing. Prefer
     * `headTracking` in new code.
     */
    headPosition: controller as HeadTracking,
    videoRef,
  };
};
