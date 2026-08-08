import React from 'react';
// Imported here rather than from a shared `src/setupTests.ts`: this repo has no
// such file, and adding one silently changes the environment of every other
// test suite in the project.
import '@testing-library/jest-dom';
import { render, screen, fireEvent } from '@testing-library/react';
import TopBar from './TopBar';
import { useHeadTracking, HeadTracking, HeadTrackingSnapshot } from '../hooks/useHeadTracking';
import {
  DISPLAY_DIAGONAL_STORAGE_KEY,
  resetDisplayCalibrationCache,
} from '../utils/screenGeometry';

/**
 * These are contract tests, not coverage.
 *
 * The product video (`video/storyboard.json`) drives this app with Playwright in
 * headless Chromium that has NO WEBCAM, and its shot list addresses the top bar
 * by two exact selectors. It also depends on the app never asking for camera
 * permission on its own — a permission prompt in a headless capture is a hang,
 * not an error, so the failure mode is a timed-out shot with no explanation.
 * Both of those are invisible to a type checker.
 */

const noopTracker = (overrides: Partial<HeadTrackingSnapshot> = {}): HeadTracking => {
  const snapshot: HeadTrackingSnapshot = {
    status: 'tracking',
    message: null,
    sensitivity: 1.5,
    selfHosted: false,
    ...overrides,
  };
  return {
    pose: {
      x: 0,
      y: 0,
      z: 1,
      tracking: snapshot.status === 'tracking',
      imageX: 0.5,
      imageY: 0.5,
      distanceMeters: 0.55,
      updatedAt: 0,
    },
    sensitivity: snapshot.sensitivity,
    subscribe: () => () => undefined,
    getSnapshot: () => snapshot,
    recenter: jest.fn(),
    setSensitivity: jest.fn(),
  };
};

/*
  jsdom has no 2D canvas: `getContext` raises a "not implemented" jsdomError and
  returns null, which floods the run with stack traces even though the component
  handles the null perfectly well. Stubbing it keeps the output readable AND
  exercises the null path, which is the one a browser with a lost context takes.
*/
beforeAll(() => {
  jest
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockImplementation(() => null);
});
afterAll(() => jest.restoreAllMocks());

/*
  `screenGeometry` memoises the stored diagonal in a module-level variable and
  jest gives each FILE a fresh module registry, not each test — so without this
  a value written by one test is still live in the next one, and the suite
  passes or fails depending on the order it happens to run in. Clearing both the
  storage and the memo is that module's documented contract for any suite that
  touches the calibration.
*/
const clearCalibration = () => {
  window.localStorage.clear();
  resetDisplayCalibrationCache();
};
beforeEach(clearCalibration);
afterEach(clearCalibration);

const renderBar = (props: Partial<React.ComponentProps<typeof TopBar>> = {}) => {
  const videoRef = React.createRef<HTMLVideoElement>();
  return render(
    <TopBar
      isXREnabled={false}
      setIsXREnabled={jest.fn()}
      isDarkMode
      setIsDarkMode={jest.fn()}
      showControls
      setShowControls={jest.fn()}
      headPosition={null}
      videoRef={videoRef}
      {...props}
    />,
  );
};

