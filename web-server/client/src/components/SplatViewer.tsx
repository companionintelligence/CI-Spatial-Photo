import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
// @ts-ignore
import { SparkRenderer } from '@sparkjsdev/spark';
// @ts-ignore
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
// @ts-ignore
import { getFormatHandler } from '../formats/index.js';

interface SplatViewerProps {
  fileUrl?: string;
  file?: File;
  className?: string;
}

const SplatViewer: React.FC<SplatViewerProps> = ({ fileUrl, file, className }) => {
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
      renderer.setSize(clientWidth, clientHeight, false);
      camera.aspect = clientWidth / clientHeight;
      camera.updateProjectionMatrix();
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
        
        // Load Mesh
        // @ts-ignore
        const mesh = await formatHandler.loadData({ file: fileObj, bytes });

        if (currentMeshRef.current) {
            sceneRef.current.remove(currentMeshRef.current);
        }
        currentMeshRef.current = mesh;
        sceneRef.current.add(mesh);

        // Fit view
        if (mesh.getBoundingBox && cameraRef.current && controlsRef.current) {
            const box = mesh.getBoundingBox();
            const size = new THREE.Vector3();
            const center = new THREE.Vector3();
            box.getSize(size);
            box.getCenter(center);

            const radius = Math.max(size.length() * 0.5, 0.5);
            const dist = radius / Math.tan((cameraRef.current.fov * Math.PI) / 360);

            cameraRef.current.position.copy(center).add(new THREE.Vector3(dist, dist, dist));
            cameraRef.current.near = Math.max(0.01, radius * 0.01);
            cameraRef.current.far = Math.max(dist * 4, radius * 8);
            cameraRef.current.updateProjectionMatrix();

            controlsRef.current.target.copy(center);
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
      
      {(loading || error || info) && (
        <div className="absolute top-4 left-4 bg-black/70 text-white p-2 rounded text-sm pointer-events-none">
          {loading && <div>Loading...</div>}
          {error && <div className="text-red-400">Error: {error}</div>}
          {!loading && !error && info && <div>{info}</div>}
        </div>
      )}
    </div>
  );
};

export default SplatViewer;
