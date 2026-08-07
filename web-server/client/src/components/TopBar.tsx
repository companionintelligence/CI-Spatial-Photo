import React, { useRef, useEffect } from 'react';
import { Sun, Moon, Eye, EyeOff, Settings, X } from 'lucide-react';
import { HeadPosition } from '../hooks/useHeadTracking';

interface TopBarProps {
  isXREnabled: boolean;
  setIsXREnabled: (enabled: boolean) => void;
  isDarkMode: boolean;
  setIsDarkMode: (enabled: boolean) => void;
  showControls: boolean;
  setShowControls: (show: boolean) => void;
  headPosition: HeadPosition | null;
  videoRef: React.RefObject<HTMLVideoElement>;
}

const TopBar: React.FC<TopBarProps> = ({
  isXREnabled,
  setIsXREnabled,
  isDarkMode,
  setIsDarkMode,
  showControls,
  setShowControls,
  headPosition,
  videoRef
}) => {
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);

  // Draw webcam preview to canvas
  useEffect(() => {
    if (!isXREnabled || !videoRef.current || !previewCanvasRef.current) return;
    
    const video = videoRef.current;
    const canvas = previewCanvasRef.current;
    const ctx = canvas.getContext('2d');
    let animationId: number;

    const draw = () => {
      if (video.readyState === video.HAVE_ENOUGH_DATA && ctx) {
        // Mirror the video
        ctx.save();
        ctx.scale(-1, 1);
        ctx.drawImage(video, -canvas.width, 0, canvas.width, canvas.height);
        ctx.restore();
        
        // Draw face tracking indicator if available
        if (headPosition) {
           const x = (1 - (headPosition.x / 2 + 0.5)) * canvas.width; // Map back to 0-1 then to width
           const y = (headPosition.y / 2 + 0.5) * canvas.height;
           
           ctx.beginPath();
           ctx.arc(x, y, 5, 0, 2 * Math.PI);
           ctx.fillStyle = '#00ff00';
           ctx.fill();
        }
      }
      animationId = requestAnimationFrame(draw);
    };
    
    draw();
    
    return () => cancelAnimationFrame(animationId);
  }, [isXREnabled, headPosition, videoRef]);

  return (
    <div className="flex items-center justify-between p-4 pointer-events-auto bg-gradient-to-b from-black/70 to-transparent">
      {/* Product name, not the repo name — this string is on camera in every
          product-video frame (video/storyboard.json, CI-Common video-kit
          MESSAGING.md "Naming"). */}
      <h1 className="min-w-0 truncate text-2xl font-bold text-white drop-shadow-md">Photo Time Machine</h1>
      <div className="flex shrink-0 gap-3 pl-3">
         {isXREnabled && (
           <div className="relative w-24 h-16 overflow-hidden border border-green-500 rounded bg-black/50">
             <canvas ref={previewCanvasRef} width={160} height={120} className="w-full h-full object-cover" />
           </div>
         )}
         
         <button 
            onClick={() => setIsXREnabled(!isXREnabled)} 
            className={`p-2 rounded-full transition-colors ${isXREnabled ? 'bg-green-600 hover:bg-green-700' : 'bg-gray-700 hover:bg-gray-600'} text-white`}
            title={isXREnabled ? "Disable XR" : "Enable XR"}
         >
           {isXREnabled ? <Eye size={20} /> : <EyeOff size={20} />}
         </button>
         <button 
            onClick={() => setIsDarkMode(!isDarkMode)} 
            className="p-2 text-white transition-colors bg-gray-700 rounded-full hover:bg-gray-600"
            title="Toggle Theme"
         >
           {isDarkMode ? <Sun size={20} /> : <Moon size={20} />}
         </button>
         <button 
            onClick={() => setShowControls(!showControls)} 
            className="p-2 text-white transition-colors bg-blue-600 rounded-full hover:bg-blue-700"
            title="Toggle Controls"
         >
           {showControls ? <X size={20} /> : <Settings size={20} />}
         </button>
      </div>
    </div>
  );
};

export default TopBar;
