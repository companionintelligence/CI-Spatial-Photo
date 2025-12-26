# ML Sharp Web Server

This project provides a web-based interface for the ML Sharp CLI tool, allowing users to upload data, run predictions/renders, and view the results in an interactive 3D viewer with XR capabilities.

## Features

- **Full-Stack Architecture**: Flask backend for CLI integration, React frontend for the UI.
- **Interactive 3D Viewer**: Built with Three.js and `@sparkjsdev/spark` to render Gaussian Splats (`.ply` files).
- **XR Head Tracking**: Uses MediaPipe to track the user's head via webcam, adjusting the 3D camera perspective in real-time for a holographic effect.
- **Responsive Design**: Full-screen immersive view with a floating controls panel that adapts to mobile devices.
- **Theme Support**: Toggle between Light and Dark modes.

## Project Structure

- `backend/`: Flask application serving the API.
  - `app.py`: Main entry point.
  - `tests/`: Backend tests.
- `client/`: React frontend application.
  - `src/components/`: UI components (`SplatViewer`, `ControlsPanel`, `TopBar`).
  - `src/hooks/`: Custom hooks (e.g., `useHeadTracking`).
  - `src/utils/`: Helper functions for 3D math and file parsing.

## Setup & Installation

### Quick Start

The easiest way to get up and running is to use the provided helper script. This will install all dependencies and start both the backend and frontend servers.

1. Ensure you have your conda environment active:

   ```bash
   conda activate sharp
   ```

2. Run the setup script:

   ```bash
   ./run.sh
   ```

### Manual Setup

If you prefer to run the services manually:

#### Backend Setup

1. Navigate to the backend directory:

   ```bash
   cd backend
   ```

2. Install Python dependencies:

   ```bash
   pip install -r requirements.txt
   ```

3. Run the server:

   ```bash
   python app.py
   ```

   The backend runs on `http://localhost:5001`.

### Frontend Setup

1. Navigate to the client directory:

   ```bash
   cd client
   ```

2. Install Node dependencies:

   ```bash
   npm install
   ```

3. Start the development server:

   ```bash
   npm start
   ```

   The frontend runs on `http://localhost:3000`.

## Usage

1. Open `http://localhost:3000` in your browser.
2. **Predict**: Upload a video or images to run the Gaussian Splatting prediction pipeline.
3. **Render**: Upload a `.ply` file to render a video.
4. **View**: The generated `.ply` file will automatically load in the background viewer.
5. **XR Mode**: Click the "Enable XR" (Eye icon) button to turn on webcam-based head tracking. Move your head to see the perspective change!

## Testing

- **Backend**: Run `pytest` in the `backend/` directory.
- **Frontend**: Run `npm test` in the `client/` directory.


