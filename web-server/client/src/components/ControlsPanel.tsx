import React, { useState } from 'react';
import CommandForm from './CommandForm';

const appRedesignReviews = [
  {
    name: 'ml-sharp',
    focus: 'single-scene Gaussian Splatting baseline and viewer integration'
  },
  {
    name: 'ml-sharp web setup',
    focus: 'one-click packaging reference for capture, processing, and download flows'
  },
  {
    name: '4DGS-Video-Generator',
    focus: 'dynamic 4D reconstruction for motion-heavy clips and temporal playback'
  },
  {
    name: 'video-3d-reconstruction-gsplat',
    focus: 'video-to-3D reconstruction path for richer scene recovery and export'
  }
];

const appRedesignStrategy = [
  'Route single-image inputs through SHARP, multi-view/static video through gsplat reconstruction, and dynamic footage through a 4DGS pipeline.',
  'Standardize outputs as splats, preview videos, and camera metadata so the same assets can feed both the web viewer and a desktop creator workflow.',
  'Extend the XR viewer into an AR magic portal mode that combines head tracking, portal framing, and timeline controls for 4D playback.'
];

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

      <section
        aria-label="App 2.0 redesign plan"
        className={`mt-6 rounded-lg border p-4 text-sm ${
          isDarkMode
            ? 'border-blue-500/30 bg-blue-950/40 text-blue-50'
            : 'border-blue-200 bg-blue-50 text-slate-800'
        }`}
      >
        <h3 className="font-bold">App 2.0 redesign plan</h3>
        <p className="mt-2 leading-6">
          Reviewed 3D/4D pipelines for a web and desktop media workflow that can evolve into an
          AR magic portal viewer.
        </p>

        <h4 className="mt-4 font-semibold">Reviewed systems</h4>
        <ul className="mt-2 space-y-2">
          {appRedesignReviews.map((review) => (
            <li key={review.name}>
              <span className="font-semibold">{review.name}:</span> {review.focus}
            </li>
          ))}
        </ul>

        <h4 className="mt-4 font-semibold">Recommended strategy</h4>
        <ol className="mt-2 space-y-2 list-decimal pl-5">
          {appRedesignStrategy.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ol>
      </section>

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
