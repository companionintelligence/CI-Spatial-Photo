import React, { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { Boxes, Hand, Scan, X } from 'lucide-react';
// @ts-ignore
import { SparkRenderer } from '@sparkjsdev/spark';
// @ts-ignore
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
// @ts-ignore
import { getFormatHandler } from '../formats/index.js';
import {
  makeAxisFlipCvToGl,
  computeMlSharpDepthFocus,
  makeProjectionFromIntrinsics,
  fitDistanceToBox,
} from '../utils/cameraUtils';
import {
  calibrationDistanceMeters,
  computeOffAxisFrustum,
  computeWindowGeometry,
  DEFAULT_VIEWING_DISTANCE_M,
  makeOffAxisProjection,
  mapHeadPoseToEye,
} from '../utils/magicWindow';
import {
  getDisplayDiagonalInches,
  measureCanvasRectMetres,
  readScreenSize,
  subscribeDisplayCalibration,
} from '../utils/screenGeometry';
import type { MetricRect } from '../utils/screenGeometry';
import {
  detectXrCapabilities,
  endXrSession,
  isXrSessionError,
  requestXrSession,
  resolveReferenceSpace,
} from '../utils/webxrSession';
import type { XrCapabilities, XrSessionHandle } from '../utils/webxrSession';
import {
  applyPlacement,
  assetFrameFromBounds,
  beginDrag,
  beginTwoFinger,
  computeArrivalScale,
  matrixFromHitPose,
  placementFromHitPose,
  updateDrag,
  updateTwoFinger,
} from '../utils/arPlacement';
import type {
  ArPlacement,
  AssetFrame,
  DragGesture,
  PointerSample,
  PointerView,
  ScaleLimits,
  TwoFingerGesture,
} from '../utils/arPlacement';
import { HeadTracking } from '../hooks/useHeadTracking';

/** Ground plane, in units of the subject's widest horizontal dimension. */
const GRID_SPAN_FACTOR = 2.4;
/** The GridHelper is built at this size, so scaling is relative to it. */
const GRID_BASE_SIZE = 2.5;

/**
 * Where the plane of the "glass" sits, as a fraction of the distance from the
 * orbit camera to its target.
 *
 * This one number decides whether the magic window has anything to show. Put
 * the glass ON the subject (1.0) and a subject with no depth — which is exactly
 * what the default `preview` engine produces, a flat textured plane of
 * Gaussians (server/app/plywriter.py) — sits in the plane of the window and
 * therefore never parallaxes at all: you would move your head and see nothing
 * happen. Pulling the glass forward puts the whole subject BEHIND it, like a
 * diorama in a box, so even a flat photo slides within the window frame the way
 * a poster seen through a doorway does.
 *
 * Any value gives an identical picture at the calibration pose — the window is
 * cut from the same view cone, so it frames exactly what the orbit camera
 * framed. It only changes how much the scene moves per centimetre of head
 * travel, and how quickly the window edge starts cropping.
 */
const WINDOW_DEPTH_FRACTION = 0.55;

/**
 * Seconds to ramp between "no face" and "tracking". Snapping the frustum from
 * a large off-axis offset back to centre in a single frame is a visible lurch,
 * and losing the face for a moment is routine.
 */
const TRACKING_FADE_SECONDS = 0.25;

/** Radii of the AR placement reticle, in metres. Roughly a coffee-cup coaster. */
const RETICLE_INNER_R = 0.055;
const RETICLE_OUTER_R = 0.075;

/**
 * The fixed rectangle the head-tracked camera looks through, captured from the
 * orbit camera at the instant XR is switched on. Everything here is world
 * space; `normal` points out of the glass, towards the viewer.
 */
interface WindowAnchor {
  /** The orbit pose to restore when XR is switched off. */
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  right: THREE.Vector3;
  up: THREE.Vector3;
  normal: THREE.Vector3;
  /**
   * The point the window is built around: `position + forward * subjectDistance`.
   *
   * This is the orbit target PROJECTED ONTO THE VIEW AXIS, not the target
   * itself, and the difference matters on the intrinsics path — there the
   * camera pose comes from the file's extrinsic while the orbit target is a
   * depth-focus point derived from the geometry, and the two are only exactly
   * collinear after `controls.update()` has run. Measuring the glass from the
   * view axis keeps it centred in the viewport in every case; measuring it from
   * an off-axis target would slide the window sideways the moment XR came on.
   */
  axisTarget: THREE.Vector3;
  /** Distance from the anchored camera to its target. `L` in the calibration derivation. */
  subjectDistance: number;
}

const captureWindowAnchor = (
  camera: THREE.PerspectiveCamera,
  target: THREE.Vector3,
): WindowAnchor => {
  const quaternion = camera.quaternion.clone();
  // Taken from the quaternion rather than from `target - position`, because the
  // quaternion is what is actually on screen: it carries the roll that a
  // metadata-driven extrinsic can introduce, and reconstructing the basis from
  // the target direction alone would silently level the horizon the moment XR
  // was enabled.
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(quaternion);
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(quaternion);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion);

  const subjectDistance = Math.max(camera.position.distanceTo(target), 0.05);

  return {
    position: camera.position.clone(),
    quaternion,
    right,
    up,
    normal: forward.clone().negate(),
    axisTarget: camera.position.clone().addScaledVector(forward, subjectDistance),
    subjectDistance,
  };
};

/**
 * Place the camera at the tracked eye and rebuild its projection so the four
 * corners of the glass stay welded to the four corners of the viewport.
 *
 * The camera's ORIENTATION never changes — that is the whole point, and the
 * difference between this and the `lookAt(0, 0, 0)` it replaces. A window does
 * not turn to follow you.
 *
 * Two regimes, one code path. With `screenRect` null the geometry collapses to
 * the uncalibrated construction this function has always used: the glass sits
 * `WINDOW_DEPTH_FRACTION * L` in front of the camera and the eye sits at the
 * camera. With a measured `screenRect` the camera dollies back to `L * A` and
 * the lens narrows by exactly `1 / A`, which leaves the framing at the target
 * plane bit-identical while making the parallax 1:1 with real head movement —
 * see the calibration block in `utils/magicWindow.ts` for the derivation, and
 * note that the two projection MATRICES are deliberately different: only what
 * lands in the target plane is preserved.
 *
 * Everything is derived from the anchor's `axisTarget` rather than from a
 * cached glass centre, because calibration MOVES the glass in world space
 * (`glassToTarget` goes from `L(1-f)` to `L*A*(1-f)`). Re-anchoring from the
 * already-dollied camera would compound the dolly on every resize.
 */
const applyMagicWindow = (
  camera: THREE.PerspectiveCamera,
  anchor: WindowAnchor,
  tracker: HeadTracking,
  blend: number,
  screenRect: MetricRect | null,
  calibrationDistanceM: number,
) => {
  // Recomputed per frame rather than stored on the anchor so that a window
  // resize — which changes `camera.aspect`, and `camera.fov` too on the
  // intrinsics path — and a Recentre — which changes `calibrationDistanceM` —
  // are both picked up without having to re-calibrate the user.
  const geometry = computeWindowGeometry({
    subjectDistance: anchor.subjectDistance,
    depthFraction: WINDOW_DEPTH_FRACTION,
    fovDeg: camera.fov,
    aspect: camera.aspect,
    screenRect,
    calibrationDistanceM,
  });

  const eye = mapHeadPoseToEye({
    pose: tracker.pose,
    windowDistance: geometry.windowDistance,
    sensitivity: tracker.sensitivity,
    blend,
  });

  camera.position
    .copy(anchor.axisTarget)
    .addScaledVector(anchor.normal, geometry.glassToTarget)
    .addScaledVector(anchor.right, eye.x)
    .addScaledVector(anchor.up, eye.y)
    .addScaledVector(anchor.normal, eye.z);
  camera.quaternion.copy(anchor.quaternion);
  camera.updateMatrixWorld(true);

  makeOffAxisProjection(
    computeOffAxisFrustum({
      halfWidth: geometry.halfWidth,
      halfHeight: geometry.halfHeight,
      eye,
      near: camera.near,
      // Widened by the dolly factor, because the calibrated camera stands `A`
      // times further from the subject and `A` reaches 4 on a laptop. Passed
      // into the frustum instead of being written onto `camera.far`: nothing
      // else reads `camera.far` in this configuration (Spark only forwards it
      // to uniforms consumed by the splat-texture path, which is off), and
      // mutating it would need a matching restore on every path that drops the
      // anchor — including the asset loader, where a missed restore would
      // multiply `far` by `A` again on every load.
      far: camera.far * Math.max(geometry.angularScale, 1),
    }),
    camera.projectionMatrix,
  );
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
};

