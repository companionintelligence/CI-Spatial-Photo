import React, { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { Sun, Moon, Eye, EyeOff, Settings, X, Crosshair } from 'lucide-react';
import {
  HeadTracking,
  HeadTrackingSnapshot,
  HeadTrackingStatus,
  MAX_SENSITIVITY,
  MIN_SENSITIVITY,
} from '../hooks/useHeadTracking';

interface TopBarProps {
  isXREnabled: boolean;
  setIsXREnabled: (enabled: boolean) => void;
  isDarkMode: boolean;
  setIsDarkMode: (enabled: boolean) => void;
  showControls: boolean;
  setShowControls: (show: boolean) => void;
  /**
   * The live head-tracking handle. Both names accept the same object;
   * `headPosition` is the name `App.tsx` passes today. It is a stable handle,
   * not a per-frame pose — see `useHeadTracking`.
   */
  headPosition?: HeadTracking | null;
  headTracking?: HeadTracking | null;
  videoRef: React.RefObject<HTMLVideoElement>;
}

/**
 * One row per state, so there is exactly one place to look when the feature
 * misbehaves. The old UI had a single signal for all six — a green border
 * around the preview — which meant "camera denied", "model still downloading"
 * and "you have walked out of frame" were indistinguishable from each other and
 * from "working perfectly".
 */
const STATUS_UI: Record<HeadTrackingStatus, { label: string; dot: string; frame: string }> = {
  off: { label: 'Off', dot: 'bg-gray-500', frame: 'border-gray-600' },
  starting: {
    label: 'Starting camera…',
    dot: 'bg-sky-400 animate-pulse',
    frame: 'border-sky-500/70',
  },
  searching: { label: 'Looking for your face', dot: 'bg-amber-400', frame: 'border-amber-500/80' },
  tracking: { label: 'Tracking', dot: 'bg-emerald-400', frame: 'border-emerald-500' },
  denied: { label: 'Camera blocked', dot: 'bg-red-400', frame: 'border-red-500' },
  unavailable: { label: 'Camera unavailable', dot: 'bg-red-400', frame: 'border-red-500' },
};

const IDLE_SNAPSHOT: HeadTrackingSnapshot = {
  status: 'off',
  message: null,
  sensitivity: 1,
  selfHosted: false,
};
const idleSubscribe = () => () => undefined;
const idleGetSnapshot = () => IDLE_SNAPSHOT;

const TopBar: React.FC<TopBarProps> = ({
  isXREnabled,
  setIsXREnabled,
  isDarkMode,
  setIsDarkMode,
  showControls,
  setShowControls,
  headPosition,
  headTracking,
  videoRef,
}) => {
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const tracker = headTracking ?? headPosition ?? null;

  /*
    The status is the only part of head tracking that belongs in React, and it
    changes a handful of times per session. `useSyncExternalStore` pulls it off
    the same handle the render loop reads at 60 Hz, without the pose itself ever
    becoming a state update — which is what made the previous version re-render
    this bar, the control panel and the gallery on every webcam frame.
  */
  const snapshot = useSyncExternalStore(
    tracker ? tracker.subscribe : idleSubscribe,
    tracker ? tracker.getSnapshot : idleGetSnapshot,
  );
  /*
    `snapshot.status` is still 'off' on the render that turns XR on — the hook's
    effect has not run yet — so the panel would appear reading "Off" for one
    frame, which is the least reassuring possible first impression of a button
    the user just pressed. Treat the interval before the hook reports anything
    as 'starting', because that is exactly what it is.
  */
  const status: HeadTrackingStatus = !isXREnabled
    ? 'off'
    : snapshot.status === 'off'
      ? 'starting'
      : snapshot.status;
  const statusUi = STATUS_UI[status];

  const pose = tracker?.pose;

  /*
    Draw the mirrored webcam preview.

    Started unconditionally while XR is on, and every source it needs is
    re-checked inside the loop. The previous version bailed out at
    `if (!videoRef.current) return` — and at the instant XR is switched on the
    video element does not exist yet, because the hook is still awaiting camera
    permission. It only ever recovered because the effect also re-ran on every
    `headPosition` change, i.e. it was rescued by the same per-frame re-render
    storm this rewrite removes.
  */
  useEffect(() => {
    if (!isXREnabled) return;
    const canvas = previewCanvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    let animationId = 0;
    const draw = () => {
      animationId = requestAnimationFrame(draw);
      const video = videoRef.current;

      if (!video || video.readyState < video.HAVE_CURRENT_DATA) {
        ctx.fillStyle = '#0c1018';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        return;
      }

      // Mirrored, because an unmirrored self-view is disorienting: you move
      // left and your image moves right.
      ctx.save();
      ctx.scale(-1, 1);
      ctx.drawImage(video, -canvas.width, 0, canvas.width, canvas.height);
      ctx.restore();

      // The reticle marks the point the maths actually uses — the midpoint of
      // the two outer eye corners — rather than the nose the old dot tracked.
      // Drawn from the raw image coordinates the hook publishes, so if it sits
      // on your eyes the geometry is right; the previous dot was reconstructed
      // from the already-derived x/y and could look correct while the pose was
      // not. `1 - imageX` undoes the mirror above.
      if (pose && pose.tracking) {
        const x = (1 - pose.imageX) * canvas.width;
        const y = pose.imageY * canvas.height;
        ctx.strokeStyle = '#34d399';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, 7, 0, 2 * Math.PI);
        ctx.moveTo(x - 12, y);
        ctx.lineTo(x - 9, y);
        ctx.moveTo(x + 9, y);
        ctx.lineTo(x + 12, y);
        ctx.stroke();
      }
    };

    draw();
    return () => cancelAnimationFrame(animationId);
  }, [isXREnabled, videoRef, pose]);

  const sensitivityLabel = useMemo(() => `${snapshot.sensitivity.toFixed(2)}x`, [snapshot.sensitivity]);

  return (
    <div className="flex items-center justify-between p-4 pointer-events-auto bg-gradient-to-b from-black/70 to-transparent">
      {/* Product name, not the repo name — this string is on camera in every
          product-video frame (video/storyboard.json, CI-Common video-kit
          MESSAGING.md "Naming").

          Which is exactly why it must not be `truncate` at every width. On the
          360px capture phone the three control buttons and their gap take
          ~150px of a 328px content box, leaving ~176px for a 24px bold string
          that wants ~230px — so `truncate` rendered the product name, in the
          frame it is guaranteed to appear in, as "Photo Time Ma…".

          That was never visible before because the committed shots predate it:
          PR #33 re-shot them "after #32" but captured a stale bundle, so the
          shots still showed the pre-#32 two-line wrap. The re-capture on this
          branch is the first one to actually render #32's TopBar.

          `min-w-0` alone is what stops the h1 pushing the buttons off-screen —
          that part was doing the real work. Below `sm` the name is allowed to
          wrap to two lines (and set smaller) instead of losing its second half;
          from `sm` up it fits on one line and `truncate` stays as the guard
          against a future longer name. */}
      <h1 className="min-w-0 whitespace-normal text-lg font-bold text-white drop-shadow-md sm:truncate sm:text-2xl">
        Photo Time Machine
      </h1>

      {/* `relative` anchors the XR panel below. It is only ever rendered while
          XR is on, so the product-video capture — headless Chromium with no
          webcam, XR off — never sees it and never touches getUserMedia. */}
      <div className="relative flex shrink-0 gap-3 pl-3">
        <button
          onClick={() => setIsXREnabled(!isXREnabled)}
          aria-pressed={isXREnabled}
          className={`p-2 rounded-full transition-colors ${
            isXREnabled ? 'bg-green-600 hover:bg-green-700' : 'bg-gray-700 hover:bg-gray-600'
          } text-white`}
          title={isXREnabled ? 'Disable XR' : 'Enable XR'}
        >
          {isXREnabled ? <Eye size={20} /> : <EyeOff size={20} />}
        </button>
        <button
          onClick={() => setIsDarkMode(!isDarkMode)}
          className="p-2 text-white transition-colors bg-gray-700 rounded-full hover:bg-gray-600"
          title="Toggle Theme"
        >
          {isDarkMode ? <Sun size={20} /> : <Moon size={20} />}
        </button>
        <button
          onClick={() => setShowControls(!showControls)}
          className="p-2 text-white transition-colors bg-blue-600 rounded-full hover:bg-blue-700"
          title="Toggle Controls"
        >
          {showControls ? <X size={20} /> : <Settings size={20} />}
        </button>

        {isXREnabled && (
          <div className="absolute right-0 top-full z-20 mt-2 w-64 overflow-hidden rounded-xl border border-gray-700 bg-gray-900/95 text-xs shadow-2xl backdrop-blur">
            <div className={`flex justify-center border-b-2 ${statusUi.frame} bg-black`}>
              {/*
                Deliberately given no CSS size, so it renders at its intrinsic
                160x120 — the 4:3 of the 640x480 stream the hook asks for. A
                canvas stretched to the panel width would show a horizontally
                squashed face and, worse, put the reticle somewhere other than
                where the geometry says the eyes are, which is the one thing
                this preview exists to let you check.
              */}
              <canvas ref={previewCanvasRef} width={160} height={120} className="block" aria-hidden="true" />
            </div>

            <div className="space-y-2.5 p-3">
              <p className="flex items-center gap-2 text-gray-200" role="status" aria-live="polite">
                <span className={`h-2 w-2 shrink-0 rounded-full ${statusUi.dot}`} aria-hidden="true" />
                <span className="min-w-0 truncate">{statusUi.label}</span>
              </p>

              {/*
                The failure the old code could not express at all: permission
                denied was a `console.error`, so the user clicked the button,
                the browser blocked the camera, the button went green and
                nothing else ever happened.
              */}
              {snapshot.message && (
                <p
                  className={status === 'denied' || status === 'unavailable' ? 'text-red-300' : 'text-gray-400'}
                  role={status === 'denied' || status === 'unavailable' ? 'alert' : undefined}
                >
                  {snapshot.message}
                </p>
              )}

              <button
                onClick={() => tracker?.recenter()}
                disabled={!tracker || status !== 'tracking'}
                className="flex w-full items-center justify-center gap-2 rounded bg-gray-700 py-1.5 text-gray-100 transition-colors hover:bg-gray-600 disabled:cursor-not-allowed disabled:bg-gray-800 disabled:text-gray-500"
                title="Treat your current head position as the centre of the window"
              >
                <Crosshair size={14} aria-hidden="true" />
                Recentre
              </button>

              <label className="block">
                <span className="flex items-baseline justify-between text-gray-400">
                  {/*
                    Named, and the neutral value called out, because 1.00x is
                    not an arbitrary midpoint — it is the physically faithful
                    projection. Anything above it is a deliberate exaggeration.
                  */}
                  <span>Parallax</span>
                  <span className="tabular-nums text-gray-300" title="1.00x is true to life">
                    {sensitivityLabel}
                  </span>
                </span>
                <input
                  type="range"
                  min={MIN_SENSITIVITY}
                  max={MAX_SENSITIVITY}
                  step={0.05}
                  value={snapshot.sensitivity}
                  onChange={(e) => tracker?.setSensitivity(parseFloat(e.target.value))}
                  disabled={!tracker}
                  className="mt-1 w-full accent-blue-500"
                  aria-label="Head tracking parallax sensitivity"
                />
              </label>

              {/*
                The app's pitch is that nothing leaves the box. Head tracking
                itself never uploads a frame, but by default the model and its
                WASM runtime are pulled from a public CDN on first enable, and
                that is worth saying out loud on an appliance that may be
                air-gapped. See docs/UI-GUIDE.md for the self-hosting recipe.
              */}
              <p className="border-t border-gray-800 pt-2 text-[11px] leading-snug text-gray-500">
                {snapshot.selfHosted
                  ? 'Tracking runs on this device. Model served from this host.'
                  : 'Tracking runs on this device; no video is uploaded. The model is fetched from a CDN on first use.'}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default TopBar;
