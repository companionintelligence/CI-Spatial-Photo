import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Eye, EyeOff, Settings, X, Crosshair, Server } from 'lucide-react';
import { ServerPanel } from './ServerPicker';
import { BrandLink } from './SiteLinks';
import {
  HeadTracking,
  HeadTrackingSnapshot,
  HeadTrackingStatus,
  MAX_SENSITIVITY,
  MIN_SENSITIVITY,
} from '../hooks/useHeadTracking';
/*
  `screenGeometry` imports NOTHING — no three, no React. That is what makes it
  safe here: this component is in the entry bundle, and App.tsx code-splits the
  viewers precisely so that three, Spark and MediaPipe are not. The value it
  stores is read by `SplatViewer` from its render loop, and the two talk through
  that module's own tiny store rather than through App, which owns neither piece
  of state and should not have to.
*/
import {
  computeScreenMetrics,
  getDisplayDiagonalInches,
  isValidDiagonalInches,
  MAX_DIAGONAL_INCHES,
  MIN_DIAGONAL_INCHES,
  readScreenSize,
  setDisplayDiagonalInches,
  subscribeDisplayCalibration,
} from '../utils/screenGeometry';

interface TopBarProps {
  isXREnabled: boolean;
  setIsXREnabled: (enabled: boolean) => void;
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
  /**
   * The configured processing server, or null before one is chosen. Passed down rather
   * than read here so there is a single subscriber to the store (App), and so this stays
   * a presentational component the tests can drive directly.
   */
  serverTarget?: string | null;
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
    dot: 'bg-primary-400 animate-pulse',
    frame: 'border-primary-500/70',
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
  showControls,
  setShowControls,
  headPosition,
  headTracking,
  videoRef,
  serverTarget = null,
}) => {
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const [showServer, setShowServer] = useState(false);
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

  /*
    Physical display calibration.

    Held in `screenGeometry`'s module store and read here through
    `useSyncExternalStore`, not in component state. The value has two consumers
    that never meet — this control writes it, `SplatViewer`'s render loop reads
    it — and their only common ancestor is `App.tsx`, which owns neither piece
    of state. A local copy would drift the moment anything else set the value.
  */
  const storedDiagonal = useSyncExternalStore(
    subscribeDisplayCalibration,
    getDisplayDiagonalInches,
    getDisplayDiagonalInches,
  );
  const [diagonalDraft, setDiagonalDraft] = useState(() => {
    const stored = getDisplayDiagonalInches();
    return stored === null ? '' : String(stored);
  });

  const draftIsBlank = diagonalDraft.trim() === '';
  const draftInvalid = !draftIsBlank && !isValidDiagonalInches(Number.parseFloat(diagonalDraft));

  /*
    Is a metric window actually LIVE, or is that just a number in a box?

    A stored diagonal is necessary but not sufficient — `computeScreenMetrics`
    returns null when the browser reports a zero-sized screen, and the viewer
    then falls back to the relative projection without saying so. Running the
    same first link of the viewer's own chain here is what keeps this badge from
    claiming a calibration the projection is not using. (The one thing it cannot
    check is the canvas size, which is positive whenever the viewer is on
    screen.)
  */
  const calibrated = useMemo(() => {
    if (storedDiagonal === null) return false;
    const size = readScreenSize();
    return size !== null && computeScreenMetrics({ diagonalInches: storedDiagonal, screen: size }) !== null;
  }, [storedDiagonal]);

  /*
    Calibration is necessary for 1:1 but not sufficient, and saying otherwise
    was this badge committing the exact sin it was written to prevent.

    `mapHeadPoseToEye` multiplies the lateral terms by `sensitivity * blend`,
    and the Parallax slider ships at 1.5x by default (DEFAULT_SENSITIVITY) —
    chosen because exaggerated parallax reads better on a first encounter. So a
    user who measures their monitor, types 27, and never touches the slider was
    shown "calibrated 1:1" over a view moving half again as far as their head.

    Three states, because there are three: no measurement; measured and
    faithful; measured but deliberately exaggerated. The third is a legitimate
    place to be — it just is not 1:1, and the badge is the only thing on screen
    that claims otherwise. Tolerance is 0.005 because the slider's own readout
    is 2dp, so anything that displays as "1.00x" must not contradict the badge.
  */
  const trueToLife = Math.abs(snapshot.sensitivity - 1) < 0.005;
  const calibrationBadge = !calibrated
    ? { text: 'relative', tone: 'text-gray-400', title: 'Parallax is proportional, but not matched to a real display' }
    : trueToLife
      ? { text: 'calibrated 1:1', tone: 'text-emerald-300', title: 'Parallax matches real head movement one to one' }
      : {
          text: `calibrated, ${snapshot.sensitivity.toFixed(2)}x`,
          tone: 'text-amber-300',
          title: `Measured against your display, then exaggerated ${snapshot.sensitivity.toFixed(2)}x by the Parallax slider. Set it to 1.00x for true to life.`,
        };

  const commitDiagonal = (raw: string) => {
    setDiagonalDraft(raw);
    if (raw.trim() === '') {
      setDisplayDiagonalInches(null);
      return;
    }
    /*
      An out-of-range entry stores null rather than nothing.

      `setDisplayDiagonalInches` already refuses anything outside 4-150 inches,
      so an absurd value can never reach the frustum — but skipping the call
      would leave the PREVIOUS calibration live while the field showed a number
      the app is not using, which is the one state in which the badge lies. This
      way "the field is wrong" and "the window is relative" are the same fact,
      and the message below says so.
    */
    setDisplayDiagonalInches(Number.parseFloat(raw));
  };

  return (
    <header className="flex items-center justify-between p-4 pointer-events-auto bg-ground border-b border-gray-700 min-[1000px]:grid min-[1000px]:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
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
      <div className="flex min-w-0 flex-col gap-1 min-[1000px]:contents">
        {/* The way back to ci.computer. Above the product name rather than beside it: the
            name keeps every pixel of the width it was already fighting for on a 360px
            phone, and the logo — a fixed 24px box — costs one extra row, not a column. */}
        <BrandLink />
        <h1 className="min-w-0 whitespace-normal text-[13px] font-semibold uppercase tracking-[0.12em] text-white min-[1000px]:text-center sm:truncate">
          Photo Time Machine
        </h1>
      </div>

      {/* `relative` anchors the XR panel below. It is only ever rendered while
          XR is on, so the product-video capture — headless Chromium with no
          webcam, XR off — never sees it and never touches getUserMedia. */}
      <div className="relative flex shrink-0 gap-3 pl-3 min-[1000px]:justify-self-end">
        <button
          onClick={() => setIsXREnabled(!isXREnabled)}
          aria-pressed={isXREnabled}
          aria-label="XR head tracking"
          className={`p-2 rounded transition-colors ${
            isXREnabled ? 'bg-primary-600 hover:bg-primary-500' : 'bg-gray-700 hover:bg-gray-600'
          } text-white`}
          title={isXREnabled ? 'Disable XR' : 'Enable XR'}
        >
          {isXREnabled ? <Eye size={20} aria-hidden="true" /> : <EyeOff size={20} aria-hidden="true" />}
        </button>
        {/*
          There used to be a sun/moon "Toggle Theme" button here. There is no light theme:
          every surface in the app is the canon dark ground, and the toggle only flipped the
          root text colour to gray-900 — after one click the hero headline and the dropzone
          label were 1.1:1 against #041620, effectively invisible. A control that can only
          break the page is removed, not fixed up; a real light theme would need its own
          ground, surface and text tokens and a contrast pass, which is a feature.
        */}
        <button
          onClick={() => setShowControls(!showControls)}
          aria-label="Controls"
          aria-expanded={showControls}
          className="p-2 text-white transition-colors bg-primary-600 rounded hover:bg-primary-500"
          title="Toggle Controls"
        >
          {showControls ? <X size={20} aria-hidden="true" /> : <Settings size={20} aria-hidden="true" />}
        </button>

        {/*
            Which server, and a way to change it. Hidden until one is configured: the
            first-run card already owns that job, and offering a second entry point to
            the same setting while it is on screen would just be two things to get out
            of sync.
          */}
        {serverTarget !== null && (
          <button
            onClick={() => setShowServer((v) => !v)}
            aria-pressed={showServer}
            aria-label="Processing server"
            className="p-2 text-white transition-colors bg-gray-700 rounded hover:bg-gray-600"
            title={`Processing server: ${serverTarget === 'same-origin' ? 'this host' : serverTarget}`}
          >
            <Server size={20} aria-hidden="true" />
          </button>
        )}

        {showServer && serverTarget !== null && (
          <ServerPanel target={serverTarget} onClose={() => setShowServer(false)} />
        )}

        {isXREnabled && (
          <div className="absolute right-0 top-full z-20 mt-2 w-64 overflow-hidden rounded-lg border border-gray-700 bg-gray-900 text-xs">
            <div className={`flex justify-center border-b-2 ${statusUi.frame} bg-ground`}>
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
                  className="mt-1 w-full accent-primary-500"
                  aria-label="Head tracking parallax sensitivity"
                />
              </label>

              {/*
                Display calibration.

                Without it the window is self-consistent but not physical: the
                parallax assumes the screen subtends exactly the virtual
                camera's field of view, so a 13" laptop and a 27" monitor move
                the scene by the same amount for the same head movement — wrong
                by a factor of two between those two. There is no browser API
                for physical display size (the CSS `mm` unit is defined as
                96/25.4 px, i.e. a fiction), so the one number nobody has to
                look up is the one we ask for: the diagonal printed on the box.
              */}
              <div className="border-t border-gray-800 pt-2">
                <label className="block">
                  <span className="flex items-baseline justify-between text-gray-400">
                    <span>Screen size</span>
                    <span
                      className={calibrationBadge.tone}
                      title={calibrationBadge.title}
                    >
                      {calibrationBadge.text}
                    </span>
                  </span>
                  <span className="mt-1 flex items-center gap-2">
                    <input
                      type="number"
                      inputMode="decimal"
                      min={MIN_DIAGONAL_INCHES}
                      max={MAX_DIAGONAL_INCHES}
                      step={0.5}
                      value={diagonalDraft}
                      onChange={(e) => commitDiagonal(e.target.value)}
                      placeholder="27"
                      aria-label="Display diagonal in inches"
                      aria-invalid={draftInvalid || undefined}
                      className={`w-20 rounded border bg-gray-800 px-2 py-1 tabular-nums text-gray-100 ${
                        draftInvalid ? 'border-red-500' : 'border-gray-700'
                      }`}
                    />
                    <span className="text-gray-400">inch diagonal</span>
                  </span>
                </label>

                {draftInvalid ? (
                  <p role="alert" className="mt-1.5 text-[11px] leading-snug text-red-300">
                    Enter a diagonal between {MIN_DIAGONAL_INCHES} and {MAX_DIAGONAL_INCHES} inches.
                    Until then the window uses relative parallax.
                  </p>
                ) : (
                  <p className="mt-1.5 text-[11px] leading-snug text-gray-400">
                    {calibrated
                      ? 'The window now moves 1:1 with your head. Assumes this browser window is on the display you measured.'
                      : 'Optional. Without it the parallax is proportional rather than life-sized.'}
                  </p>
                )}
              </div>

              {/*
                The app's pitch is that nothing leaves the box. Head tracking
                itself never uploads a frame, but by default the model and its
                WASM runtime are pulled from a public CDN on first enable, and
                that is worth saying out loud on an appliance that may be
                air-gapped. See docs/UI-GUIDE.md for the self-hosting recipe.
              */}
              <p className="border-t border-gray-800 pt-2 text-[11px] leading-snug text-gray-400">
                {snapshot.selfHosted
                  ? 'Tracking runs on this device. Model served from this host.'
                  : 'Tracking runs on this device; no video is uploaded. The model is fetched from a CDN on first use.'}
              </p>
            </div>
          </div>
        )}
      </div>
    </header>
  );
};

export default TopBar;