/** Sit the ground grid under the loaded subject, scaled to it. */
const fitGridToSubject = (
  grid: THREE.GridHelper | null,
  center: THREE.Vector3,
  size: THREE.Vector3,
) => {
  if (!grid) return;
  const span = Math.max(size.x, size.z, 0.5) * GRID_SPAN_FACTOR;
  grid.scale.setScalar(span / GRID_BASE_SIZE);
  grid.position.set(center.x, center.y - size.y / 2 - span * 0.02, center.z);
};

/**
 * Everything the orbit view needs to come back exactly as it left.
 *
 * three's `WebXRManager` does not borrow the camera, it OVERWRITES it: every XR
 * frame `updateCamera` copies the view pose onto `camera.matrix`, decomposes it
 * into position/quaternion, copies the XR projection onto
 * `camera.projectionMatrix`, and rewrites `camera.fov`, `camera.aspect` and
 * `camera.zoom` to match the headset's frustum. So "leave AR" is not a matter of
 * putting the session down — every one of those fields is gone, and `fov` in
 * particular is never rebuilt by `handleResize` on the non-intrinsics path,
 * which is the common one. Snapshot it all on the way in.
 */
interface ArRestoreState {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  fov: number;
  aspect: number;
  near: number;
  far: number;
  zoom: number;
  background: THREE.Scene['background'];
  clearAlpha: number;
  gridVisible: boolean;
}

/** Where the AR flow is. Drives the overlay copy and gates the frame loop. */
type ArPhase =
  /** No session. The viewer is an ordinary orbit/magic-window viewer. */
  | 'off'
  /** `requestSession` is in flight, or the session is being handed to three. */
  | 'entering'
  /** Session live, nothing placed yet: the reticle is hunting for a surface. */
  | 'scanning'
  /** The memory is standing in the room and the gestures are live. */
  | 'placed';

interface SplatViewerProps {
  fileUrl?: string;
  file?: File;
  className?: string;
  /**
   * The live head-tracking handle, or null for ordinary orbit control.
   *
   * Both names accept the same object. `headPosition` is what `App.tsx` passes
   * today and is kept so the wiring there does not have to change in lockstep
   * with this file; `headTracking` is the name to use in new code. This is NOT
   * a per-frame value — it is a stable handle whose `pose` field is mutated in
   * place, so this prop changes identity at most twice per session and no
   * React render is ever driven by head motion.
   */
  headPosition?: HeadTracking | null;
  headTracking?: HeadTracking | null;
}

