import pytest
import os
import shutil
import sys
from unittest.mock import patch, MagicMock

# Add parent directory to path to import app
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import app

@pytest.fixture
def client():
    app.config['TESTING'] = True
    app.config['UPLOAD_FOLDER'] = '/tmp/ml-sharp-test-uploads'
    app.config['OUTPUT_FOLDER'] = '/tmp/ml-sharp-test-outputs'
    os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)
    os.makedirs(app.config['OUTPUT_FOLDER'], exist_ok=True)
    
    with app.test_client() as client:
        yield client
        
    if os.path.exists(app.config['UPLOAD_FOLDER']):
        shutil.rmtree(app.config['UPLOAD_FOLDER'])
    if os.path.exists(app.config['OUTPUT_FOLDER']):
        shutil.rmtree(app.config['OUTPUT_FOLDER'])

def test_predict_no_file(client):
    response = client.post('/api/predict')
    assert response.status_code == 400
    assert b'No file part' in response.data

def test_render_no_file(client):
    response = client.post('/api/render')
    assert response.status_code == 400
    assert b'No file part' in response.data

@patch('subprocess.run')
def test_predict_success(mock_run, client):
    mock_run.return_value = MagicMock(stdout='Success', stderr='', returncode=0)
    
    # Create a dummy file
    data = {
        'file': (open(__file__, 'rb'), 'test.jpg'),
        'render': 'true',
        'device': 'cpu'
    }
    response = client.post('/api/predict', data=data, content_type='multipart/form-data')
    
    assert response.status_code == 200
    json_data = response.get_json()
    assert json_data['status'] == 'success'
    assert 'job_id' in json_data
    
    # Verify subprocess call
    args, kwargs = mock_run.call_args
    cmd = args[0]
    assert cmd[0] == 'sharp'
    assert cmd[1] == 'predict'
    assert '--render' in cmd
    assert 'cpu' in cmd

@patch('subprocess.run')
def test_render_success(mock_run, client):
    mock_run.return_value = MagicMock(stdout='Success', stderr='', returncode=0)
    
    data = {
        'file': (open(__file__, 'rb'), 'test.ply')
    }
    response = client.post('/api/render', data=data, content_type='multipart/form-data')
    
    assert response.status_code == 200
    json_data = response.get_json()
    assert json_data['status'] == 'success'
    
    # Verify subprocess call
    args, kwargs = mock_run.call_args
    cmd = args[0]
    assert cmd[0] == 'sharp'
    assert cmd[1] == 'render'
