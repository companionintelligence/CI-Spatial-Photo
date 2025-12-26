import React, { useState, useEffect } from 'react';
import SplatViewer from './components/SplatViewer';
import TopBar from './components/TopBar';
import ControlsPanel from './components/ControlsPanel';
import axios from 'axios';
import { useHeadTracking } from './hooks/useHeadTracking';

function App() {
  const [output, setOutput] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plyUrl, setPlyUrl] = useState<string | null>(null);
  
  // UI State
  const [isDarkMode, setIsDarkMode] = useState(true);
  const [isXREnabled, setIsXREnabled] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);

  const { headPosition, videoRef } = useHeadTracking(isXREnabled);

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const handlePredict = async (file: File, options: any) => {
    setLoading(true);
    setError(null);
    setOutput(null);
    setPlyUrl(null);
    if (isMobile) setShowControls(false); // Auto hide on mobile
    
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
    if (isMobile) setShowControls(false);

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
        
        <TopBar 
          isXREnabled={isXREnabled}
          setIsXREnabled={setIsXREnabled}
          isDarkMode={isDarkMode}
          setIsDarkMode={setIsDarkMode}
          showControls={showControls}
          setShowControls={setShowControls}
          headPosition={headPosition}
          videoRef={videoRef}
        />

        {showControls && (
          <ControlsPanel 
            isDarkMode={isDarkMode}
            onPredict={handlePredict}
            onRender={handleRender}
            loading={loading}
            error={error}
            output={output}
          />
        )}
        
      </div>
    </div>
  );
}

export default App;
