import React, { useState } from 'react';
import CommandForm from './components/CommandForm';
import SplatViewer from './components/SplatViewer';
import axios from 'axios';
import { useHeadTracking } from './hooks/useHeadTracking';

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

  const { headPosition } = useHeadTracking(isXREnabled);

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
           <div className="w-full h-full flex items-center justify-center opacity-20">
             <div className="text-center">
                <p className="text-4xl font-bold mb-4">ML Sharp Viewer</p>
                <p className="text-xl">Upload a file to begin</p>
             </div>
           </div>
        )}
      </div>

      {/* Overlay UI */}
      <div className="relative z-10 pointer-events-none flex flex-col h-screen">
        
        {/* Top Bar */}
        <div className="p-4 flex justify-between items-center bg-gradient-to-b from-black/70 to-transparent pointer-events-auto">
          <h1 className="text-2xl font-bold text-white drop-shadow-md">ML Sharp</h1>
          <div className="flex gap-3">
             <button 
                onClick={() => setIsXREnabled(!isXREnabled)} 
                className={`px-4 py-2 rounded font-medium transition-colors ${isXREnabled ? 'bg-green-600 hover:bg-green-700' : 'bg-gray-700 hover:bg-gray-600'} text-white`}
             >
               {isXREnabled ? 'XR Active' : 'Enable XR'}
             </button>
             <button 
                onClick={() => setIsDarkMode(!isDarkMode)} 
                className="px-4 py-2 rounded bg-gray-700 hover:bg-gray-600 text-white transition-colors"
             >
               {isDarkMode ? '☀️' : '🌙'}
             </button>
             <button 
                onClick={() => setShowControls(!showControls)} 
                className="px-4 py-2 rounded bg-blue-600 hover:bg-blue-700 text-white transition-colors"
             >
               {showControls ? 'Hide Controls' : 'Show Controls'}
             </button>
          </div>
        </div>

        {/* Controls Panel */}
        {showControls && (
          <div className={`absolute top-20 left-4 w-96 max-h-[85vh] overflow-y-auto rounded-lg shadow-2xl p-6 pointer-events-auto backdrop-blur-md border ${isDarkMode ? 'bg-gray-800/90 border-gray-700' : 'bg-white/90 border-gray-200'}`}>
            
            <div className="flex mb-6 border-b border-gray-500/30">
              <button
                className={`py-2 px-4 flex-1 font-medium ${activeTab === 'predict' ? 'border-b-2 border-blue-500 text-blue-500' : 'text-gray-500 hover:text-gray-400'}`}
                onClick={() => setActiveTab('predict')}
              >
                Predict
              </button>
              <button
                className={`py-2 px-4 flex-1 font-medium ${activeTab === 'render' ? 'border-b-2 border-blue-500 text-blue-500' : 'text-gray-500 hover:text-gray-400'}`}
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
              <div className="mt-6 p-4 bg-red-900/50 border border-red-700 text-red-200 rounded text-sm">
                <h3 className="font-bold mb-1">Error:</h3>
                <pre className="whitespace-pre-wrap font-mono">{error}</pre>
              </div>
            )}

            {output && (
              <div className="mt-6 p-4 bg-green-900/30 border border-green-700 text-green-200 rounded text-sm">
                <h3 className="font-bold mb-2">Success!</h3>
                <p className="mb-2">Job ID: {output.job_id}</p>
                
                <h4 className="font-semibold mt-2 mb-1">Output Files:</h4>
                <ul className="list-disc pl-5 mb-4 space-y-1">
                  {output.output_files.map((file: string) => (
                    <li key={file}>
                      <a 
                        href={`http://localhost:5001/api/download/${output.job_id}/${file}`}
                        className="text-blue-400 hover:underline break-all"
                        target="_blank"
                        rel="noreferrer"
                      >
                        {file}
                      </a>
                    </li>
                  ))}
                </ul>
                
                <h4 className="font-semibold mb-1">Logs:</h4>
                <pre className="bg-black/50 p-2 rounded text-xs overflow-x-auto max-h-40 font-mono">
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
