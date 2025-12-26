import { useEffect, useRef, useState } from 'react';
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

export interface HeadPosition {
  x: number; // -1 to 1 (left to right)
  y: number; // -1 to 1 (bottom to top)
  z: number; // distance factor (approximate)
}

export const useHeadTracking = (enabled: boolean) => {
  const [headPosition, setHeadPosition] = useState<HeadPosition | null>(null);
  const [isReady, setIsReady] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const landmarkerRef = useRef<FaceLandmarker | null>(null);
  const requestRef = useRef<number>();

  useEffect(() => {
    if (!enabled) {
      if (videoRef.current && videoRef.current.srcObject) {
        const tracks = (videoRef.current.srcObject as MediaStream).getTracks();
        tracks.forEach(track => track.stop());
        videoRef.current.srcObject = null;
      }
      return;
    }

    const predictWebcam = () => {
      const video = videoRef.current;
      const landmarker = landmarkerRef.current;

      if (video && landmarker && video.currentTime > 0) {
        const startTimeMs = performance.now();
        const results = landmarker.detectForVideo(video, startTimeMs);

        if (results.faceLandmarks && results.faceLandmarks.length > 0) {
          const landmarks = results.faceLandmarks[0];
          const nose = landmarks[1];
          
          // Invert X because webcam is mirrored usually
          // MediaPipe x: 0 (left) -> 1 (right)
          // We want -1 (left) -> 1 (right)
          // But webcam is mirrored, so if I move left, image moves right.
          // Let's assume standard mirror behavior:
          // Real Left -> Image Right (x > 0.5)
          // We want Real Left to be negative X.
          // So (0.5 - x) * scale
          
          const x = (0.5 - nose.x) * 2; 
          const y = (0.5 - nose.y) * 2; // y is 0 at top, 1 at bottom. We want + at top.
          const z = nose.z; 

          setHeadPosition({ x, y, z });
        }
      }

      if (enabled) {
        requestRef.current = requestAnimationFrame(predictWebcam);
      }
    };

    const init = async () => {
      const vision = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0/wasm"
      );
      
      landmarkerRef.current = await FaceLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: `https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task`,
          delegate: "GPU"
        },
        outputFaceBlendshapes: true,
        runningMode: "VIDEO",
        numFaces: 1
      });

      const video = document.createElement('video');
      video.autoplay = true;
      video.playsInline = true;
      videoRef.current = video;

      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        video.srcObject = stream;
        video.addEventListener('loadeddata', predictWebcam);
        setIsReady(true);
      } catch (err) {
        console.error("Error accessing webcam:", err);
      }
    };

    init();

    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
      if (videoRef.current && videoRef.current.srcObject) {
        const tracks = (videoRef.current.srcObject as MediaStream).getTracks();
        tracks.forEach(track => track.stop());
      }
    };
  }, [enabled]);

  return { headPosition, isReady, videoRef };
};