describe('TopBar', () => {
  it('keeps the selectors the product-video capture addresses it by', () => {
    renderBar();
    expect(document.querySelector('button[title="Toggle Controls"]')).toBeInTheDocument();
    expect(document.querySelector('button[title="Enable XR"]')).toBeInTheDocument();
  });

  it('flips the XR title rather than adding a second button', () => {
    renderBar({ isXREnabled: true, headPosition: noopTracker() });
    expect(document.querySelector('button[title="Disable XR"]')).toBeInTheDocument();
    expect(document.querySelector('button[title="Enable XR"]')).toBeNull();
  });

  it('shows nothing XR-related until XR is switched on', () => {
    const { rerender } = renderBar({ headPosition: noopTracker() });
    expect(screen.queryByText('Tracking')).toBeNull();
    expect(document.querySelector('canvas')).toBeNull();

    rerender(
      <TopBar
        isXREnabled
        setIsXREnabled={jest.fn()}
        isDarkMode
        setIsDarkMode={jest.fn()}
        showControls
        setShowControls={jest.fn()}
        headPosition={noopTracker()}
        videoRef={React.createRef<HTMLVideoElement>()}
      />,
    );
    expect(screen.getByText('Tracking')).toBeInTheDocument();
  });

  it('names the failure instead of leaving a green button that does nothing', () => {
    renderBar({
      isXREnabled: true,
      headPosition: noopTracker({ status: 'denied', message: 'Camera access was blocked.' }),
    });
    expect(screen.getByText('Camera blocked')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Camera access was blocked.');
    // Recentring against a pose that does not exist would silently zero the
    // calibration, so it is unavailable until there is a face.
    expect(screen.getByRole('button', { name: /recentre/i })).toBeDisabled();
  });

  it('wires recentre and the parallax slider to the tracker', () => {
    const tracker = noopTracker();
    renderBar({ isXREnabled: true, headPosition: tracker });

    fireEvent.click(screen.getByRole('button', { name: /recentre/i }));
    expect(tracker.recenter).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText(/parallax sensitivity/i), { target: { value: '2.4' } });
    expect(tracker.setSensitivity).toHaveBeenCalledWith(2.4);
  });
});

/**
 * jsdom reports `screen.width`/`screen.height` as 0, which is a perfectly
 * legitimate "this browser will not tell you" — and the calibration chain
 * treats it as one, returning null all the way up. So a suite that does not
 * override it can only ever exercise the uncalibrated branch. 2560x1440 is a
 * real 27" panel, the same figure the calibration derivation is worked through
 * with in `magicWindow.ts`.
 */
const setReportedScreen = (width: number, height: number) => {
  Object.defineProperty(window.screen, 'width', { configurable: true, value: width });
  Object.defineProperty(window.screen, 'height', { configurable: true, value: height });
};

