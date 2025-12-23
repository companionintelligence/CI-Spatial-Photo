import React, { useState } from 'react';
import FileUpload from './FileUpload';

interface CommandFormProps {
  type: 'predict' | 'render';
  onSubmit: (file: File, options: any) => void;
  loading: boolean;
}

const CommandForm: React.FC<CommandFormProps> = ({ type, onSubmit, loading }) => {
  const [file, setFile] = useState<File | null>(null);
  const [render, setRender] = useState(false);
  const [device, setDevice] = useState('default');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (file) {
      onSubmit(file, { render, device });
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Input File {type === 'predict' ? '(Image)' : '(.ply)'}
        </label>
        <FileUpload onFileSelect={setFile} selectedFile={file} />
      </div>

      {type === 'predict' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Device</label>
            <select
              value={device}
              onChange={(e) => setDevice(e.target.value)}
              className="w-full border-gray-300 rounded-md shadow-sm focus:border-blue-500 focus:ring-blue-500 p-2 border"
            >
              <option value="default">Default (Auto)</option>
              <option value="cuda">CUDA</option>
              <option value="mps">MPS (Mac)</option>
              <option value="cpu">CPU</option>
            </select>
          </div>
          
          <div className="flex items-center h-full pt-6">
            <input
              id="render-checkbox"
              type="checkbox"
              checked={render}
              onChange={(e) => setRender(e.target.checked)}
              className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
            />
            <label htmlFor="render-checkbox" className="ml-2 block text-sm text-gray-900">
              Render Trajectory (requires CUDA)
            </label>
          </div>
        </div>
      )}

      <button
        type="submit"
        disabled={!file || loading}
        className={`w-full flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white 
          ${!file || loading ? 'bg-gray-400 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500'}`}
      >
        {loading ? 'Processing...' : type === 'predict' ? 'Run Prediction' : 'Render Video'}
      </button>
    </form>
  );
};

export default CommandForm;
