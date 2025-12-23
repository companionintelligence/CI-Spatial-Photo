import os
import subprocess
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from werkzeug.utils import secure_filename
import uuid
import shutil

app = Flask(__name__)
CORS(app)

UPLOAD_FOLDER = '/tmp/ml-sharp-uploads'
OUTPUT_FOLDER = '/tmp/ml-sharp-outputs'
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
os.makedirs(OUTPUT_FOLDER, exist_ok=True)

app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER
app.config['OUTPUT_FOLDER'] = OUTPUT_FOLDER

@app.route('/api/predict', methods=['POST'])
def predict():
    if 'file' not in request.files:
        return jsonify({'error': 'No file part'}), 400
    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': 'No selected file'}), 400
    
    job_id = str(uuid.uuid4())
    job_upload_dir = os.path.join(app.config['UPLOAD_FOLDER'], job_id)
    job_output_dir = os.path.join(app.config['OUTPUT_FOLDER'], job_id)
    os.makedirs(job_upload_dir, exist_ok=True)
    os.makedirs(job_output_dir, exist_ok=True)
    
    filename = secure_filename(file.filename)
    input_path = os.path.join(job_upload_dir, filename)
    file.save(input_path)
    
    render = request.form.get('render') == 'true'
    device = request.form.get('device', 'default')
    
    # Assuming 'sharp' is in the PATH. If running from source, might need to adjust.
    cmd = ['sharp', 'predict', '-i', input_path, '-o', job_output_dir, '--device', device]
    if render:
        cmd.append('--render')
        
    try:
        # Using subprocess to call the CLI tool
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        
        # List output files
        output_files = os.listdir(job_output_dir)
        return jsonify({
            'status': 'success',
            'job_id': job_id,
            'output_files': output_files,
            'stdout': result.stdout,
            'stderr': result.stderr
        })
    except subprocess.CalledProcessError as e:
        return jsonify({
            'status': 'error',
            'stdout': e.stdout,
            'stderr': e.stderr
        }), 500

@app.route('/api/render', methods=['POST'])
def render():
    if 'file' not in request.files:
        return jsonify({'error': 'No file part'}), 400
    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': 'No selected file'}), 400
        
    job_id = str(uuid.uuid4())
    job_upload_dir = os.path.join(app.config['UPLOAD_FOLDER'], job_id)
    job_output_dir = os.path.join(app.config['OUTPUT_FOLDER'], job_id)
    os.makedirs(job_upload_dir, exist_ok=True)
    os.makedirs(job_output_dir, exist_ok=True)
    
    filename = secure_filename(file.filename)
    input_path = os.path.join(job_upload_dir, filename)
    file.save(input_path)
    
    cmd = ['sharp', 'render', '-i', input_path, '-o', job_output_dir]
    
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        
        output_files = os.listdir(job_output_dir)
        return jsonify({
            'status': 'success',
            'job_id': job_id,
            'output_files': output_files,
            'stdout': result.stdout,
            'stderr': result.stderr
        })
    except subprocess.CalledProcessError as e:
        return jsonify({
            'status': 'error',
            'stdout': e.stdout,
            'stderr': e.stderr
        }), 500

@app.route('/api/download/<job_id>/<filename>', methods=['GET'])
def download_file(job_id, filename):
    return send_from_directory(os.path.join(app.config['OUTPUT_FOLDER'], job_id), filename)

if __name__ == '__main__':
    app.run(debug=True, port=5000)
