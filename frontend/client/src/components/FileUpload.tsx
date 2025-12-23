import React, { useCallback } from 'react';
import { useDropzone } from 'react-dropzone';

interface FileUploadProps {
  onFileSelect: (file: File) => void;
  selectedFile: File | null;
}

const FileUpload: React.FC<FileUploadProps> = ({ onFileSelect, selectedFile }) => {
  const onDrop = useCallback((acceptedFiles: File[]) => {
    if (acceptedFiles.length > 0) {
      onFileSelect(acceptedFiles[0]);
    }
  }, [onFileSelect]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({ 
    onDrop,
    multiple: false
  });

  return (
    <div 
      {...getRootProps()} 
      className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors
        ${isDragActive ? 'border-blue-500 bg-blue-50' : 'border-gray-300 hover:border-blue-400'}`}
    >
      <input {...getInputProps()} />
      {selectedFile ? (
        <div>
          <p className="text-green-600 font-medium">Selected: {selectedFile.name}</p>
          <p className="text-sm text-gray-500 mt-1">Click or drag to replace</p>
        </div>
      ) : (
        <div>
          {isDragActive ? (
            <p className="text-blue-500">Drop the file here ...</p>
          ) : (
            <p className="text-gray-500">Drag 'n' drop a file here, or click to select file</p>
          )}
          <p className="text-xs text-gray-400 mt-2">Supports images (Predict) or .ply (Render)</p>
        </div>
      )}
    </div>
  );
};

export default FileUpload;
