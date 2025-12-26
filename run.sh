#!/bin/bash

# Exit on error
set -e

# Get script directory to ensure we run from the correct location
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

# Cleanup function to kill background processes on exit
cleanup() {
    echo ""
    echo "Shutting down servers..."
    # Kill all child processes in the same process group
    kill $(jobs -p) 2>/dev/null || true
}

# Set up traps for cleanup
trap cleanup EXIT INT TERM

echo "========================================"
echo "   ML Sharp Web Server Setup & Run"
echo "========================================"

# Check for Python/Conda environment
if [[ -z "$CONDA_DEFAULT_ENV" ]]; then
    echo "WARNING: No Conda environment detected."
    echo "It is recommended to run: conda activate sharp"
    echo "Press Enter to continue anyway, or Ctrl+C to abort."
    read
fi

# 1. Backend Setup & Run
echo ""
echo "[1/2] Starting Backend..."
cd web-server/backend

# Install dependencies (quietly)
echo "Installing backend dependencies..."
pip install -r requirements.txt > /dev/null

# Start Flask server in background
echo "Starting Flask server on port 5001..."
python app.py &
BACKEND_PID=$!

# Wait a moment to ensure backend starts or fails
sleep 2
if ! kill -0 $BACKEND_PID 2>/dev/null; then
    echo "Error: Backend failed to start."
    exit 1
fi

cd ..

# 2. Frontend Setup & Run
echo ""
echo "[2/2] Starting Frontend..."
cd client

# Install dependencies if node_modules missing
if [ ! -d "node_modules" ]; then
    echo "Installing frontend dependencies (this may take a while)..."
    npm install
fi

# Start React app
echo "Starting React development server..."
echo "The application will open in your browser shortly."
npm start

# The script will wait here because npm start runs in the foreground.
# When you Ctrl+C, the trap will catch it and kill the backend.
