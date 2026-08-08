import React from 'react';
import '@testing-library/jest-dom';
import { act, render, screen, waitFor } from '@testing-library/react';

/**
 * What this file can and cannot check.
 *
 * There is no WebGL and no WebXR in jsdom, and there never will be — so nothing
 * here asserts a pixel or a pose. What it does assert is the one property of
 * the AR feature that has a hard external contract: **an AR control may only
 * ever exist after a real `isSessionSupported` has resolved exactly `true`**.
 *
 * That is not a nicety. `video/storyboard.json` drives this app with Playwright
 * in headless Chromium, which has no WebXR, and a control that flashes in
 * optimistically and hides itself a tick later would land in a shipped product
 * frame — the sort of defect that is only visible in a rendered mp4 nobody
 * diffs. `isSessionSupported` is asynchronous, so "default hidden, render on a
 * confirmed true" is the only construction that cannot flash, and the negative
 * cases below are the ones that would catch a regression to a UA sniff or to a
 * synchronous `Boolean(navigator.xr)`.
 *
 * The negatives are kept honest by the positive: every test below renders the
 * same component with the same asset, and the only thing that differs is what
 * `navigator.xr` answers. If the negative cases ever pass vacuously — because
 * the button was removed, renamed, or gated on something else — the positive
 * one fails in the same run.
 */

/*
  three's WebGLRenderer THROWS when it cannot get a context, so it has to be
  replaced rather than merely tolerated. Everything else in three stays real:
  the component builds Vector3s, a Box3, a RingGeometry and an off-axis
  projection matrix during mount, and swapping those for stubs would test the
  stubs. Only the one class that needs a GPU is faked.
*/
jest.mock('three', () => {
  const actual = jest.requireActual('three');

  class FakeWebGLRenderer {
    // `global.document`, not `document`: jest's hoisting guard rejects bare
    // out-of-scope identifiers in a mock factory, and `global` is on its
    // allow-list. The factory is lazy, so jsdom is long since installed.
    domElement = global.document.createElement('canvas');
    outputColorSpace = '';

    constructor() {
      /*
        The "no GPU" case is flagged through a global rather than by swapping
        the export, because babel's ESM interop hands `import * as THREE` a
        COPY of a mock factory's return value — reassigning
        `requireMock('three').WebGLRenderer` from a test mutates an object the
        component under test is not reading, and the test then passes for the
        wrong reason (it did, once; that is why this comment exists).
      */
      if ((global as any).mockWebGLUnavailable) {
        throw new Error('Error creating WebGL context.');
      }
    }
    /**
     * Enough of `WebXRManager` for the mount path. Nothing here ever presents:
     * `setAnimationLoop` deliberately stores the callback and never calls it,
     * so no frame runs and the assertions below see a static DOM instead of
     * racing a render loop.
     */
    xr = {
      enabled: false,
      isPresenting: false,
      getCamera: () => ({ cameras: [] }),
      getReferenceSpace: () => null,
      getSession: () => null,
      setReferenceSpaceType: jest.fn(),
      setSession: jest.fn(async () => undefined),
    };
    animationLoop: unknown = null;
    setPixelRatio() {}
    getPixelRatio() {
      return 1;
    }
    setSize() {}
    setClearAlpha() {}
    getClearAlpha() {
      return 1;
    }
    setAnimationLoop(cb: unknown) {
      this.animationLoop = cb;
    }
    render() {}
    dispose() {}
  }

  return { ...actual, WebGLRenderer: FakeWebGLRenderer };
});

/*
  Mocked rather than loaded: both of these ship as untranspiled ES modules and
  CRA's jest config does not transform `node_modules`, so importing either for
  real fails at parse time with "Cannot use import statement outside a module".
  A `jest.mock` factory short-circuits resolution entirely, so the real file is
  never read.
*/
jest.mock('three/examples/jsm/controls/OrbitControls.js', () => {
  const { Vector3 } = jest.requireActual('three');
  return {
    OrbitControls: class {
      enabled = true;
      enableDamping = false;
      dampingFactor = 0;
      rotateSpeed = 1;
      zoomSpeed = 1;
      panSpeed = 1;
      // A real Vector3: the window anchor measures `camera.position.distanceTo`
      // against it, and a plain object would throw there rather than here.
      target = new Vector3();
      update() {}
      dispose() {}
    },
  };
});

jest.mock('@sparkjsdev/spark', () => {
  const { Object3D } = jest.requireActual('three');
  return {
    // Spark's renderer is a THREE.Mesh, and the component adds it to the scene,
    // so the stand-in has to be a real Object3D or `scene.add` rejects it.
    SparkRenderer: class extends Object3D {
      preUpdate = false;
      update() {}
      dispose() {}
    },
    SplatMesh: class {},
    SplatFileType: { PLY: 'ply' },
  };
});

/** A loaded memory: a flat 2 x 1 postcard, which is what the Preview engine emits. */
const mockMakeMesh = () => {
  const { Box3, Object3D, Vector3 } = jest.requireActual('three');
  const mesh: any = new Object3D();
  mesh.packedSplats = { numSplats: 1234 };
  mesh.getBoundingBox = () => new Box3(new Vector3(-1, -0.5, 0), new Vector3(1, 0.5, 0));
  return mesh;
};

jest.mock('../formats/index.js', () => ({
  getFormatHandler: () => ({
    loadMetadata: async () => null,
    loadData: async () => mockMakeMesh(),
  }),
}));

// Imported after the mocks so it picks them up.
// eslint-disable-next-line import/first
import SplatViewer from './SplatViewer';
// eslint-disable-next-line import/first
import { resetXrSessionState } from '../utils/webxrSession';

