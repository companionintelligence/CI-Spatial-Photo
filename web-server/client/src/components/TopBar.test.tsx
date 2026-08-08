import React from 'react';
// Imported here rather than from a shared `src/setupTests.ts`: this repo has no
// such file, and adding one silently changes the environment of every other
// test suite in the project.
import '@testing-library/jest-dom';
import { render, screen, fireEvent } from '@testing-library/react';
import TopBar from './TopBar';
import { useHeadTracking, HeadTracking, HeadTrackingSnapshot } from '../hooks/useHeadTracking';

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
