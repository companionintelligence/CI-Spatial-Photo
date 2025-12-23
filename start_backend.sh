#!/bin/bash
set -e

# Ensure we are in the project root
cd "$(dirname "$0")"

echo "Installing project in editable mode..."
pip install -e .

echo "Installing backend dependencies..."
pip install -r frontend/backend/requirements.txt

echo "Starting Backend Server..."
export FLASK_APP=frontend/backend/app.py
export FLASK_ENV=development
python -m flask run --port 5000