describe('display calibration', () => {
  /** The control lives in the XR panel, so XR has to be on to see it. */
  const renderPanel = () => renderBar({ isXREnabled: true, headPosition: noopTracker() });
  const diagonalField = () => screen.getByLabelText(/display diagonal in inches/i);

  beforeEach(() => setReportedScreen(2560, 1440));
  afterEach(() => setReportedScreen(0, 0));

  it('is not offered until XR is switched on', () => {
    renderBar();
    expect(screen.queryByLabelText(/display diagonal in inches/i)).toBeNull();
  });

  it('starts relative, and says so rather than implying a physical window', () => {
    renderPanel();
    expect(screen.getByText('relative')).toBeInTheDocument();
    expect(screen.queryByText('calibrated 1:1')).toBeNull();
    expect(diagonalField()).toHaveValue(null);
  });

  it('persists a valid diagonal and flips the window to calibrated', () => {
    renderPanel();
    fireEvent.change(diagonalField(), { target: { value: '27' } });

    // Persisted, because the viewer reads this from a module store on its next
    // resize — not from a prop, and not from this component's state.
    expect(window.localStorage.getItem(DISPLAY_DIAGONAL_STORAGE_KEY)).toBe('27');
    // `noopTracker` ships the real DEFAULT_SENSITIVITY of 1.5, so the honest
    // badge is the exaggerated form — see the 1:1 test below.
    expect(screen.getByText('calibrated, 1.50x')).toBeInTheDocument();
  });

  it('reads a stored diagonal back on mount', () => {
    window.localStorage.setItem(DISPLAY_DIAGONAL_STORAGE_KEY, '32');
    resetDisplayCalibrationCache();

    renderPanel();
    expect(diagonalField()).toHaveValue(32);
    expect(screen.getByText('calibrated, 1.50x')).toBeInTheDocument();
  });

  /*
    The badge has three states because the projection has three, and conflating
    the last two was a real defect: a measured display still gets its parallax
    multiplied by `sensitivity` in `mapHeadPoseToEye`, and the slider ships at
    1.5x. The badge used to read "calibrated 1:1" over a view moving half again
    as far as the user's head — the one claim on screen that has to be true.
  */
  it('only claims 1:1 when the parallax slider is actually at 1.00x', () => {
    renderBar({ isXREnabled: true, headPosition: noopTracker({ sensitivity: 1 }) });
    fireEvent.change(diagonalField(), { target: { value: '27' } });

    expect(screen.getByText('calibrated 1:1')).toBeInTheDocument();
    expect(screen.queryByText(/calibrated, /)).toBeNull();
  });

  it('says calibrated-but-exaggerated when the slider is off 1.00x', () => {
    renderBar({ isXREnabled: true, headPosition: noopTracker({ sensitivity: 2.25 }) });
    fireEvent.change(diagonalField(), { target: { value: '27' } });

    expect(screen.getByText('calibrated, 2.25x')).toBeInTheDocument();
    expect(screen.queryByText('calibrated 1:1')).toBeNull();
  });

  it('refuses an absurd diagonal instead of building an absurd frustum', () => {
    renderPanel();
    // 270" would make the calibrated parallax gain ten times too small — the
    // feature would look broken rather than mis-set, which is exactly the
    // failure the range check exists to prevent.
    fireEvent.change(diagonalField(), { target: { value: '270' } });

    expect(screen.getByRole('alert')).toHaveTextContent(/between 4 and 150 inches/i);
    expect(window.localStorage.getItem(DISPLAY_DIAGONAL_STORAGE_KEY)).toBeNull();
    expect(screen.getByText('relative')).toBeInTheDocument();
  });

  it('drops a good calibration the moment the field stops being honoured', () => {
    renderPanel();
    fireEvent.change(diagonalField(), { target: { value: '27' } });
    expect(screen.getByText('calibrated, 1.50x')).toBeInTheDocument();

    fireEvent.change(diagonalField(), { target: { value: '2' } });
    // The badge must never claim a calibration the projection is not using: the
    // field says 2 and the window is relative, and both are visible at once.
    expect(screen.getByText('relative')).toBeInTheDocument();
    expect(window.localStorage.getItem(DISPLAY_DIAGONAL_STORAGE_KEY)).toBeNull();
  });

  it('clears back to relative when the field is emptied', () => {
    window.localStorage.setItem(DISPLAY_DIAGONAL_STORAGE_KEY, '27');
    resetDisplayCalibrationCache();

    renderPanel();
    fireEvent.change(diagonalField(), { target: { value: '' } });

    expect(screen.getByText('relative')).toBeInTheDocument();
    expect(window.localStorage.getItem(DISPLAY_DIAGONAL_STORAGE_KEY)).toBeNull();
    // Emptying the field is not an error — no alert, just an uncalibrated window.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not claim a calibration the browser cannot support', () => {
    // A browser that reports no screen size (jsdom's default, and what a
    // locked-down or headless environment can also do) leaves the viewer on the
    // relative projection no matter what diagonal is stored. The badge has to
    // follow the projection, not the stored number.
    setReportedScreen(0, 0);
    window.localStorage.setItem(DISPLAY_DIAGONAL_STORAGE_KEY, '27');
    resetDisplayCalibrationCache();

    renderPanel();
    expect(diagonalField()).toHaveValue(27);
    expect(screen.getByText('relative')).toBeInTheDocument();
  });
});

/** Renders the hook and nothing else, so the effect runs under jsdom. */
const HookHarness: React.FC<{ enabled: boolean }> = ({ enabled }) => {
  useHeadTracking(enabled);
  return null;
};

describe('useHeadTracking, disabled', () => {
  it('never touches the camera while XR is off', () => {
    // The headless capture would hang on a permission prompt, and any user who
    // has not asked for head tracking should not see one either.
    const getUserMedia = jest.fn();
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia },
      configurable: true,
    });
    render(<HookHarness enabled={false} />);
    expect(getUserMedia).not.toHaveBeenCalled();
  });
});
