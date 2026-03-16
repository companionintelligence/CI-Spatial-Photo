# TIME MACHINE PLAYGROUND - WEB INTERFACE

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

## App 2.0 redesign: 3D/4D media strategy

The current app already provides the key pieces for a 3D media workflow: capture input, run a
Gaussian Splatting pipeline, and preview the result in a head-tracked viewer. For App 2.0, the
recommended direction is to keep that baseline while adding dedicated paths for richer video
reconstruction and time-aware 4D playback.

### Reviewed systems

| System | Best fit in the roadmap |
| --- | --- |
| [`ml-sharp`](https://github.com/iVideoGameBoss/ml-sharp) | Baseline single-scene Gaussian Splatting pipeline and web viewer reference for image-first or short clip workflows. |
| [`ml-sharp` web interface setup](https://github.com/cjgaspari/ml-sharp?tab=readme-ov-file#web-interface-one-click-setup) | Operational reference for one-click onboarding, background jobs, and artifact delivery from the existing web app. |
| [`4DGS-Video-Generator`](https://github.com/AndriiShramko/4DGS-Video-Generator) | Dynamic scene pipeline for converting motion-heavy source video into time-varying 4D Gaussian assets. |
| [`video-3d-reconstruction-gsplat`](https://github.com/Nannigalaxy/video-3d-reconstruction-gsplat) | Video-to-3D reconstruction path for clips that need better scene recovery before splat export or downstream editing. |

### Recommended processing strategy

1. **Intake and classify media**: detect whether the user uploaded a single image, a static/multi-view
   video, or a motion-rich clip that needs temporal reconstruction.
2. **Route to the right pipeline**:
   - Use SHARP for the fastest single-scene conversion and immediate viewer previews.
   - Use a gsplat reconstruction workflow for richer static video reconstruction and asset cleanup.
   - Use a 4DGS workflow for sequences where motion needs to survive into playback.
3. **Normalize outputs**: persist splats, preview renders, thumbnails, and camera metadata in a common
   job package so the same results can be consumed by the web viewer or a future desktop creator app.
4. **Build the AR magic portal viewer**: extend the existing head-tracked viewer with portal framing,
   timeline controls, and scene anchors so users can step into a 3D still or scrub through 4D playback.

### Viewer roadmap

- **Web**: keep the React + Three.js + Spark viewer for upload, preview, and sharing.
- **Desktop**: add a creator-focused tool for batch conversion, asset cleanup, and timeline authoring.
- **AR portal mode**: reuse the current XR head tracking to drive a framed portal effect for 3D scenes
  today, then layer in 4D playback controls once dynamic assets are available.

## Testing

- **Backend**: Run `pytest` in the `backend/` directory.
- **Frontend**: Run `npm test` in the `client/` directory.

