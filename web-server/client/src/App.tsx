import React, { useState, useEffect, useRef } from 'react';
import CommandForm from './components/CommandForm';
import SplatViewer from './components/SplatViewer';
import axios from 'axios';
import { useHeadTracking } from './hooks/useHeadTracking';
// import { Sun, Moon, Eye, EyeOff, Settings, Video, VideoOff } from 'lucide-react';

function App() {
  const [activeTab, setActiveTab] = useState<'predict' | 'render'>('predict');
  const [output, setOutput] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plyUrl, setPlyUrl] = useState<string | null>(null);
  
  // UI State
  const [isDarkMode, setIsDarkMode] = useState(true);
  const [isXREnabled, setIsXREnabled] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [showWebcamPreview, setShowWebcamPreview] = useState(true);

  const { headPosition, videoRef } = useHeadTracking(isXREnabled);
  const webcamContainerRef = useRef<HTMLDivElement>(null);

  // Handle webcam preview attachment
  useEffect(() => {
    if (isXREnabled && videoRef.current && webcamContainerRef.current) {
      // Clear previous content
      webcamContainerRef.current.innerHTML = '';
      // Append video element
      videoRef.current.style.width = '100%';
      videoRef.current.style.height = '100%';
      videoRef.current.style.objectFit = 'cover';
      videoRef.current.style.transform = 'scaleX(-1)'; // Mirror effect
      webcamContainerRef.current.appendChild(videoRef.current);
    }
  }, [isXREnabled, videoRef, showWebcamPreview]);

  const handlePredict = async (file: File, options: any) => {
    setLoading(true);
    setError(null);
    setOutput(null);
    setPlyUrl(null);
    
    const formData = new FormData();
    formData.append('file', file);
    formData.append('render', options.render);
    formData.append('device', options.device);

    try {
      const response = await axios.post('http://localhost:5001/api/predict', formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
      });
      setOutput(response.data);

      // Check for PLY file
      const plyFile = response.data.output_files.find((f: string) => f.endsWith('.ply'));
      if (plyFile) {
        setPlyUrl(`http://localhost:5001/api/download/${response.data.job_id}/${plyFile}`);
      }
    } catch (err: any) {
      setError(err.response?.data?.stderr || err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleRender = async (file: File, options: any) => {
    setLoading(true);
    setError(null);
    setOutput(null);

    const formData = new FormData();
    formData.append('file', file);

    try {
      const response = await axios.post('http://localhost:5001/api/render', formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
      });
      setOutput(response.data);
    } catch (err: any) {
      setError(err.response?.data?.stderr || err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={`min-h-screen transition-colors duration-300 ${isDarkMode ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-900'}`}>
      
      {/* Main Viewer Area - Full Screen Background */}
      <div className="absolute inset-0 z-0 overflow-hidden bg-black">
        {plyUrl ? (
           <SplatViewer 
             fileUrl={plyUrl} 
             className="w-full h-full" 
             headPosition={isXREnabled ? headPosition : null}
           />
        ) : (
           <div className="flex items-center justify-center w-full h-full opacity-20">
             <div className="text-center">
                <p className="mb-4 text-4xl font-bold">ML Sharp Viewer</p>
                <p className="text-xl">Upload a file to begin</p>
             </div>
           </div>
        )}
      </div>

      {/* Overlay UI */}
      <div className="relative z-10 flex flex-col h-screen pointer-events-none">
        
        {/* Top Bar */}
        <div className="flex items-center justify-between p-4 pointer-events-auto bg-gradient-to-b from-black/70 to-transparent">
          <h1 className="text-2xl font-bold text-white drop-shadow-md flex items-center gap-2">
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
              <span className="text-lg">⚡</span>
            </div>
            ML Sharp
          </h1>
          <div className="flex gap-3">
             <button 
                onClick={() => setIsXREnabled(!isXREnabled)} 
                className={`px-4 py-2 rounded-full font-medium transition-all flex items-center gap-2 ${isXREnabled ? 'bg-green-600 hover:bg-green-700 shadow-[0_0_15px_rgba(22,163,74,0.5)]' : 'bg-gray-800/80 hover:bg-gray-700 backdrop-blur-sm'} text-white border border-white/10`}
             >
               {/* {isXREnabled ? <Video size={18} /> : <VideoOff size={18} />} */}
               <span className="hidden sm:inline">{isXREnabled ? 'XR Active' : 'Enable XR'}</span>
             </button>
             
             <button 
                onClick={() => setIsDarkMode(!isDarkMode)} 
                className="p-2 text-white transition-colors rounded-full bg-gray-800/80 hover:bg-gray-700 backdrop-blur-sm border border-white/10"
                title={isDarkMode ? "Switch to Light Mode" : "Switch to Dark Mode"}
             >
               {/* {isDarkMode ? <Sun size={20} /> : <Moon size={20} />} */}
               {isDarkMode ? '☀️' : '🌙'}
             </button>
             
             <button 
                onClick={() => setShowControls(!showControls)} 
                className="p-2 text-white transition-colors rounded-full bg-blue-600/90 hover:bg-blue-700 backdrop-blur-sm shadow-lg"
                title={showControls ? "Hide Controls" : "Show Controls"}
             >
               {/* {showControls ? <EyeOff size={20} /> : <Settings size={20} />} */}
               {showControls ? 'Hide' : 'Show'}
             </button>
          </div>
        </div>

        {/* Webcam Preview Thumbnail */}
        {isXREnabled && (
          <div className="absolute top-20 right-4 pointer-events-auto">
            <div className={`relative transition-all duration-300 overflow-hidden rounded-lg border-2 border-white/20 shadow-2xl bg-black ${showWebcamPreview ? 'w-48 h-36' : 'w-12 h-12 rounded-full'}`}>
              <div ref={webcamContainerRef} className={`w-full h-full ${showWebcamPreview ? 'opacity-100' : 'opacity-0'}`} />
              
              <button 
                onClick={() => setShowWebcamPreview(!showWebcamPreview)}
                className="absolute bottom-2 right-2 p-1.5 bg-black/50 hover:bg-black/70 text-white rounded-full backdrop-blur-sm transition-colors z-20"
              >
                {/* {showWebcamPreview ? <EyeOff size={14} /> : <Eye size={14} />} */}
                {showWebcamPreview ? 'Hide' : 'Show'}
              </button>

              {!showWebcamPreview && (
                <div className="absolute inset-0 flex items-center justify-center text-green-500">
                  {/* <Video size={20} /> */}
                  <span>📷</span>
                </div>
              )}
            </div>
            {headPosition && showWebcamPreview && (
              <div className="mt-2 text-xs text-white/70 text-right font-mono bg-black/50 p-1 rounded inline-block float-right backdrop-blur-sm">
                x: {headPosition.x.toFixed(2)} y: {headPosition.y.toFixed(2)} z: {headPosition.z.toFixed(2)}
              </div>
            )}
          </div>
        )}

        {/* Controls Panel */}
        {showControls && (
          <div className={`absolute top-20 left-4 w-full sm:w-96 max-h-[calc(100vh-6rem)] overflow-y-auto rounded-xl shadow-2xl p-6 pointer-events-auto backdrop-blur-md border transition-all duration-300 ${isDarkMode ? 'bg-gray-900/90 border-gray-700' : 'bg-white/90 border-gray-200'}`}>
            
            <div className="flex mb-6 border-b border-gray-500/30">
              <button
                className={`py-2 px-4 flex-1 font-medium transition-colors ${activeTab === 'predict' ? 'border-b-2 border-blue-500 text-blue-500' : 'text-gray-500 hover:text-gray-400'}`}
                onClick={() => setActiveTab('predict')}
              >
                Predict
              </button>
              <button
                className={`py-2 px-4 flex-1 font-medium transition-colors ${activeTab === 'render' ? 'border-b-2 border-blue-500 text-blue-500' : 'text-gray-500 hover:text-gray-400'}`}
                onClick={() => setActiveTab('render')}
              >
                Render
              </button>
            </div>

            {activeTab === 'predict' && (
              <CommandForm 
                type="predict" 
                onSubmit={handlePredict} 
                loading={loading}
              />
            )}

            {activeTab === 'render' && (
              <CommandForm 
                type="render" 
                onSubmit={handleRender} 
                loading={loading}
              />
            )}

            {error && (
              <div className="p-4 mt-6 text-sm text-red-200 border border-red-700 rounded-lg bg-red-900/50 animate-pulse">
                <h3 className="mb-1 font-bold flex items-center gap-2">
                  <span>⚠️</span> Error
                </h3>
                <pre className="font-mono whitespace-pre-wrap">{error}</pre>
              </div>
            )}

            {output && (
              <div className="p-4 mt-6 text-sm text-green-200 border border-green-700 rounded-lg bg-green-900/30">
                <h3 className="mb-2 font-bold flex items-center gap-2">
                  <span>✅</span> Success
                </h3>
                <p className="mb-2 text-xs opacity-70">Job ID: {output.job_id}</p>
                
                <h4 className="mt-2 mb-1 font-semibold">Output Files:</h4>
                <ul className="pl-5 mb-4 space-y-1 list-disc">
                  {output.output_files.map((file: string) => (
                    <li key={file}>
                      <a 
                        href={`http://localhost:5001/api/download/${output.job_id}/${file}`}
                        className="text-blue-400 break-all hover:underline hover:text-blue-300 transition-colors"
                        target="_blank"
                        rel="noreferrer"
                      >
                        {file}
                      </a>
                    </li>
                  ))}
                </ul>
                
                <h4 className="mb-1 font-semibold">Logs:</h4>
                <pre className="p-2 overflow-x-auto font-mono text-xs rounded bg-black/50 max-h-40 scrollbar-thin scrollbar-thumb-gray-700 scrollbar-track-transparent">
                  {output.stdout}
                </pre>
              </div>
            )}
          </div>
        )}
        
      </div>
    </div>
  );
}

export default App;
