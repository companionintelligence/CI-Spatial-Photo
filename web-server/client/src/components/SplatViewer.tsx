import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
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
import { computeOffAxisFrustum, makeOffAxisProjection, mapHeadPoseToEye } from '../utils/magicWindow';
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
  /** Centre of the glass. */
  center: THREE.Vector3;
  /** Distance from the calibrated eye to the glass. */
  distance: number;
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
  const distance = subjectDistance * WINDOW_DEPTH_FRACTION;

  return {
    position: camera.position.clone(),
    quaternion,
    right,
    up,
    normal: forward.clone().negate(),
    center: camera.position.clone().addScaledVector(forward, distance),
    distance,
  };
};

/**
 * Place the camera at the tracked eye and rebuild its projection so the four
 * corners of the glass stay welded to the four corners of the viewport.
 *
 * The camera's ORIENTATION never changes — that is the whole point, and the
 * difference between this and the `lookAt(0, 0, 0)` it replaces. A window does
 * not turn to follow you.
 */
const applyMagicWindow = (
  camera: THREE.PerspectiveCamera,
  anchor: WindowAnchor,
  tracker: HeadTracking,
  blend: number,
) => {
  const eye = mapHeadPoseToEye({
    pose: tracker.pose,
    windowDistance: anchor.distance,
    sensitivity: tracker.sensitivity,
    blend,
  });

  camera.position
    .copy(anchor.center)
    .addScaledVector(anchor.right, eye.x)
    .addScaledVector(anchor.up, eye.y)
    .addScaledVector(anchor.normal, eye.z);
  camera.quaternion.copy(anchor.quaternion);
  camera.updateMatrixWorld(true);

  // Recomputed per frame rather than stored on the anchor so that a window
  // resize — which changes `camera.aspect`, and `camera.fov` too on the
  // intrinsics path — is picked up without having to re-calibrate the user.
  const halfHeight = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * anchor.distance;
  const halfWidth = halfHeight * camera.aspect;

  makeOffAxisProjection(
    computeOffAxisFrustum({
      halfWidth,
      halfHeight,
      eye,
      near: camera.near,
      far: camera.far,
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
  const requestRef = useRef<number>();
  const currentMeshRef = useRef<any>(null);

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

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string>('');

  // Initialize Three.js
  useEffect(() => {
    if (!containerRef.current) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#0c1018");
    sceneRef.current = scene;

    const renderer = new THREE.WebGLRenderer({
      antialias: false,
      alpha: false,
    });
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
    scene.add(spark);
    sparkRef.current = spark;

    const grid = new THREE.GridHelper(GRID_BASE_SIZE, 10, 0x2a2f3a, 0x151822);
    grid.position.y = -0.5;
    scene.add(grid);
    gridRef.current = grid;

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
    */
    let lastFrameMs = performance.now();
    const animate = () => {
      requestRef.current = requestAnimationFrame(animate);

      const now = performance.now();
      // Clamped because a backgrounded tab resumes with a multi-second gap, and
      // the tracking fade would otherwise jump straight to its end state.
      const dt = Math.min(Math.max((now - lastFrameMs) / 1000, 0), 0.1);
      lastFrameMs = now;

      const tracker = trackerRef.current;
      if (tracker) {
        if (!anchorRef.current) {
          anchorRef.current = captureWindowAnchor(camera, controls.target);
        }
        const goal = tracker.pose.tracking ? 1 : 0;
        const step = dt / TRACKING_FADE_SECONDS;
        trackingBlendRef.current =
          goal > trackingBlendRef.current
            ? Math.min(goal, trackingBlendRef.current + step)
            : Math.max(goal, trackingBlendRef.current - step);
        applyMagicWindow(camera, anchorRef.current, tracker, trackingBlendRef.current);
      } else {
        controls.update();
      }

      renderer.render(scene, camera);
    };
    animate();

    const handleResize = () => {
      if (!containerRef.current || !renderer || !camera) return;
      const { clientWidth, clientHeight } = containerRef.current;
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
    handleResize();

    return () => {
      applyProjectionRef.current = null;
      window.removeEventListener('resize', handleResize);
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
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
        mesh.updateMatrixWorld(true);

        if (currentMeshRef.current) {
            sceneRef.current.remove(currentMeshRef.current);
        }
        currentMeshRef.current = mesh;
        sceneRef.current.add(mesh);

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

      } catch (err: any) {
        console.error(err);
        setError(err.message || 'Failed to load');
      } finally {
        setLoading(false);
      }
    };

    load();
  }, [fileUrl, file]);

  return (
    <div className={`relative ${className}`}>
      <div ref={containerRef} className="w-full h-full min-h-[500px] bg-black rounded-lg overflow-hidden" />
      
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
              ? 'absolute bottom-4 left-4 bg-black/70 text-white p-2 rounded text-sm pointer-events-none'
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
