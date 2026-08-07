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
import { HeadPosition } from '../hooks/useHeadTracking';

/** Ground plane, in units of the subject's widest horizontal dimension. */
const GRID_SPAN_FACTOR = 2.4;
/** The GridHelper is built at this size, so scaling is relative to it. */
const GRID_BASE_SIZE = 2.5;

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
  headPosition?: HeadPosition | null;
}

const SplatViewer: React.FC<SplatViewerProps> = ({ fileUrl, file, className, headPosition }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const sparkRef = useRef<any>(null);
  const gridRef = useRef<THREE.GridHelper | null>(null);
  const requestRef = useRef<number>();
  const currentMeshRef = useRef<any>(null);
  
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

    const animate = () => {
      requestRef.current = requestAnimationFrame(animate);
      controls.update();
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
    window.addEventListener('resize', handleResize);
    handleResize();

    return () => {
      window.removeEventListener('resize', handleResize);
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
      if (renderer) {
        renderer.dispose();
        container?.removeChild(renderer.domElement);
      }
      if (spark) (spark as any).dispose?.();
    };
  }, []);

  // Handle Head Tracking
  useEffect(() => {
    if (!cameraRef.current || !headPosition) return;

    const camera = cameraRef.current;
    
    // Scale factors - tune these for better feel
    const movementScale = 2.0; 
    const depthScale = 5.0;
    const baseDistance = 2.5;

    // Update position
    const x = headPosition.x * movementScale;
    const y = headPosition.y * movementScale;
    const z = baseDistance + (headPosition.z * depthScale);

    camera.position.set(x, y, Math.max(0.5, z));
    camera.lookAt(0, 0, 0);
    
  }, [headPosition]);

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

             // Use metadata if available
             const { intrinsics, extrinsicCv } = cameraMetadata;
             
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

             controlsRef.current.enabled = true;
             controlsRef.current.update();
             
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