/** `getFormatHandler` is mocked, so only the name and the bytes matter. */
const fakeSplat = {
  name: 'memory.ply',
  arrayBuffer: async () => new ArrayBuffer(8),
} as unknown as File;

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/126.0.0.0 Mobile Safari/537.36';

const realUserAgent = navigator.userAgent;

const setUserAgent = (ua: string) =>
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: ua });

/** Install a fake `XRSystem`, or remove it entirely for a browser without WebXR. */
const setXrSupport = (modes: XRSessionMode[] | null) => {
  if (modes === null) {
    Object.defineProperty(navigator, 'xr', { configurable: true, value: undefined });
    return jest.fn();
  }
  const isSessionSupported = jest.fn(async (mode: XRSessionMode) => modes.indexOf(mode) !== -1);
  Object.defineProperty(navigator, 'xr', {
    configurable: true,
    value: { isSessionSupported, requestSession: jest.fn() },
  });
  return isSessionSupported;
};

beforeEach(() => {
  setUserAgent(ANDROID_UA);
  setXrSupport(null);
  window.localStorage.clear();
  resetXrSessionState();
});

afterEach(() => {
  setUserAgent(realUserAgent);
  setXrSupport(null);
});

/**
 * Mount, and wait until the splat has finished loading.
 *
 * `[data-splat-status="ready"]` is the product-video capture's own signal, so
 * waiting on it here means these tests break if that attribute is ever renamed
 * — which is the point: it is the contract, not an implementation detail.
 */
const renderLoaded = async () => {
  const view = render(<SplatViewer file={fakeSplat} className="w-full h-full" />);
  await waitFor(() =>
    expect(document.querySelector('[data-splat-status="ready"]')).toBeInTheDocument(),
  );
  // One more turn of the microtask queue, so the capability probe — which was
  // started on mount and resolves independently of the asset — has settled
  // before anything asserts that it rendered nothing.
  await act(async () => {
    await Promise.resolve();
  });
  return view;
};

const arButton = () => document.querySelector('button[title="View in AR"]');

describe('SplatViewer AR entry', () => {
  it('renders no AR control at all in a browser without WebXR', async () => {
    await renderLoaded();

    expect(arButton()).toBeNull();
    // And nothing else AR-shaped either: the whole point is that a capture of
    // this frame contains no trace of a feature the device cannot do.
    expect(screen.queryByText(/AR/)).toBeNull();
  });

  it('offers AR once immersive-ar is confirmed', async () => {
    const isSessionSupported = setXrSupport(['immersive-ar']);
    await renderLoaded();

    expect(await screen.findByTitle('View in AR')).toBeInTheDocument();
    expect(isSessionSupported).toHaveBeenCalledWith('immersive-ar');
  });

  it('stays silent when WebXR exists but the device has no AR', async () => {
    // A desktop Chrome with no headset. The probe genuinely ran and genuinely
    // said no — asserted, so this is not the "nothing rendered because nothing
    // was asked" case above.
    const isSessionSupported = setXrSupport([]);
    await renderLoaded();

    expect(isSessionSupported).toHaveBeenCalledWith('immersive-ar');
    expect(arButton()).toBeNull();
    // No explanation either: a laptop user is not waiting for an AR button and
    // does not need to be told their laptop is not a phone.
    expect(screen.queryByText(/not available on iPhone or iPad/i)).toBeNull();
  });

  it('explains itself on iOS instead of showing a button that cannot work', async () => {
    setUserAgent(IPHONE_UA);
    setXrSupport(null);
    await renderLoaded();

    expect(arButton()).toBeNull();
    expect(screen.getByText(/not available on iPhone or iPad/i)).toBeInTheDocument();
    // The message has to point at the thing that DOES work on iOS, or it is
    // just a dead end with better wording.
    expect(screen.getByText(/head-tracked window/i)).toBeInTheDocument();
  });

  it('waits for a memory before offering to put one in the room', async () => {
    setXrSupport(['immersive-ar']);
    // Inside `act` so the capability probe settles before the assertion: this
    // is the one case where nothing else in the tree signals that it has.
    await act(async () => {
      render(<SplatViewer className="w-full h-full" />);
    });

    expect(arButton()).toBeNull();
  });

  it('mounts the DOM overlay root before any session needs it', async () => {
    setXrSupport(['immersive-ar']);
    await renderLoaded();

    // `requestSession` reads this element at click time. A root created on
    // demand, or hidden behind the session state, is null at exactly the moment
    // it is needed — and the session then opens with no way out of it.
    const overlay = document.querySelector('[data-ar-overlay]');
    expect(overlay).toBeInTheDocument();
    // Invisible to the mouse until AR starts, or it would eat every orbit drag.
    expect(overlay).toHaveClass('pointer-events-none');
  });
});

describe('SplatViewer without a GPU', () => {
  it('reports a missing WebGL context instead of unmounting the app', async () => {
    // The real WebGLRenderer throws rather than returning null when the browser
    // cannot give it a context, and an uncaught throw inside an effect takes
    // the whole React tree with it — a blank page for the entire app.
    (global as any).mockWebGLUnavailable = true;
    try {
      render(<SplatViewer file={fakeSplat} className="w-full h-full" />);
      expect(await screen.findByRole('alert')).toHaveTextContent(/WebGL context/i);
      // The error lands before the capability probe does; flush so the probe's
      // state update happens inside `act` rather than after the test returns.
      await act(async () => {
        await Promise.resolve();
      });
    } finally {
      (global as any).mockWebGLUnavailable = false;
    }
  });
});
