#!/bin/bash
set -e

# Ensure we are in the project root
cd "$(dirname "$0")"

cd frontend/client

echo "Installing frontend dependencies..."
npm install

echo "Starting Frontend Client..."
npm start
