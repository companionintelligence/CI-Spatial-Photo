import React, { useState } from 'react';
import CommandForm from './CommandForm';

interface ControlsPanelProps {
  isDarkMode: boolean;
  onPredict: (file: File, options: any) => Promise<void>;
  onRender: (file: File, options: any) => Promise<void>;
  loading: boolean;
  error: string | null;
  output: any;
}

const ControlsPanel: React.FC<ControlsPanelProps> = ({
  isDarkMode,
  onPredict,
  onRender,
  loading,
  error,
  output
}) => {
  const [activeTab, setActiveTab] = useState<'predict' | 'render'>('predict');

  return (
    <div className={`
      absolute top-20 left-4 right-4 md:right-auto md:w-96 
      max-h-[80vh] overflow-y-auto rounded-lg shadow-2xl p-6 
      pointer-events-auto backdrop-blur-md border 
      ${isDarkMode ? 'bg-gray-800/90 border-gray-700' : 'bg-white/90 border-gray-200'}
      transition-all duration-300 ease-in-out
    `}>
      
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
          onSubmit={onPredict} 
          loading={loading}
        />
      )}

      {activeTab === 'render' && (
        <CommandForm 
          type="render" 
          onSubmit={onRender} 
          loading={loading}
        />
      )}

      {error && (
        <div className="p-4 mt-6 text-sm text-red-200 border border-red-700 rounded bg-red-900/50">
          <h3 className="mb-1 font-bold">Error:</h3>
          <pre className="font-mono whitespace-pre-wrap break-words">{error}</pre>
        </div>
      )}

      {output && (
        <div className="p-4 mt-6 text-sm text-green-200 border border-green-700 rounded bg-green-900/30">
          <h3 className="mb-2 font-bold">Success!</h3>
          <p className="mb-2">Job ID: {output.job_id}</p>
          
          <h4 className="mt-2 mb-1 font-semibold">Output Files:</h4>
          <ul className="pl-5 mb-4 space-y-1 list-disc">
            {output.output_files.map((file: string) => (
              <li key={file}>
                <a 
                  href={`http://localhost:5001/api/download/${output.job_id}/${file}`}
                  className="text-blue-400 break-all hover:underline"
                  target="_blank"
                  rel="noreferrer"
                >
                  {file}
                </a>
              </li>
            ))}
          </ul>
          
          <h4 className="mb-1 font-semibold">Logs:</h4>
          <pre className="p-2 overflow-x-auto font-mono text-xs rounded bg-black/50 max-h-40">
            {output.stdout}
          </pre>
        </div>
      )}
    </div>
  );
};

export default ControlsPanel;
