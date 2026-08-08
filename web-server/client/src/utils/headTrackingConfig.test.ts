import {
  DEFAULT_FACE_LANDMARKER_MODEL_URL,
  DEFAULT_MEDIAPIPE_WASM_BASE,
  MEDIAPIPE_TASKS_VISION_VERSION,
  resolveHeadTrackingAssets,
} from './headTrackingConfig';

describe('resolveHeadTrackingAssets', () => {
  it('falls back to the CDN so a fresh clone works with no configuration', () => {
    const assets = resolveHeadTrackingAssets({});
    expect(assets.wasmBase).toBe(DEFAULT_MEDIAPIPE_WASM_BASE);
    expect(assets.modelUrl).toBe(DEFAULT_FACE_LANDMARKER_MODEL_URL);
    expect(assets.delegate).toBe('GPU');
    expect(assets.selfHosted).toBe(false);
  });

  it('pins the WASM to the installed JS bundle version', () => {
    /*
      The bug this guards. The previous code asked jsDelivr for the 0.10.0 WASM
      while npm had installed a 0.10.3x JS bundle. MediaPipe ships those as one
      program split across two files and does not version-negotiate between
      them; the mismatch aborts inside the Emscripten runtime with no usable
      error. If the dependency is bumped without updating the constant, this
      fails here rather than on a user's machine.

      Read from the manifest rather than restated, because a hand-copied literal
      is exactly what went stale last time.
    */
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require('../../package.json');
    const declared: string = pkg.dependencies['@mediapipe/tasks-vision'];
    expect(DEFAULT_MEDIAPIPE_WASM_BASE).toContain(
      `@mediapipe/tasks-vision@${MEDIAPIPE_TASKS_VISION_VERSION}/wasm`,
    );
    // `^0.10.22-rc.x` and `0.10.35` must at least agree on the minor line; the
    // exact installed patch is not knowable from the range alone.
    const declaredMinor = declared.replace(/^[^\d]*/, '').split('.').slice(0, 2).join('.');
    expect(MEDIAPIPE_TASKS_VISION_VERSION.startsWith(declaredMinor)).toBe(true);
  });

  it('lets an appliance serve both assets from its own origin', () => {
    const assets = resolveHeadTrackingAssets({
      wasmBase: '/vendor/mediapipe/wasm/',
      modelUrl: '/vendor/mediapipe/face_landmarker.task',
    });
    // Trailing slash removed: MediaPipe concatenates `${base}/vision_wasm...`,
    // and a doubled slash 404s on nginx's `try_files`.
    expect(assets.wasmBase).toBe('/vendor/mediapipe/wasm');
    expect(assets.selfHosted).toBe(true);
  });

  it('only claims self-hosted when NEITHER asset is remote', () => {
    expect(
      resolveHeadTrackingAssets({ wasmBase: '/vendor/wasm' }).selfHosted,
    ).toBe(false);
    expect(
      resolveHeadTrackingAssets({ modelUrl: '/vendor/model.task' }).selfHosted,
    ).toBe(false);
    expect(
      resolveHeadTrackingAssets({
        wasmBase: 'https://cdn.example.com/wasm',
        modelUrl: 'https://cdn.example.com/model.task',
      }).selfHosted,
    ).toBe(false);
  });

  it('treats an absolute URL back to this origin as local', () => {
    const origin = window.location.origin;
    const assets = resolveHeadTrackingAssets({
      wasmBase: `${origin}/vendor/wasm`,
      modelUrl: `${origin}/vendor/model.task`,
    });
    expect(assets.selfHosted).toBe(true);
  });

  it('accepts a CPU delegate and ignores anything else', () => {
    expect(resolveHeadTrackingAssets({ delegate: 'cpu' }).delegate).toBe('CPU');
    expect(resolveHeadTrackingAssets({ delegate: ' CPU ' }).delegate).toBe('CPU');
    expect(resolveHeadTrackingAssets({ delegate: 'gpu' }).delegate).toBe('GPU');
    expect(resolveHeadTrackingAssets({ delegate: 'wibble' }).delegate).toBe('GPU');
  });

  it('ignores blank env vars rather than resolving to an empty path', () => {
    // Docker and CRA both turn an unset variable into the empty string, not
    // undefined, so `||` on the raw value is not enough on its own.
    const assets = resolveHeadTrackingAssets({ wasmBase: '  ', modelUrl: '' });
    expect(assets.wasmBase).toBe(DEFAULT_MEDIAPIPE_WASM_BASE);
    expect(assets.modelUrl).toBe(DEFAULT_FACE_LANDMARKER_MODEL_URL);
  });
});