const SplatViewer: React.FC<SplatViewerProps> = ({
  fileUrl,
  file,
  className,
  headPosition,
  headTracking,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const sparkRef = useRef<any>(null);
  const gridRef = useRef<THREE.GridHelper | null>(null);
  const currentMeshRef = useRef<any>(null);
  /**
   * The memory's own node in the scene graph, identity outside AR.
   *
   * The asset cannot be placed directly: `applyPlacement` writes a whole TRS,
   * and the mesh's own TRS already carries the CV→GL axis flip that makes the
   * asset the right way up. A wrapper keeps the two transforms in different
   * places, so entering and leaving AR can never lose the flip.
   */
  const memoryGroupRef = useRef<THREE.Group | null>(null);

  /*
    Head tracking is read from refs inside the render loop, never from props
    inside an effect. The version this replaces applied the pose in a
    `useEffect` keyed on a `headPosition` state value that the hook updated once
    per webcam frame, so every head movement re-rendered App and its entire
    control panel in order to move a camera — and then `controls.update()`, one
    rAF tick later, overwrote the result anyway (see the animate loop).
  */
  const trackerRef = useRef<HeadTracking | null>(null);
  const anchorRef = useRef<WindowAnchor | null>(null);
  const trackingBlendRef = useRef(0);
  /** Set by the init effect so the XR-exit path can rebuild the ordinary projection. */
  const applyProjectionRef = useRef<(() => void) | null>(null);

  /**
   * The canvas rectangle in metres, or null when the display has not been
   * calibrated. Recomputed in `handleResize` and whenever the stored diagonal
   * changes — NOT per frame, because deriving it needs `clientWidth`, and
   * reading that inside the render loop forces a synchronous layout 60 times a
   * second for a number that only changes when the window does.
   */
  const screenRectRef = useRef<MetricRect | null>(null);
  /**
   * Last believable metric viewing distance. Fed back into
   * `calibrationDistanceMeters` as its fallback so that losing the face for a
   * few frames holds the dolly still instead of snapping the camera to the
   * 0.6 m default and back.
   */
  const calibrationDistanceRef = useRef(DEFAULT_VIEWING_DISTANCE_M);

  // ── AR ────────────────────────────────────────────────────────────────────
  const overlayRef = useRef<HTMLDivElement>(null);
  const arControlsRef = useRef<HTMLDivElement>(null);
  const hitTestSourceRef = useRef<XRHitTestSource | null>(null);
  const reticleRef = useRef<THREE.Mesh | null>(null);
  const arRestoreRef = useRef<ArRestoreState | null>(null);
  /** Last valid hit pose, in world space. What a tap places against. */
  const latestHitRef = useRef<THREE.Matrix4 | null>(null);
  const placementRef = useRef<ArPlacement | null>(null);
  const assetFrameRef = useRef<AssetFrame | null>(null);
  const arScaleRef = useRef<{ scale: number; limits: ScaleLimits } | null>(null);
  const dragRef = useRef<DragGesture | null>(null);
  const twoFingerRef = useRef<TwoFingerGesture | null>(null);
  const pointersRef = useRef<Map<number, PointerSample>>(new Map());
  const overlayRectRef = useRef<DOMRect | null>(null);
  /**
   * Mirrors `arPhase` for the frame loop and for `handleResize`, both of which
   * are created once and cannot see later state.
   */
  const arPhaseRef = useRef<ArPhase>('off');
  /**
   * True from just before `xr.setSession` until the first line of the restore.
   *
   * Deliberately ours rather than `renderer.xr.isPresenting`: three flips that
   * flag inside its OWN `end` listener, and our teardown runs first (the
   * session module attaches its listener when the handle is made, before three
   * ever sees the session). A resize guard keyed on `isPresenting` would
   * therefore refuse to rebuild the projection during the exact call that is
   * supposed to rebuild it.
   */
  const arPresentingRef = useRef(false);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string>('');
  const [assetReady, setAssetReady] = useState(false);
  const [caps, setCaps] = useState<XrCapabilities | null>(null);
  const [arPhase, setArPhaseState] = useState<ArPhase>('off');
  const [arError, setArError] = useState<string | null>(null);

  /** Keep the ref and the state in lockstep; nothing may set one alone. */
  const setArPhase = useCallback((phase: ArPhase) => {
    arPhaseRef.current = phase;
    setArPhaseState(phase);
  }, []);

  /*
    WebXR capability probe.

    `detectXrCapabilities` cannot reject, and `caps` starts null meaning
    "unknown" — nothing AR-related renders until a real `isSessionSupported`
    has resolved `true`. That ordering is the whole reason the product-video
    capture (headless Chromium, no WebXR) never photographs an AR control:
    there is no synchronous "probably supported" answer to render optimistically
    from, and the pessimistic answer arrives as `supported: false`.
  */
  useEffect(() => {
    let live = true;
    detectXrCapabilities().then((c) => {
      if (live) setCaps(c);
    });
    return () => {
      live = false;
    };
  }, []);

  // Initialize Three.js
  useEffect(() => {
    if (!containerRef.current) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#0c1018");
    sceneRef.current = scene;

    /*
      Guarded, because this throws rather than returning null when the browser
      cannot give us a WebGL2 context — a machine with hardware acceleration
      disabled, a locked-down enterprise profile, a headless runner without
      SwiftShader. An uncaught throw inside an effect unmounts the whole React
      tree above it, so the symptom was a blank page with a console trace
      instead of a viewer saying what went wrong.
    */
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: false,
        alpha: false,
      });
    } catch (e: any) {
      setError(e?.message || 'This browser cannot create a WebGL context.');
      return;
    }
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setPixelRatio(window.devicePixelRatio);
    containerRef.current.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const camera = new THREE.PerspectiveCamera(60, 1, 0.01, 500);
    camera.position.set(0.5, 0.5, 2.5);
    cameraRef.current = camera;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.rotateSpeed = 0.75;
    controls.zoomSpeed = 0.6;
    controls.panSpeed = 0.6;
    controls.target.set(0, 0, 0);
    controlsRef.current = controls;

    const spark = new SparkRenderer({ renderer });
    /*
      Spark's own WebXR contract, from `SparkRendererOptions.preUpdate`:
      "Controls whether to update the Gsplats before or after rendering. For
      WebXR this must be false in order to complete rendering as soon as
      possible." False is the default, and this line is here to make that a
      decision rather than an accident — flipping it would stall the XR frame
      behind a full re-sort and drop the session to half rate.

      The other half of the ordering is Spark's, not ours: `onBeforeRender`
      branches on `renderer.xr.isPresenting` and takes its sort viewpoint from
      `renderer.xr.getCamera().cameras` (averaged over the views) instead of
      from the app camera. That only happens if the splats are drawn through
      `renderer.render(scene, camera)` inside the session's own frame callback,
      which is why the loop below goes through `renderer.setAnimationLoop`.
      Sorting against the app camera — which three overwrites but does not
      drive — would back-to-front the whole memory in the headset.
    */
    spark.preUpdate = false;
    scene.add(spark);
    sparkRef.current = spark;

    const memoryGroup = new THREE.Group();
    scene.add(memoryGroup);
    memoryGroupRef.current = memoryGroup;

    const grid = new THREE.GridHelper(GRID_BASE_SIZE, 10, 0x2a2f3a, 0x151822);
    grid.position.y = -0.5;
    scene.add(grid);
    gridRef.current = grid;

    // A flat ring on the surface the hit test found. `matrixAutoUpdate = false`
    // because the pose matrix is written straight in: decomposing it into
    // position/quaternion and letting three recompose it every frame is two
    // conversions that can only lose precision.
    const reticle = new THREE.Mesh(
      new THREE.RingGeometry(RETICLE_INNER_R, RETICLE_OUTER_R, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x60a5fa, transparent: true, opacity: 0.9 }),
    );
    reticle.matrixAutoUpdate = false;
    reticle.visible = false;
    scene.add(reticle);
    reticleRef.current = reticle;

    /*
      Exactly one thing may write the camera per frame.

      Both modes used to run at once, and the result was not "a bit of both" —
      it was orbit winning. `OrbitControls.update()` does not check `enabled`
      (only its pointer handlers do): every call re-derives the camera position
      from `target + spherical(offset)` and then calls `object.lookAt(target)`.
      So the head-tracking effect's `camera.lookAt(0, 0, 0)` was overwritten one
      rAF tick later by a lookAt at the orbit target, the head-driven position
      was pushed back onto the orbit sphere with `_spherical.makeSafe()` pinning
      it away from the poles and `_clampDistance` bounding its radius, and any
      leftover damping from the user's last drag kept rotating underneath it.
      Hence: while a tracker is attached, `controls.update()` is not called at
      all, and `controls.enabled` is false so it also stops consuming input.

      AR is a third writer and it wins outright: three's WebXRManager rewrites
      the camera from the view pose every frame, so both of the others are
      skipped while a session is live rather than fighting a battle they lose.
    */
    let lastFrameMs = performance.now();
    const animate = (_time?: number, frame?: XRFrame) => {
      const now = performance.now();
      // Clamped because a backgrounded tab resumes with a multi-second gap, and
      // the tracking fade would otherwise jump straight to its end state.
      const dt = Math.min(Math.max((now - lastFrameMs) / 1000, 0), 0.1);
      lastFrameMs = now;

      const tracker = trackerRef.current;
      if (arPresentingRef.current) {
        updateReticle(frame);
      } else if (tracker) {
        if (!anchorRef.current) {
          anchorRef.current = captureWindowAnchor(camera, controls.target);
        }
        const goal = tracker.pose.tracking ? 1 : 0;
        const step = dt / TRACKING_FADE_SECONDS;
        trackingBlendRef.current =
          goal > trackingBlendRef.current
            ? Math.min(goal, trackingBlendRef.current + step)
            : Math.max(goal, trackingBlendRef.current - step);
        calibrationDistanceRef.current = calibrationDistanceMeters(
          tracker.pose,
          calibrationDistanceRef.current,
        );
        applyMagicWindow(
          camera,
          anchorRef.current,
          tracker,
          trackingBlendRef.current,
          screenRectRef.current,
          calibrationDistanceRef.current,
        );
      } else {
        controls.update();
      }

      renderer.render(scene, camera);
    };

    /**
     * Hunt for a surface under the middle of the screen.
     *
     * Only while nothing is placed: once the memory is standing in the room the
     * reticle is noise, and re-running the hit test would keep a live pose ref
     * around for a tap that no longer means "place here".
     */
    const updateReticle = (frame?: XRFrame) => {
      const source = hitTestSourceRef.current;
      const refSpace = renderer.xr.getReferenceSpace();
      /*
        Both misses clear the remembered pose, not just the ring. The reticle is
        the ONLY thing telling the user where a tap will land, so a tap while it
        is hidden must do nothing — leaving the last good pose behind would let
        a tap into thin air stand the memory wherever the phone happened to be
        aimed a second ago, which is indistinguishable from the hit test being
        wildly inaccurate.
      */
      if (!frame || !source || !refSpace || arPhaseRef.current !== 'scanning') {
        reticle.visible = false;
        latestHitRef.current = null;
        return;
      }

      const results = frame.getHitTestResults(source);
      const pose = results.length > 0 ? results[0].getPose(refSpace) : undefined;
      // `matrixFromHitPose` rather than `fromArray`: a hit test hands back NaNs
      // when tracking drops in the same frame the results are read, and a NaN
      // in an object matrix does not throw — the object silently stops being
      // drawn, so the reticle would just vanish with no explanation.
      const matrix = pose ? matrixFromHitPose(pose.transform.matrix, reticle.matrix) : null;
      if (!matrix) {
        reticle.visible = false;
        latestHitRef.current = null;
        return;
      }
      reticle.matrixWorldNeedsUpdate = true;
      reticle.visible = true;
      // Cloned, because `reticle.matrix` is overwritten on the very next frame
      // and a tap resolves one frame later at the earliest.
      latestHitRef.current = (latestHitRef.current ?? new THREE.Matrix4()).copy(matrix);
    };

    /*
      `renderer.setAnimationLoop`, not `requestAnimationFrame`.

      This is a requirement of WebXR and not a style choice: while a session is
      presenting, frames must be driven by `XRSession.requestAnimationFrame`,
      and only that callback receives the `XRFrame` that hit testing and pose
      queries need. three's renderer already owns the switchover — it stops its
      page-level loop on `sessionstart` and restarts it on `sessionend` — so
      registering here once covers both modes and there is nothing to remember
      to restart on the way out.
    */
    renderer.setAnimationLoop(animate);

    const handleResize = () => {
      if (!containerRef.current || !renderer || !camera) return;
      const { clientWidth, clientHeight } = containerRef.current;

      /*
        The canvas's physical size, for the calibrated magic window. Measured
        from `clientWidth`/`clientHeight` — CSS pixels — and never from
        `canvas.width`, which is the backing store at `clientWidth * dpr` and
        would halve the calibrated parallax on any Retina panel. Recomputed
        here because this is the one function that already knows the canvas has
        changed size.
      */
      const diagonalInches = getDisplayDiagonalInches();
      const screen = readScreenSize();
      screenRectRef.current =
        diagonalInches !== null && screen
          ? measureCanvasRectMetres({
              diagonalInches,
              cssWidth: clientWidth,
              cssHeight: clientHeight,
              screen,
            })
          : null;

      /*
        While a session is presenting, the framebuffer, the pixel ratio and the
        whole camera are three's. An orientation change on a phone fires a
        resize mid-session, and answering it by calling `setSize` with the CSS
        size would resize the XR render target out from under the compositor.
      */
      if (arPresentingRef.current) return;

      // `updateStyle` must stay ON. setPixelRatio(dpr) sizes the BACKING STORE to
      // clientWidth * dpr; passing `false` here skipped the matching CSS size, so on
      // any HiDPI display the canvas element laid out at dpr x the container and the
      // parent's `overflow-hidden` cropped the view to its top-left 1/dpr — at dpr 3,
      // one ninth of the scene, with the splat pushed off-frame. Nothing else in this
      // component ever sets the canvas CSS size.
      renderer.setSize(clientWidth, clientHeight);

      // If we have active camera metadata, re-apply projection
      if (currentMeshRef.current && currentMeshRef.current.userData.cameraMetadata) {
          const meta = currentMeshRef.current.userData.cameraMetadata;
          const { intrinsics, near, far } = meta;

          // Logic from browser-sharp applyCameraProjection
          const sx = clientWidth / intrinsics.imageWidth;
          const sy = clientHeight / intrinsics.imageHeight;
          const s = Math.min(sx, sy);
          const scaledWidth = intrinsics.imageWidth * s;
          const scaledHeight = intrinsics.imageHeight * s;
          const offsetX = (clientWidth - scaledWidth) * 0.5;
          const offsetY = (clientHeight - scaledHeight) * 0.5;

          const fx = intrinsics.fx * s;
          const fy = intrinsics.fy * s;
          const cx = intrinsics.cx * s + offsetX;
          const cy = intrinsics.cy * s + offsetY;

          camera.aspect = clientWidth / clientHeight;
          camera.fov = THREE.MathUtils.radToDeg(
            2 * Math.atan(clientHeight / (2 * Math.max(1e-6, fy))),
          );
          camera.near = near || 0.01;
          camera.far = far || 1000;

          const projection = makeProjectionFromIntrinsics({
            fx,
            fy,
            cx,
            cy,
            width: clientWidth,
            height: clientHeight,
            near: camera.near,
            far: camera.far,
          });
          camera.projectionMatrix.copy(projection);
          camera.projectionMatrixInverse.copy(projection).invert();
      } else {
          camera.aspect = clientWidth / clientHeight;
          camera.updateProjectionMatrix();
      }
    };

    const container = containerRef.current;
    // Exposed so that leaving XR can rebuild whichever projection this asset is
    // supposed to have (intrinsics-derived or plain perspective). The XR frame
    // loop writes `camera.projectionMatrix` directly, and nothing else in this
    // component would ever undo that.
    applyProjectionRef.current = handleResize;
    window.addEventListener('resize', handleResize);
    // Changing the display diagonal changes `screenRectRef` and therefore the
    // window geometry. Routed through the same function so there is exactly one
    // place that knows how to measure the canvas.
    const unsubscribeCalibration = subscribeDisplayCalibration(handleResize);
    handleResize();

    return () => {
      applyProjectionRef.current = null;
      window.removeEventListener('resize', handleResize);
      unsubscribeCalibration();
      renderer.setAnimationLoop(null);
      // Unmounting with a session live would leave the headset/phone in an AR
      // view rendering into a disposed context, with no UI left to end it.
      void endXrSession();
      /*
        OrbitControls owns pointer/wheel/touch listeners on the canvas and a
        contextmenu listener, and it is the only object here that was never
        torn down. This component genuinely unmounts in normal use — App.tsx
        renders no viewer in the empty state — so closing an asset and opening
        another left the previous controls attached to a detached canvas.
        Dispose before the renderer, while its DOM element still exists.
      */
      controlsRef.current?.dispose();
      controlsRef.current = null;
      reticle.geometry.dispose();
      (reticle.material as THREE.Material).dispose();
      if (renderer) {
        renderer.dispose();
        container?.removeChild(renderer.domElement);
      }
      if (spark) (spark as any).dispose?.();
    };
  }, []);

  /*
    Enter and leave the magic window.

    This effect runs at most twice per session — when XR is switched on and when
    it is switched off — because the prop it watches is a stable handle, not a
    pose. It does no per-frame work; it only decides which of the two writers in
    the animate loop is allowed to touch the camera, and it restores the orbit
    camera bit-for-bit on the way out so that turning XR off does not silently
    re-frame the user's memory.
  */
  useEffect(() => {
    const supplied = headTracking ?? headPosition ?? null;

    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!camera || !controls) {
      trackerRef.current = supplied;
      return;
    }

    const takeOver = () => {
      /*
        IDEMPOTENT, and that is load-bearing rather than tidiness.

        `sync` runs on every snapshot the controller publishes, and
        `HeadTrackingController.patch` notifies for status, message, sensitivity
        AND selfHosted — so dragging the Parallax slider fires it repeatedly.
        This function used to drop the anchor every time. The frame loop then
        re-anchored with `captureWindowAnchor(camera, controls.target)` against
        a camera `applyMagicWindow` had ALREADY dollied back to `L*A`, so the
        fresh `subjectDistance` was `L*A`, the next dolly took it to `L*A²`, and
        the one after that to `L*A³`.

        Uncalibrated that was invisible: A is exactly 1, so re-anchoring at the
        neutral pose is a no-op. Calibrated it is geometric runaway — at the
        27" A≈2.75 measured in the calibration tests, two slider notches put the
        camera 7.6x too far away and the memory shrinks to a speck.

        So re-entry resets the window; a notification while already driving does
        not. `trackerRef.current === supplied` is exactly the "already driving"
        test, because `giveBack` is the only thing that clears it.
      */
      if (trackerRef.current === supplied) return;

      trackerRef.current = supplied;
      // Anchored lazily in the frame loop rather than here: a freshly loaded
      // asset may still be re-framing the camera in its own effect, and the
      // window has to be cut from the pose the user can actually see.
      anchorRef.current = null;
      trackingBlendRef.current = 0;
      controls.enabled = false;
    };

    const giveBack = () => {
      trackerRef.current = null;
      const anchor = anchorRef.current;
      if (anchor) {
        camera.position.copy(anchor.position);
        camera.quaternion.copy(anchor.quaternion);
        camera.updateMatrixWorld(true);
        anchorRef.current = null;
      }
      trackingBlendRef.current = 0;
      controls.enabled = true;
      applyProjectionRef.current?.();
      controls.update();
    };

    if (!supplied) {
      giveBack();
      return;
    }

    /*
      Having a tracker is NOT the same as the tracker working, and conflating
      the two made the viewer unusable.

      App.tsx hands this prop down on `isXREnabled` alone, so pressing the Eye
      button surrenders the camera immediately: `controls.enabled = false` and
      the animate loop stops calling `controls.update()`. If `getUserMedia`
      then rejects — permission denied, no camera, or plain http, all of which
      are ordinary — the controller parks in a terminal state, `pose.tracking`
      never becomes true, and `applyMagicWindow` re-pins the camera to the
      anchor every frame. The user is left with a viewer they cannot orbit,
      cannot zoom, and cannot recover except by finding the same Eye button
      again. The status badge explains the camera; nothing explains the dead
      mouse.

      So the camera follows the tracker's STATUS, not its existence: the two
      terminal states hand orbit straight back, and a tracker that later
      recovers takes it again. Subscribing here rather than lifting status into
      React state keeps this off the render path — the pose is deliberately not
      React state, and neither should this be.
    */
    const isDead = (status: string) => status === 'denied' || status === 'unavailable';

    const sync = () => {
      if (isDead(supplied.getSnapshot().status)) giveBack();
      else takeOver();
    };

    sync();
    return supplied.subscribe(sync);
  }, [headTracking, headPosition]);

  // Load File
  useEffect(() => {
    const load = async () => {
      if ((!fileUrl && !file) || !sceneRef.current || !sparkRef.current) return;

      setLoading(true);
      setError(null);
      setAssetReady(false);
      setInfo('Loading...');

      try {
        let fileObj: File | { name: string, arrayBuffer: () => Promise<ArrayBuffer> };

        if (file) {
          fileObj = file;
        } else if (fileUrl) {
          const response = await fetch(fileUrl);
          const blob = await response.blob();
          const name = fileUrl.split('/').pop() || 'model.ply';
          fileObj = new File([blob], name);
        } else {
            return;
        }

        const formatHandler = getFormatHandler(fileObj);
        if (!formatHandler) {
          throw new Error('Unsupported file format');
        }

        const bytes = new Uint8Array(await fileObj.arrayBuffer());

        // Load Metadata
        let cameraMetadata = null;
        try {
            // @ts-ignore
            cameraMetadata = await formatHandler.loadMetadata({ file: fileObj, bytes });
        } catch (e) {
            console.warn('Failed to load metadata', e);
        }

        // Load Mesh
        // @ts-ignore
        const mesh = await formatHandler.loadData({ file: fileObj, bytes });

        // Apply the OpenCV -> OpenGL flip ONLY to assets that are actually in
        // OpenCV coordinates. Carrying camera intrinsics is what identifies
        // them: `loadMetadata` returns null unless the PLY has an `intrinsic`
        // element, and that element is written by the ml-sharp pipeline.
        //
        // The `preview` engine does NOT write one, and it already emits y-up
        // (OpenGL) geometry — server/app/plywriter.py maps image row 0 to
        // y = +1. Flipping it again inverted every preview asset: the porch
        // deck rendered along the TOP edge and the sun hung below the railing.
        // That is the default engine, so this was the common case, and it is
        // visible in the committed product-video shots (viewer-orbit.png).
        if (cameraMetadata) {
            mesh.applyMatrix4(makeAxisFlipCvToGl());
        }

        const memoryGroup = memoryGroupRef.current;
        /*
          A new asset invalidates any placement of the old one, and the framing
          maths below reads `mesh.matrixWorld`, which inherits the group. Both
          are handled by putting the group back to identity first — including
          mid-session, where the only sane answer is to drop back to hunting for
          a surface rather than silently inheriting the previous memory's spot.
        */
        if (memoryGroup) {
          memoryGroup.position.set(0, 0, 0);
          memoryGroup.quaternion.identity();
          memoryGroup.scale.setScalar(1);
          memoryGroup.visible = !arPresentingRef.current;
          memoryGroup.updateMatrixWorld(true);
        }
        placementRef.current = null;
        if (arPhaseRef.current === 'placed') setArPhase('scanning');

        if (currentMeshRef.current) {
            (memoryGroup ?? sceneRef.current).remove(currentMeshRef.current);
        }
        currentMeshRef.current = mesh;
        (memoryGroup ?? sceneRef.current).add(mesh);
        // After the add, not before it: `matrixWorld` is the product with the
        // parent's, and the framing branches below read it.
        mesh.updateMatrixWorld(true);

        /*
          The asset's own box, in the GROUP's space rather than the world's —
          `mesh.matrix`, not `mesh.matrixWorld`. They are equal right now
          (the group is identity), but the AR placement multiplies the group,
          and a box measured through it would be scaled twice the second time
          the user re-places a memory.
        */
        if (mesh.getBoundingBox) {
          const localBox = mesh.getBoundingBox().clone().applyMatrix4(mesh.matrix);
          const arrival = computeArrivalScale({ size: localBox.getSize(new THREE.Vector3()) });
          arScaleRef.current = { scale: arrival.scale, limits: arrival.limits };
          assetFrameRef.current = assetFrameFromBounds(localBox);
        } else {
          /*
            No measurable box — an importer that does not expose one. Scale 1 is
            the only honest answer (the asset's units are unknown), and
            `computeArrivalScale` returns exactly that for a zero extent, with a
            symmetric fallback pinch range so the user can still reach a sensible
            size by hand. Leaving this null instead would make the tap that
            places the memory do nothing at all, with nothing to explain it.
          */
          const arrival = computeArrivalScale({ size: { x: 0, y: 0, z: 0 } });
          arScaleRef.current = { scale: arrival.scale, limits: arrival.limits };
          assetFrameRef.current = null;
        }

        // Setup Camera
        if (cameraMetadata && cameraRef.current && controlsRef.current) {
             // Store metadata for resize
             mesh.userData.cameraMetadata = cameraMetadata;

             // Only the extrinsic is needed here. The intrinsics are consumed by
             // `handleResize`, which reads them back off `userData.cameraMetadata`
             // — that is why this block ends by dispatching a resize rather than
             // building a projection itself: one code path owns the projection,
             // and it has to re-run on every viewport change anyway.
             const { extrinsicCv } = cameraMetadata;

             // Apply extrinsic
             const e = extrinsicCv;
             const extrinsicCvMat = new THREE.Matrix4().set(
                e[0], e[1], e[2], e[3],
                e[4], e[5], e[6], e[7],
                e[8], e[9], e[10], e[11],
                e[12], e[13], e[14], e[15],
             );

             // view = cvToThree * extrinsicCv * cvToThree
             //
             // This is the same flip the mesh got above, and it has to be: the
             // extrinsic is in OpenCV axes, so it is conjugated into Three's.
             // It is scoped to this branch because that is exactly where the
             // mesh flip applies too — `cameraMetadata` is the discriminator.
             const cvToThree = makeAxisFlipCvToGl();
             const view = new THREE.Matrix4()
                .multiplyMatrices(cvToThree, extrinsicCvMat)
                .multiply(cvToThree);

             const cameraWorld = new THREE.Matrix4().copy(view).invert();

             cameraRef.current.matrixAutoUpdate = true;
             cameraRef.current.matrixWorld.copy(cameraWorld);
             cameraRef.current.matrixWorld.decompose(cameraRef.current.position, cameraRef.current.quaternion, cameraRef.current.scale);
             cameraRef.current.updateMatrix();
             cameraRef.current.updateMatrixWorld(true);

             // Calculate lookAt depth
             const depthFocusCv = computeMlSharpDepthFocus(mesh);
             const lookAtCv = new THREE.Vector3(0, 0, depthFocusCv);
             const lookAtThree = lookAtCv.applyMatrix4(mesh.matrixWorld);
             controlsRef.current.target.copy(lookAtThree);

             // Calculate near/far based on bounding box if available
             if (mesh.getBoundingBox) {
                const box = mesh.getBoundingBox();
                const worldBox = box.clone().applyMatrix4(mesh.matrixWorld);
                const size = new THREE.Vector3();
                const center = new THREE.Vector3();
                worldBox.getSize(size);
                worldBox.getCenter(center);
                const radius = Math.max(size.length() * 0.5, 0.25);

                const camPos = cameraRef.current.position.clone();
                const dist = camPos.distanceTo(center);

                const near = Math.max(0.01, dist - radius * 2.0);
                const far = Math.max(near + 1.0, dist + radius * 6.0);

                // Update metadata with calculated near/far
                mesh.userData.cameraMetadata.near = near;
                mesh.userData.cameraMetadata.far = far;
             }

             /*
               Only if the magic window is not currently driving the camera.
               Loading an asset while XR is on used to re-enable OrbitControls
               unconditionally, which puts two writers back on one camera: the
               next `controls.update()` re-derives position from the orbit
               target and overwrites the head-tracked pose, and — worse — a pan
               during XR then corrupts the anchor that leaving XR restores, so
               the user's framing does not come back.
             */
             if (!trackerRef.current) {
               controlsRef.current.enabled = true;
               controlsRef.current.update();
             }

             // Trigger resize to apply projection
             window.dispatchEvent(new Event('resize'));

        } else if (mesh.getBoundingBox && cameraRef.current && controlsRef.current) {
            // No camera metadata in the file — every asset the `preview` engine
            // writes is in this branch, because server/app/plywriter.py emits no
            // `intrinsic` element and readPlyCamera returns null without one. So
            // this IS the default framing for the common case, not a rare path.
            //
            // It used to place the camera at `centre + (d, d, d)` with
            // `d = radius / tan(fov/2)`: sqrt(3) times too far, fitted against
            // the vertical FOV only, and looking down a 45deg/35deg diagonal that
            // shows a flat photo plane nearly edge-on. A full-frame memory
            // rendered as a small skewed quad in the middle of a black viewport.
            const box = mesh.getBoundingBox();
            const worldBox = box.clone().applyMatrix4(mesh.matrixWorld);
            const size = new THREE.Vector3();
            const worldCenter = new THREE.Vector3();
            worldBox.getSize(size);
            worldBox.getCenter(worldCenter);

            // Off-axis enough to read as 3D and not as a pasted image; shallow
            // enough that the photo itself stays legible. The old (1,1,1) is a
            // 45deg yaw / 35deg pitch, which foreshortens a plane to about half
            // its width.
            const dir = new THREE.Vector3(0.34, 0.17, 1).normalize();
            const radius = Math.max(size.length() * 0.5, 0.25);
            const dist = Math.max(
              fitDistanceToBox(
                [size.x / 2, size.y / 2, size.z / 2],
                [dir.x, dir.y, dir.z],
                cameraRef.current.fov,
                cameraRef.current.aspect,
                1.12,
              ),
              radius * 0.5,
            );

            cameraRef.current.position.copy(worldCenter).addScaledVector(dir, dist);
            cameraRef.current.lookAt(worldCenter);

            cameraRef.current.near = Math.max(0.01, (dist - radius) * 0.5);
            cameraRef.current.far = Math.max(dist * 4, radius * 8);
            cameraRef.current.updateProjectionMatrix();

            controlsRef.current.target.copy(worldCenter);
            controlsRef.current.update();

            // The grid is scenery for the subject, so it has to follow it. At its
            // built-in 2.5 units it was SMALLER than a 3.6-unit-wide plane and sat
            // at a fixed y = -0.5, i.e. cutting through the middle of it.
            fitGridToSubject(gridRef.current, worldCenter, size);
        }

        // Both framing branches above have just moved the camera and the orbit
        // target. If XR is on, the window was cut from the PREVIOUS asset's
        // framing and is now pointing at nothing; dropping the anchor makes the
        // frame loop re-cut it from the new pose on its next tick.
        anchorRef.current = null;

        sparkRef.current.update({ scene: sceneRef.current });
        setInfo(`Loaded ${mesh.packedSplats.numSplats} splats`);
        setAssetReady(true);

      } catch (err: any) {
        console.error(err);
        setError(err.message || 'Failed to load');
      } finally {
        setLoading(false);
      }
    };

    load();
  }, [fileUrl, file, setArPhase]);

  /* ──────────────────────────────────────────────────────────────────────────
     AR: enter, place, gesture, leave.
     ────────────────────────────────────────────────────────────────────────── */

  /**
   * The camera the user is actually looking through.
   *
   * `cameras[0]`, not the ArrayCamera: three builds the ArrayCamera's own
   * projection as the union of its sub-frusta, so unprojecting through it is
   * correct only by accident when there is exactly one view. handheld AR is
   * monoscopic today, so the accident holds — and stops holding on a headset.
   */
  const xrViewCamera = useCallback((): THREE.Camera | null => {
    const renderer = rendererRef.current;
    if (!renderer) return null;
    const xrCamera = renderer.xr.getCamera();
    return (xrCamera?.cameras && xrCamera.cameras[0]) || xrCamera || cameraRef.current;
  }, []);

  /**
   * The camera plus the CSS-pixel rectangle the finger is on — everything
   * needed to turn a touch into a point on the floor.
   *
   * Kept separate from `xrViewCamera` because placement by the XR `select`
   * event needs the camera and NOT the rectangle: on a headset there is no DOM
   * overlay, no pointer event has ever fired, and the rect is therefore never
   * measured. Folding the two together made the very first tap of every session
   * silently do nothing.
   */
  const pointerView = useCallback((): PointerView | null => {
    const camera = xrViewCamera();
    const rect = overlayRectRef.current;
    if (!camera || !rect || rect.width <= 0 || rect.height <= 0) return null;
    return { camera, viewport: { width: rect.width, height: rect.height } };
  }, [xrViewCamera]);

  const commitPlacement = useCallback((placement: ArPlacement) => {
    const group = memoryGroupRef.current;
    if (!group) return;
    placementRef.current = placement;
    group.visible = true;
    // `assetFrameRef` is what makes "tap here" mean "stand it here": without it
    // the asset's ORIGIN lands on the tap, and for a depth cloud that origin is
    // the median-depth plane, so the memory ends up floating or metres to one
    // side and it reads as the hit test being broken.
    applyPlacement(group, placement, assetFrameRef.current);
  }, []);

  /** Stand the memory on the surface the reticle is showing. */
  const placeAtReticle = useCallback(() => {
    const hit = latestHitRef.current;
    const camera = xrViewCamera();
    const arrival = arScaleRef.current;
    if (!hit || !camera || !arrival) return;

    const previous = placementRef.current;
    const placement = placementFromHitPose({
      hit,
      viewer: new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld),
      // Re-placing keeps the size the user pinched it to. Recomputing the
      // arrival scale here would undo their pinch every time they moved the
      // memory to a new spot.
      scale: previous?.scale ?? arrival.scale,
      // Same for the yaw: without this the memory snaps back to "facing me"
      // and the twist gesture is only ever one re-place from being undone.
      fallbackYaw: previous?.yaw ?? 0,
    });
    if (!placement) return;

    commitPlacement(placement);
    setArPhase('placed');
  }, [commitPlacement, setArPhase, xrViewCamera]);

  /**
   * Put everything back exactly as AR found it.
   *
   * Idempotent and defensive: it is registered as the session's `onEnd`
   * listener, so it runs for a headset being taken off and an Android back
   * gesture as well as for the Exit button — and it also runs on the failure
   * path of `enterAr`, where half of what it undoes was never done.
   */
  const restoreFromAr = useCallback(() => {
    arPresentingRef.current = false;

    const renderer = rendererRef.current;
    const scene = sceneRef.current;
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    const group = memoryGroupRef.current;
    const restore = arRestoreRef.current;

    try {
      hitTestSourceRef.current?.cancel();
    } catch {
      /* Cancelling a source whose session has already gone throws on some
         runtimes. There is nothing to recover — it is gone either way. */
    }
    hitTestSourceRef.current = null;
    latestHitRef.current = null;
    placementRef.current = null;
    dragRef.current = null;
    twoFingerRef.current = null;
    pointersRef.current.clear();

    if (reticleRef.current) reticleRef.current.visible = false;
    if (group) {
      group.position.set(0, 0, 0);
      group.quaternion.identity();
      group.scale.setScalar(1);
      group.visible = true;
      group.updateMatrixWorld(true);
    }

    if (renderer) {
      renderer.xr.enabled = false;
      renderer.setPixelRatio(window.devicePixelRatio);
      if (restore) renderer.setClearAlpha(restore.clearAlpha);
    }
    if (scene && restore) scene.background = restore.background;
    if (gridRef.current && restore) gridRef.current.visible = restore.gridVisible;

    if (camera && restore) {
      camera.position.copy(restore.position);
      camera.quaternion.copy(restore.quaternion);
      camera.fov = restore.fov;
      camera.aspect = restore.aspect;
      camera.near = restore.near;
      camera.far = restore.far;
      camera.zoom = restore.zoom;
      camera.updateMatrixWorld(true);
    }
    arRestoreRef.current = null;

    /*
      Rebuilds whichever projection this asset is supposed to have from the
      restored fov/near/far — the same call the magic window's `giveBack` uses,
      so there is one exit path for the camera and not two.
    */
    applyProjectionRef.current?.();
    if (controls && !trackerRef.current) controls.update();

    /*
      ...and again on the next frame, because three gets the last word.

      The ordering here is FIXED, not either-way: `makeHandle` registers its
      `end` listener when the session is created, which is before
      `renderer.xr.setSession` registers three's, so ours runs first and three's
      `onSessionEnd` runs after everything above. That handler re-applies the
      canvas size three recorded when the session STARTED. If the viewport
      changed while the user was in AR — a phone rotated between portrait and
      landscape is the ordinary case, not an exotic one — the canvas comes back
      at the old size and the view is stretched until something else triggers a
      resize.

      One rAF is enough: three's listener is synchronous within the same
      `sessionend` dispatch, so by the next frame it has already run and this
      resize wins. Guarded on the renderer still existing, because unmounting
      during the exit is a real sequence (close the asset, leave AR).
    */
    requestAnimationFrame(() => {
      if (rendererRef.current) applyProjectionRef.current?.();
    });

    setArPhase('off');
  }, [setArPhase]);

  const enterAr = useCallback(async () => {
    const renderer = rendererRef.current;
    const camera = cameraRef.current;
    const scene = sceneRef.current;
    if (!renderer || !camera || !scene) return;
    if (arPhaseRef.current !== 'off') return;

    setArError(null);
    setArPhase('entering');

    /*
      First statement after the guards, and deliberately not preceded by an
      `isSessionSupported` round trip: immersive session requests need transient
      user activation, and an await between the click and `requestSession` is
      how "Enter AR" becomes a button that works on a fast phone and silently
      fails on a slow one. Support is already known — the control does not exist
      until `detectXrCapabilities` confirmed it at render time.
    */
    let handle: XrSessionHandle;
    try {
      handle = await requestXrSession({
        mode: 'immersive-ar',
        // Without an overlay the page is replaced by the camera feed and there
        // is no Exit button, no placement hint, and no way out but the system
        // back gesture. The root is mounted unconditionally so it is guaranteed
        // to be in the document at this instant; a detached root yields a
        // session whose `domOverlayState` is undefined.
        domOverlayRoot: overlayRef.current,
      });
    } catch (e) {
      setArPhase('off');
      if (isXrSessionError(e)) {
        setArError(e.message);
        return;
      }
      throw e;
    }

    // Registered before anything can fail, so every failure below unwinds
    // through exactly the same path as a normal exit. The live session is not
    // kept in a ref: `endXrSession()` already owns the one-at-a-time handle,
    // and a second copy here could only ever be the stale one.
    handle.onEnd(restoreFromAr);

    try {
      /*
        Resolve the reference space OURSELVES first, then tell three which one
        to use. three's `setSession` awaits
        `session.requestReferenceSpace(referenceSpaceType)` with a default of
        `local-floor` and rejects if it is refused — and `local-floor` is only
        an OPTIONAL feature, precisely so that a phone which has not found the
        floor yet still gets a session. Letting three ask blind converts that
        deliberate soft failure back into a hard one.
      */
      const { type } = await resolveReferenceSpace(handle.session);
      renderer.xr.setReferenceSpaceType(type);

      arRestoreRef.current = {
        position: camera.position.clone(),
        quaternion: camera.quaternion.clone(),
        fov: camera.fov,
        aspect: camera.aspect,
        near: camera.near,
        far: camera.far,
        zoom: camera.zoom,
        background: scene.background,
        clearAlpha: renderer.getClearAlpha(),
        gridVisible: gridRef.current ? gridRef.current.visible : true,
      };

      // The room has to show through. three builds the XR layer with
      // `alpha: true` regardless of how this renderer's own canvas context was
      // created, so clearing to a transparent black is all passthrough needs.
      scene.background = null;
      renderer.setClearAlpha(0);
      if (gridRef.current) gridRef.current.visible = false;
      // Hidden until it is placed: at identity the memory sits on the reference
      // space origin, which on a phone is roughly the user's own feet.
      if (memoryGroupRef.current) memoryGroupRef.current.visible = false;

      renderer.xr.enabled = true;
      arPresentingRef.current = true;
      await renderer.xr.setSession(handle.session);

      /*
        Hit testing against a ray straight out of the viewer, which is what
        makes the reticle sit under the middle of the screen. `hit-test` is a
        REQUIRED feature so `isFeatureEnabled` can prove it on a UA that does
        not report `enabledFeatures` — but the method itself is still optional
        in the type, and calling it unchecked on a runtime without the module
        throws inside a promise nobody is holding.
      */
      if (handle.isFeatureEnabled('hit-test') && typeof handle.session.requestHitTestSource === 'function') {
        const viewerSpace = await handle.session.requestReferenceSpace('viewer');
        const source = await handle.session.requestHitTestSource({ space: viewerSpace });
        hitTestSourceRef.current = source ?? null;
      }

      /*
        Re-check liveness before committing to the presenting UI.

        Everything above this point contains four awaits, and `onEnd` was
        registered before the first of them. If the session ends DURING one of
        those awaits and that await still resolves — a headset taken off, the
        user swiping away the AR view, the phone backgrounding — then
        `restoreFromAr` has already run, and falling through to
        `setArPhase('scanning')` would put the viewer back into the AR overlay
        with no session behind it: a reticle that never moves, an "Exit AR"
        button with nothing to exit, and orbit disabled.

        Cheaper and more honest than trying to make the restore re-entrant.
      */
      if (!handle.active) {
        restoreFromAr();
        return;
      }

      handle.session.addEventListener('select', placeAtReticle);
      setArPhase('scanning');
    } catch (e: any) {
      setArError(
        isXrSessionError(e) ? e.message : e?.message || 'The AR session could not be started.',
      );
      // `end()` never rejects, and ending fires `onEnd`, so the restore runs.
      await handle.end();
      /*
        Then unconditionally, because `onEnd` listeners fire AT MOST ONCE. A
        session that died between being granted and this block — a headset taken
        off mid-request — has already spent its one notification on the
        `handle.onEnd` registration above, which ran before any of the scene
        state below it was touched. Without this second call the viewer would be
        left backgroundless, gridless and with no session to end. The restore is
        idempotent, so the ordinary path pays nothing for it.
      */
      restoreFromAr();
    }
  }, [placeAtReticle, restoreFromAr, setArPhase]);

  const exitAr = useCallback(() => {
    void endXrSession();
  }, []);

  /** Back to hunting for a surface, keeping the yaw and scale the user chose. */
  const repositionAr = useCallback(() => {
    if (arPhaseRef.current !== 'placed') return;
    dragRef.current = null;
    twoFingerRef.current = null;
    pointersRef.current.clear();
    if (memoryGroupRef.current) memoryGroupRef.current.visible = false;
    setArPhase('scanning');
  }, [setArPhase]);

  /*
    Gestures.

    Attached to the DOM overlay rather than to the canvas because in a handheld
    AR session the canvas is not on screen — the UA composites the overlay
    subtree over the camera feed, and pointer events go to it. On a headset
    there is no overlay and therefore no gestures; placement there is the XR
    `select` event alone, which is why `select` and not a tap is what places.
  */
  const samplePointer = (e: React.PointerEvent<HTMLDivElement>): PointerSample => {
    const rect = overlayRectRef.current;
    // Canvas-relative, not page-relative: page coordinates offset every
    // placement by wherever the overlay happens to sit.
    return { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) };
  };

  const onOverlayPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (arPhaseRef.current !== 'placed' || !placementRef.current) return;
    overlayRectRef.current = e.currentTarget.getBoundingClientRect();
    pointersRef.current.set(e.pointerId, samplePointer(e));
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* Not every runtime implements capture on an overlay root; losing it only
         means a finger dragged off the element ends the gesture early. */
    }

    const view = pointerView();
    const points = Array.from(pointersRef.current.values());
    if (!view) return;
    if (points.length === 1) {
      dragRef.current = beginDrag(placementRef.current, points[0], view);
      twoFingerRef.current = null;
    } else if (points.length === 2) {
      twoFingerRef.current = beginTwoFinger(placementRef.current, points[0], points[1]);
      dragRef.current = null;
    }
  };

  const onOverlayPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!pointersRef.current.has(e.pointerId)) return;
    pointersRef.current.set(e.pointerId, samplePointer(e));
    const points = Array.from(pointersRef.current.values());

    if (points.length >= 2 && twoFingerRef.current) {
      // `limits` converts the pinch bounds from abstract multipliers into a
      // physical 5 cm - 20 m; omitting it leaves the pinch unbounded.
      commitPlacement(
        updateTwoFinger(twoFingerRef.current, points[0], points[1], arScaleRef.current?.limits),
      );
      return;
    }
    const view = pointerView();
    if (points.length === 1 && dragRef.current && view) {
      const next = updateDrag(dragRef.current, points[0], view);
      // `updateDrag` returns its origin BY REFERENCE when the ray misses the
      // surface (dragged above the horizon, or past 30 m), so identity is a
      // free "the drag went nowhere" test.
      if (next !== dragRef.current.origin) commitPlacement(next);
    }
  };

  const onOverlayPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!pointersRef.current.delete(e.pointerId)) return;
    const points = Array.from(pointersRef.current.values());
    const view = pointerView();
    twoFingerRef.current = null;
    dragRef.current = null;
    // Lifting one finger of a pinch leaves the other one dragging. Re-beginning
    // from the CURRENT placement is what stops the memory jumping back to where
    // the pinch started.
    if (points.length === 1 && placementRef.current && view) {
      dragRef.current = beginDrag(placementRef.current, points[0], view);
    }
  };

  /*
    Tapping an overlay button must not also place the memory.

    With `dom-overlay` the UA fires `beforexrselect` on the DOM element the
    touch landed on before it raises the XR `select`, and cancelling it
    suppresses the select. Only the control bar cancels: a tap anywhere else on
    the overlay is meant to reach the scene. Native listener because React has
    no synthetic event for this, and keyed on `arPhase` because the bar is only
    mounted during a session.
  */
  useEffect(() => {
    const bar = arControlsRef.current;
    if (!bar) return;
    const suppress = (e: Event) => e.preventDefault();
    bar.addEventListener('beforexrselect', suppress);
    return () => bar.removeEventListener('beforexrselect', suppress);
  }, [arPhase]);

  const arAvailable = Boolean(caps?.ar.supported);
  const showArEntry = assetReady && arPhase === 'off' && arAvailable;
  /*
    The honest note, and ONLY for iOS.

    A desktop Chrome user is not waiting for an AR button and does not need to
    be told their laptop has no headset, so `mode-unsupported` says nothing.
    `ios-no-webxr` is different: that user is holding a phone, AR is exactly
    what they expect a phone to do, and the answer is not "later" — no browser
    on iOS will ever have WebXR, because they all run Safari's engine. Saying
    nothing there reads as the app being broken, and the message points at the
    head-tracked window, which does work on iOS.
  */
  const iosNote =
    assetReady && arPhase === 'off' && caps && caps.ar.reason === 'ios-no-webxr'
      ? caps.ar.message
      : null;

  return (
    <div className={`relative ${className}`}>
      <div ref={containerRef} className="w-full h-full min-h-[500px] bg-ground rounded-lg overflow-hidden" />

      {/*
        The WebXR DOM overlay root.

        Mounted unconditionally and left empty outside a session, because
        `requestSession` needs an element that is already in the document — a
        root created at click time, or one behind `{arPhase !== 'off' && …}`, is
        null at the only moment it is read. Empty and `pointer-events-none`, so
        outside AR it is invisible to both the eye and the mouse and the canvas
        underneath keeps receiving orbit drags.
      */}
      <div
        ref={overlayRef}
        data-ar-overlay=""
        className={
          arPhase === 'off' ? 'pointer-events-none absolute inset-0' : 'absolute inset-0'
        }
        onPointerDown={arPhase === 'placed' ? onOverlayPointerDown : undefined}
        onPointerMove={arPhase === 'placed' ? onOverlayPointerMove : undefined}
        onPointerUp={arPhase === 'placed' ? onOverlayPointerUp : undefined}
        onPointerCancel={arPhase === 'placed' ? onOverlayPointerUp : undefined}
      >
        {arPhase !== 'off' && (
          <div ref={arControlsRef} className="flex items-start justify-between gap-3 p-4 text-white">
            <p className="max-w-[60%] rounded-lg bg-ground/60 px-3 py-2 text-sm leading-snug backdrop-blur">
              {arPhase === 'entering' && 'Starting AR…'}
              {arPhase === 'scanning' && (
                <span className="flex items-center gap-2">
                  <Scan size={16} aria-hidden="true" />
                  Point at a floor or table, then tap to place your memory.
                </span>
              )}
              {arPhase === 'placed' && (
                <span className="flex items-center gap-2">
                  <Hand size={16} aria-hidden="true" />
                  Drag to move. Pinch to resize, twist to turn.
                </span>
              )}
            </p>
            <div className="flex shrink-0 gap-2">
              {arPhase === 'placed' && (
                <button
                  type="button"
                  onClick={repositionAr}
                  className="rounded-full bg-white/15 px-3 py-2 text-sm backdrop-blur hover:bg-white/25"
                  title="Place it somewhere else"
                >
                  Move
                </button>
              )}
              <button
                type="button"
                onClick={exitAr}
                className="flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-2 text-sm backdrop-blur hover:bg-white/25"
                title="Exit AR"
              >
                <X size={16} aria-hidden="true" />
                Exit AR
              </button>
            </div>
          </div>
        )}
      </div>

      {/*
        AR entry. Rendered only on a CONFIRMED `immersive-ar` — `caps` is null
        until the async probe resolves and `supported` is only ever true after
        `isSessionSupported` returned exactly `true`, so headless Chromium (and
        therefore every product-video frame) never mounts this. Also gated on an
        asset actually being loaded: there is nothing to stand in the room until
        then.
      */}
      {showArEntry && (
        <button
          type="button"
          onClick={enterAr}
          title="View in AR"
          className="absolute bottom-4 right-4 flex items-center gap-2 rounded-full bg-primary-600 px-4 py-2 text-sm font-medium text-white shadow-lg transition-colors hover:bg-primary-500"
        >
          <Boxes size={18} aria-hidden="true" />
          View in your room
        </button>
      )}

      {iosNote && (
        <details className="absolute bottom-4 right-4 max-w-xs rounded-lg bg-ground/70 px-3 py-2 text-xs text-gray-300 backdrop-blur">
          <summary className="cursor-pointer list-none text-gray-200">
            AR is not available on iPhone or iPad
          </summary>
          <p className="mt-2 leading-snug">{iosNote}</p>
        </details>
      )}

      {arError && (
        <p
          role="alert"
          className="absolute bottom-16 right-4 max-w-xs rounded-lg bg-red-950/90 px-3 py-2 text-xs leading-snug text-red-200"
        >
          {arError}
        </p>
      )}

      {/*
        `data-splat-status` is the only machine-readable signal that the splat
        actually finished uploading. `canvas` appears the moment this component
        mounts — long before `loadData` resolves — so anything that waits on the
        canvas alone can photograph an empty #0c1018 frame and call it a success.
        The product-video capture waits on [data-splat-status="ready"] and then
        hides [data-splat-status] with an injected stylesheet (video/storyboard.json).
        It used to `mask` it instead, which paints an opaque #0A222E rectangle over
        the pill — visible inside the device frame for the whole viewer sequence.
      */}
      {(loading || error || info) && (
        <div
          data-splat-status={loading ? 'loading' : error ? 'error' : 'ready'}
          className={
            loading || error
              ? 'absolute bottom-4 left-4 bg-ground/70 text-white p-2 rounded text-sm pointer-events-none'
              : 'sr-only'
          }
          role={error ? 'alert' : undefined}
        >
          {loading && <div>Loading your memory…</div>}
          {error && <div className="text-red-300">Error: {error}</div>}
          {/*
            `info` is a developer readout ("Loaded 22400 splats"). It is never
            cleared, so it used to sit pinned over the viewer for the whole
            session in the shipped app. The product-video capture papered over
            it with an injected `[data-splat-status]{display:none}` stylesheet,
            which is masking a product defect in video/ rather than fixing it.
            The element stays mounted and keeps carrying `data-splat-status`,
            because that attribute is the capture's only reliable "the splat
            actually finished loading" signal — it is just no longer painted.
          */}
          {!loading && !error && info && <div>{info}</div>}
        </div>
      )}
    </div>
  );
};

export default SplatViewer;
