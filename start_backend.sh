#!/bin/bash
# set -e

# Ensure we are in the project root
# cd "$(dirname "$0")"

# echo "Installing project in editable mode..."
# pip install -e .

# echo "Installing backend dependencies..."
# pip install -r web-server/backend/requirements.txt

echo "Starting Backend Server..."
export FLASK_APP=web-server/backend/app.py
export FLASK_ENV=development

# Ensure we use the same python environment as pip
PIP_PATH=$(which pip)
PYTHON_PATH="$(dirname "$PIP_PATH")/python"
echo "Using Python: $PYTHON_PATH"

"$PYTHON_PATH" -m flask run --port 5001
