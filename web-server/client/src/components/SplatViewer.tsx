import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
// @ts-ignore
import { SparkRenderer } from '@sparkjsdev/spark';
// @ts-ignore
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
// @ts-ignore
import { getFormatHandler } from '../formats/index.js';
import { makeAxisFlipCvToGl, computeMlSharpDepthFocus, makeProjectionFromIntrinsics } from '../utils/cameraUtils';
import { HeadPosition } from '../hooks/useHeadTracking';

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

    const grid = new THREE.GridHelper(2.5, 10, 0x2a2f3a, 0x151822);
    grid.position.y = -0.5;
    scene.add(grid);

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

        // Apply OpenCV to OpenGL flip (ml-sharp uses OpenCV coordinates)
        const cvToThree = makeAxisFlipCvToGl();
        mesh.applyMatrix4(cvToThree);
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
            // Fallback to fitting view (match browser-sharp behavior)
            const box = mesh.getBoundingBox();
            const size = new THREE.Vector3();
            const center = new THREE.Vector3();
            box.getSize(size);
            box.getCenter(center);
            
            const worldCenter = center.clone().applyMatrix4(mesh.matrixWorld);

            const radius = Math.max(size.length() * 0.5, 0.5);
            const dist = radius / Math.tan((cameraRef.current.fov * Math.PI) / 360);

            // browser-sharp uses (dist, dist, dist) offset
            cameraRef.current.position.copy(worldCenter).add(new THREE.Vector3(dist, dist, dist));
            cameraRef.current.lookAt(worldCenter);
            
            cameraRef.current.near = Math.max(0.01, radius * 0.01);
            cameraRef.current.far = Math.max(dist * 4, radius * 8);
            cameraRef.current.updateProjectionMatrix();

            controlsRef.current.target.copy(worldCenter);
            controlsRef.current.update();
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
        The product-video capture waits on [data-splat-status="ready"] and masks
        [data-splat-status] (video/storyboard.json).
      */}
      {(loading || error || info) && (
        <div
          data-splat-status={loading ? 'loading' : error ? 'error' : 'ready'}
          className="absolute bottom-4 left-4 bg-black/70 text-white p-2 rounded text-sm pointer-events-none"
        >
          {loading && <div>Loading...</div>}
          {error && <div className="text-red-400">Error: {error}</div>}
          {!loading && !error && info && <div>{info}</div>}
        </div>
      )}
    </div>
  );
};

export default SplatViewer;
