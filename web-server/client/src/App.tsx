import React, { useState } from 'react';
import CommandForm from './components/CommandForm';
import axios from 'axios';

function App() {
  const [activeTab, setActiveTab] = useState<'predict' | 'render'>('predict');
  const [output, setOutput] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handlePredict = async (file: File, options: any) => {
    setLoading(true);
    setError(null);
    setOutput(null);
    
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
    <div className="min-h-screen bg-gray-100 p-8">
      <div className="max-w-4xl mx-auto bg-white rounded-lg shadow-md p-6">
        <h1 className="text-3xl font-bold mb-6 text-center text-gray-800">ML Sharp GUI</h1>
        
        <div className="flex mb-6 border-b">
          <button
            className={`py-2 px-4 ${activeTab === 'predict' ? 'border-b-2 border-blue-500 text-blue-600' : 'text-gray-500'}`}
            onClick={() => setActiveTab('predict')}
          >
            Predict
          </button>
          <button
            className={`py-2 px-4 ${activeTab === 'render' ? 'border-b-2 border-blue-500 text-blue-600' : 'text-gray-500'}`}
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
          <div className="mt-6 p-4 bg-red-100 text-red-700 rounded">
            <h3 className="font-bold">Error:</h3>
            <pre className="whitespace-pre-wrap">{error}</pre>
          </div>
        )}

        {output && (
          <div className="mt-6 p-4 bg-green-50 text-green-800 rounded">
            <h3 className="font-bold">Success!</h3>
            <p>Job ID: {output.job_id}</p>
            <h4 className="font-semibold mt-2">Output Files:</h4>
            <ul className="list-disc pl-5">
              {output.output_files.map((file: string) => (
                <li key={file}>
                  <a 
                    href={`http://localhost:5001/api/download/${output.job_id}/${file}`}
                    className="text-blue-600 hover:underline"
                    target="_blank"
                    rel="noreferrer"
                  >
                    {file}
                  </a>
                </li>
              ))}
            </ul>
            <h4 className="font-semibold mt-2">Logs:</h4>
            <pre className="bg-gray-800 text-white p-2 rounded mt-1 text-sm overflow-x-auto">
              {output.stdout}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
