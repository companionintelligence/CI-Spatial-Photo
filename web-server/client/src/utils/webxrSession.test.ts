import {
  AR_OPTIONAL_FEATURES,
  AR_REQUIRED_FEATURES,
  buildXrSessionInit,
  detectXrCapabilities,
  endXrSession,
  getActiveXrSession,
  isIOSLike,
  isSessionModeSupported,
  isXrSessionError,
  readXrEnvironment,
  requestXrSession,
  resetXrSessionState,
  resolveReferenceSpace,
  XrEnvironment,
  XrSessionError,
} from './webxrSession';

/**
 * Everything here runs against an injected `XRSystem`. jsdom has no WebXR and
 * never will, so the only alternative would be to test that the module does
 * nothing — which is the one behaviour that is already guaranteed.
 *
 * The user-agent strings are real, not sketches. The iPad one in particular has
 * to be exact: what makes iPad detection hard is that Safari on iPadOS sends a
 * string with no "iPad" in it at all, so a plausible-looking made-up UA would
 * quietly test the easy case instead of the one that breaks.
 */
const UA = {
  windowsChrome:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  androidChrome:
    'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
  iphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
  /** Safari on iPadOS with the default "Request Desktop Website" behaviour. */
  ipadAsMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15',
  quest:
    'Mozilla/5.0 (X11; Linux x86_64; Quest 3) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/38.0 Chrome/140.0.0.0 VR Safari/537.36',
};

const env = (over: Partial<XrEnvironment> = {}): XrEnvironment => ({
  xr: null,
  userAgent: UA.windowsChrome,
  platform: 'Win32',
  maxTouchPoints: 0,
  isSecureContext: true,
  ...over,
});

interface FakeSessionOptions {
  enabledFeatures?: string[];
  /** Make `session.end()` reject, as a UA does when the session is already ending. */
  endRejects?: boolean;
  /** Some runtimes do not dispatch `end` for a programmatic end. Default: they do. */
  dispatchEndOnEnd?: boolean;
  /** Reference space types this session will grant. */
  referenceSpaces?: string[];
  /**
   * Dispatch `end` the instant a listener is attached — the only way to place
   * the event strictly between the handle being built and `requestXrSession`'s
   * fulfillment handler running, which is the window the "already dead on
   * arrival" branch guards.
   */
  endOnListen?: boolean;
}

const makeFakeSession = (options: FakeSessionOptions = {}) => {
  const endListeners: Array<() => void> = [];
  const fireEnd = () => endListeners.slice().forEach((l) => l());

  const end = jest.fn(async () => {
    if (options.endRejects) throw new DOMException('already ending', 'InvalidStateError');
    if (options.dispatchEndOnEnd !== false) fireEnd();
  });

  const requestReferenceSpace = jest.fn(async (type: string) => {
    const granted = options.referenceSpaces ?? ['local-floor', 'local', 'viewer'];
    if (granted.indexOf(type) === -1) {
      throw new DOMException(`${type} is not supported`, 'NotSupportedError');
    }
    return { __type: type } as unknown as XRReferenceSpace;
  });

  const session = {
    enabledFeatures: options.enabledFeatures,
    addEventListener: (type: string, listener: () => void) => {
      if (type !== 'end') return;
      endListeners.push(listener);
      if (options.endOnListen) listener();
    },
    removeEventListener: (type: string, listener: () => void) => {
      if (type !== 'end') return;
      const i = endListeners.indexOf(listener);
      if (i !== -1) endListeners.splice(i, 1);
    },
    end,
    requestReferenceSpace,
  };

  return {
    session: session as unknown as XRSession,
    end,
    requestReferenceSpace,
    fireEnd,
    endListenerCount: () => endListeners.length,
  };
};

const xrSystem = (
  over: {
    supports?: (mode: XRSessionMode) => boolean | Promise<boolean> | unknown;
    request?: (mode: XRSessionMode, init?: XRSessionInit) => Promise<XRSession>;
  } = {},
) => {
  const isSessionSupported = jest.fn(async (mode: XRSessionMode) =>
    over.supports ? over.supports(mode) : true,
  );
  const requestSession = jest.fn(async (mode: XRSessionMode, init?: XRSessionInit) =>
    over.request ? over.request(mode, init) : makeFakeSession().session,
  );
  return {
    xr: { isSessionSupported, requestSession } as unknown as XRSystem,
    isSessionSupported,
    requestSession,
  };
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

beforeEach(() => {
  resetXrSessionState();
});

describe('module import safety', () => {
  it('can be imported with navigator.xr undefined, and never reads it at import time', () => {
    /*
      Two failures in one assertion.

      The throw: a module-scope `navigator.xr.isSessionSupported(...)` would
      take down the entire app bundle in every browser without WebXR — which is
      every iPhone, and the headless Chromium the product video is captured in.

      The read count: even a non-throwing module-scope read (`const HAS_XR =
      !!navigator.xr`) bakes the answer at import. That is wrong for a polyfill
      that installs `navigator.xr` later, and it is the shortest route to a
      synchronous "probably supported" value that a component renders an AR
      button from before `isSessionSupported` has confirmed anything — which is
      exactly the flash of AR UI the capture must never contain.
    */
    let reads = 0;
    Object.defineProperty(navigator, 'xr', {
      configurable: true,
      get() {
        reads += 1;
        return undefined;
      },
    });

    try {
      jest.isolateModules(() => {
        expect(() => {
          // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
          require('./webxrSession');
        }).not.toThrow();
      });
      expect(reads).toBe(0);
    } finally {
      delete (navigator as { xr?: unknown }).xr;
    }
  });

  it('reads a real, absent navigator.xr as null rather than undefined or a throw', () => {
    const live = readXrEnvironment();
    expect(live.xr).toBeNull();
    expect(typeof live.userAgent).toBe('string');
    expect(typeof live.isSecureContext).toBe('boolean');
  });

  it('reports honestly with no arguments at all, against the real jsdom navigator', async () => {
    // The zero-argument path is what a component will actually call. If it ever
    // starts throwing on a browser with no WebXR, this catches it.
    const caps = await detectXrCapabilities();
    expect(caps.hasWebXr).toBe(false);
    expect(caps.ar.supported).toBe(false);
    expect(caps.anyImmersive).toBe(false);
  });
});

describe('isIOSLike', () => {
  it('recognises an iPhone', () => {
    expect(isIOSLike(env({ userAgent: UA.iphone, platform: 'iPhone', maxTouchPoints: 5 }))).toBe(true);
  });

  it('recognises an iPad that is pretending to be a Mac', () => {
    /*
      The whole reason this function is not a one-line regex. Since iPadOS 13,
      "Request Desktop Website" is the DEFAULT on iPad, so a stock iPad sends
      "Macintosh; Intel Mac OS X" and reports platform MacIntel. A /iPad/ test
      matches none of them, and the user would be told to check their HTTPS
      setup for a feature Apple has not implemented.
    */
    expect(
      isIOSLike(env({ userAgent: UA.ipadAsMac, platform: 'MacIntel', maxTouchPoints: 5 })),
    ).toBe(true);
  });

  it('does not mistake a desktop Mac for an iPad', () => {
    // Identical UA and platform to the case above; only maxTouchPoints differs.
    // macOS reports 0 — a trackpad is a pointing device, not a touch screen —
    // and a Mac must keep getting the ordinary "no WebXR in Safari" message
    // rather than one telling it to use the iPhone workaround.
    expect(
      isIOSLike(env({ userAgent: UA.ipadAsMac, platform: 'MacIntel', maxTouchPoints: 0 })),
    ).toBe(false);
  });

  it('leaves Windows, Android and headset browsers alone', () => {
    expect(isIOSLike(env({ userAgent: UA.windowsChrome, platform: 'Win32' }))).toBe(false);
    expect(isIOSLike(env({ userAgent: UA.androidChrome, platform: 'Linux armv8l' }))).toBe(false);
    expect(isIOSLike(env({ userAgent: UA.quest, platform: 'Linux x86_64' }))).toBe(false);
  });

  it('does not fire on a single-touch Windows digitiser', () => {
    expect(isIOSLike(env({ userAgent: UA.windowsChrome, platform: 'Win32', maxTouchPoints: 1 }))).toBe(
      false,
    );
  });
});

describe('detectXrCapabilities', () => {
  it('reports both modes on a headset that has both', async () => {
    const { xr, isSessionSupported } = xrSystem();
    const caps = await detectXrCapabilities(env({ xr, userAgent: UA.quest }));

    expect(caps.ar).toMatchObject({ supported: true, reason: 'supported' });
    expect(caps.vr).toMatchObject({ supported: true, reason: 'supported' });
    expect(caps.anyImmersive).toBe(true);
    expect(isSessionSupported).toHaveBeenCalledWith('immersive-ar');
    expect(isSessionSupported).toHaveBeenCalledWith('immersive-vr');
  });

  it('reports AR only on a phone', async () => {
    const { xr } = xrSystem({ supports: (mode) => mode === 'immersive-ar' });
    const caps = await detectXrCapabilities(env({ xr, userAgent: UA.androidChrome }));

    expect(caps.ar.supported).toBe(true);
    expect(caps.vr.supported).toBe(false);
    expect(caps.vr.reason).toBe('mode-unsupported');
    expect(caps.anyImmersive).toBe(true);
  });

  it('separates "no WebXR device" from "no WebXR API"', async () => {
    const { xr } = xrSystem({ supports: () => false });
    const caps = await detectXrCapabilities(env({ xr }));
    expect(caps.hasWebXr).toBe(true);
    expect(caps.ar.reason).toBe('mode-unsupported');
    expect(caps.anyImmersive).toBe(false);
  });

  it('treats a rejected support query as unsupported instead of propagating', async () => {
    // `isSessionSupported` is specified to reject with SecurityError when a
    // permissions policy blocks XR, which is the normal state of this app inside
    // a cross-origin iframe. A propagated rejection here becomes an unhandled
    // rejection inside whatever effect awaited it.
    const { xr } = xrSystem({
      supports: () => Promise.reject(new DOMException('blocked by policy', 'SecurityError')),
    });
    const caps = await detectXrCapabilities(env({ xr }));

    expect(caps.ar).toMatchObject({ supported: false, reason: 'query-failed' });
    expect(caps.vr).toMatchObject({ supported: false, reason: 'query-failed' });
  });

  it('survives an isSessionSupported that throws synchronously', async () => {
    const xr = {
      isSessionSupported: () => {
        throw new TypeError('half-installed polyfill');
      },
      requestSession: jest.fn(),
    } as unknown as XRSystem;

    const caps = await detectXrCapabilities(env({ xr }));
    expect(caps.ar.reason).toBe('query-failed');
  });

  it('never reports supported on a truthy non-boolean', async () => {
    // A sloppy polyfill resolving 1 must not read as support: the caller uses
    // this value to decide whether an AR control may render at all.
    const { xr } = xrSystem({ supports: () => 1 });
    const caps = await detectXrCapabilities(env({ xr }));
    expect(caps.ar.supported).toBe(false);
  });

  it('explains iOS specifically, and points at the feature that does work there', async () => {
    const caps = await detectXrCapabilities(
      env({ userAgent: UA.iphone, platform: 'iPhone', maxTouchPoints: 5 }),
    );

    expect(caps.isIOS).toBe(true);
    expect(caps.ar.reason).toBe('ios-no-webxr');
    expect(caps.vr.reason).toBe('ios-no-webxr');
    // The message has to name the alternative. "AR unavailable" on its own reads
    // as a bug in the app; the head-tracked window genuinely works on an iPhone,
    // because getUserMedia and MediaPipe are both available there.
    expect(caps.ar.message).toMatch(/head-tracked window/i);
    expect(caps.ar.message).toMatch(/\bXR\b/);
  });

  it('gives an iPad-as-Mac the iOS explanation, not the generic one', async () => {
    const caps = await detectXrCapabilities(
      env({ userAgent: UA.ipadAsMac, platform: 'MacIntel', maxTouchPoints: 5 }),
    );
    expect(caps.ar.reason).toBe('ios-no-webxr');
  });

  it('gives a desktop Mac the generic explanation', async () => {
    const caps = await detectXrCapabilities(
      env({ userAgent: UA.ipadAsMac, platform: 'MacIntel', maxTouchPoints: 0 }),
    );
    expect(caps.isIOS).toBe(false);
    expect(caps.ar.reason).toBe('no-webxr-api');
  });

  it('blames the insecure context when that is actually why navigator.xr is missing', async () => {
    const caps = await detectXrCapabilities(env({ isSecureContext: false }));
    expect(caps.ar.reason).toBe('insecure-context');
    expect(caps.ar.message).toMatch(/HTTPS|localhost/i);
  });

  it('prefers the iOS explanation over the insecure-context one', async () => {
    /*
      Ordering, and it matters. Told to switch to HTTPS, an iPhone user does the
      work and still has no WebXR, because Safari does not implement it at any
      origin. The app has then sent them on a pointless errand and been wrong
      about the cause. The secure-context advice is only given on a platform
      where taking it would actually produce a navigator.xr.
    */
    const caps = await detectXrCapabilities(
      env({ userAgent: UA.iphone, platform: 'iPhone', maxTouchPoints: 5, isSecureContext: false }),
    );
    expect(caps.ar.reason).toBe('ios-no-webxr');
  });

  it('lets a measured capability override the iOS guess', async () => {
    /*
      UA sniffing here may only ever EXPLAIN a negative we already measured, and
      must never manufacture one. Concretely: an iPad running a WebXR-polyfilling
      browser, or Safari on visionOS — which sends a Mac-like UA and does have
      WebXR. Short-circuiting on the UA would refuse AR to a device standing
      there reporting that it supports AR.
    */
    const { xr } = xrSystem({ supports: () => true });
    const caps = await detectXrCapabilities(
      env({ xr, userAgent: UA.ipadAsMac, platform: 'MacIntel', maxTouchPoints: 5 }),
    );

    expect(caps.isIOS).toBe(true);
    expect(caps.ar.supported).toBe(true);
    expect(caps.ar.reason).toBe('supported');
  });
});

describe('isSessionModeSupported', () => {
  it('is false, not a throw, with no WebXR', async () => {
    await expect(isSessionModeSupported('immersive-ar', env())).resolves.toBe(false);
  });

  it('is false, not a rejection, when the query rejects', async () => {
    const { xr } = xrSystem({ supports: () => Promise.reject(new Error('nope')) });
    await expect(isSessionModeSupported('immersive-ar', env({ xr }))).resolves.toBe(false);
  });

  it('is false when isSessionSupported is missing entirely', async () => {
    const xr = { requestSession: jest.fn() } as unknown as XRSystem;
    await expect(isSessionModeSupported('immersive-ar', env({ xr }))).resolves.toBe(false);
  });
});

describe('buildXrSessionInit', () => {
  it('requires hit-test for AR and leaves local-floor optional', () => {
    /*
      The split this whole module turns on. `hit-test` is required because
      tap-to-place against a real surface IS the AR feature — without it the
      splat hangs at a guessed distance and clips through the furniture, which
      looks broken rather than absent. `local-floor` is optional because it is
      not one of the two reference spaces the spec guarantees, so requiring it
      would hard-fail every handheld session during the second or so before the
      device has found a floor plane.
    */
    const init = buildXrSessionInit('immersive-ar');
    expect(init.requiredFeatures).toEqual(['hit-test']);
    expect(init.optionalFeatures).toEqual(['local-floor']);
    expect(init.requiredFeatures).toEqual(AR_REQUIRED_FEATURES.slice());
    expect(init.optionalFeatures).toEqual(AR_OPTIONAL_FEATURES.slice());
  });

  it('requires nothing for VR', () => {
    const init = buildXrSessionInit('immersive-vr');
    expect(init.requiredFeatures).toEqual([]);
    expect(init.optionalFeatures).toEqual(['local-floor', 'bounded-floor']);
  });

  it('asks for nothing at all inline', () => {
    expect(buildXrSessionInit('inline')).toEqual({ requiredFeatures: [], optionalFeatures: [] });
  });

  it('omits domOverlay entirely when no root is supplied', () => {
    // Not `domOverlay: undefined`: passing the key at all has been enough to
    // make some UAs treat the overlay as requested and then fail on the missing
    // root.
    const init = buildXrSessionInit('immersive-ar');
    expect('domOverlay' in init).toBe(false);
    expect(init.optionalFeatures).not.toContain('dom-overlay');
  });

  it('adds dom-overlay as OPTIONAL when a root is supplied', () => {
    // Optional, because losing the overlay costs the exit button while a
    // required-and-unsupported dom-overlay costs the entire session.
    const root = document.createElement('div');
    const init = buildXrSessionInit('immersive-ar', { domOverlayRoot: root });

    expect(init.optionalFeatures).toContain('dom-overlay');
    expect(init.requiredFeatures).not.toContain('dom-overlay');
    expect(init.domOverlay).toEqual({ root });
  });

  it('merges caller features with the defaults rather than replacing them', () => {
    const init = buildXrSessionInit('immersive-ar', {
      requiredFeatures: ['anchors'],
      optionalFeatures: ['light-estimation'],
    });
    expect(init.requiredFeatures).toEqual(['hit-test', 'anchors']);
    expect(init.optionalFeatures).toEqual(['local-floor', 'light-estimation']);
  });

  it('never lists a feature as both required and optional', () => {
    // The spec says required wins, but UAs have counted the duplicate as a
    // second consent-requiring feature and prompted twice.
    const init = buildXrSessionInit('immersive-ar', { optionalFeatures: ['hit-test', 'local-floor'] });
    expect(init.requiredFeatures).toEqual(['hit-test']);
    expect(init.optionalFeatures).toEqual(['local-floor']);
  });

  it('deduplicates repeated requests', () => {
    const init = buildXrSessionInit('immersive-vr', {
      requiredFeatures: ['anchors', 'anchors'],
      optionalFeatures: ['local-floor'],
    });
    expect(init.requiredFeatures).toEqual(['anchors']);
    expect(init.optionalFeatures).toEqual(['local-floor', 'bounded-floor']);
  });
});

describe('requestXrSession', () => {
  it('opens a session with the negotiated feature set', async () => {
    const fake = makeFakeSession({ enabledFeatures: ['hit-test', 'local-floor'] });
    const { xr, requestSession } = xrSystem({ request: async () => fake.session });

    const handle = await requestXrSession({ env: env({ xr }) });

    expect(requestSession).toHaveBeenCalledWith('immersive-ar', {
      requiredFeatures: ['hit-test'],
      optionalFeatures: ['local-floor'],
    });
    expect(handle.session).toBe(fake.session);
    expect(handle.mode).toBe('immersive-ar');
    expect(handle.active).toBe(true);
    expect(getActiveXrSession()).toBe(handle);
  });

  it('does not re-check isSessionSupported on the way in', async () => {
    /*
      An immersive request needs transient user activation, and inserting an
      awaited round trip between the click and `requestSession` is how "Enter AR"
      becomes a button that works on a fast device and silently does nothing on a
      slow one. Support is settled at render time by `detectXrCapabilities`,
      which is the same place the capture constraint already forces it.
    */
    const { xr, isSessionSupported } = xrSystem();
    await requestXrSession({ env: env({ xr }) });
    expect(isSessionSupported).not.toHaveBeenCalled();
  });

  it('takes the VR defaults when asked for VR', async () => {
    const { xr, requestSession } = xrSystem();
    await requestXrSession({ mode: 'immersive-vr', env: env({ xr }) });
    expect(requestSession).toHaveBeenCalledWith('immersive-vr', {
      requiredFeatures: [],
      optionalFeatures: ['local-floor', 'bounded-floor'],
    });
  });

  it('fails typed, without calling anything, when there is no WebXR', async () => {
    const err = await requestXrSession({ env: env() }).catch((e) => e);
    expect(isXrSessionError(err)).toBe(true);
    expect(err).toBeInstanceOf(XrSessionError);
    expect(err.code).toBe('no-webxr');
    expect(err.mode).toBe('immersive-ar');
  });

  it('names the insecure context when that is why navigator.xr is missing', async () => {
    const err = await requestXrSession({ env: env({ isSecureContext: false }) }).catch((e) => e);
    expect(err.code).toBe('insecure-context');
  });

  it.each([
    ['NotAllowedError', 'denied'],
    ['PermissionDeniedError', 'denied'],
    ['SecurityError', 'insecure-context'],
    ['NotSupportedError', 'unsupported'],
    ['AbortError', 'aborted'],
    ['InvalidStateError', 'aborted'],
  ])('maps a %s rejection to code %s', async (domName, code) => {
    const { xr } = xrSystem({
      request: () => Promise.reject(new DOMException('nope', domName)),
    });
    const err = await requestXrSession({ env: env({ xr }) }).catch((e) => e);

    expect(isXrSessionError(err)).toBe(true);
    expect(err.code).toBe(code);
    // The original is kept so a bug report can carry the UA's own wording.
    expect((err.cause as DOMException).name).toBe(domName);
  });

  it('falls back to a verbatim message for an unrecognised failure', async () => {
    const { xr } = xrSystem({ request: () => Promise.reject(new Error('gpu process crashed')) });
    const err = await requestXrSession({ env: env({ xr }) }).catch((e) => e);
    expect(err.code).toBe('failed');
    expect(err.message).toBe('gpu process crashed');
  });

  it('blames the camera on an AR denial and does not on a VR one', async () => {
    /*
      Android surfaces a blocked site camera permission as the same
      NotAllowedError as a dismissed consent prompt, and for AR the camera is the
      likelier cause — so the AR copy says so. Telling a Quest user in
      `immersive-vr` to check their camera permission would just be wrong.
    */
    const { xr } = xrSystem({
      request: () => Promise.reject(new DOMException('denied', 'NotAllowedError')),
    });

    const arErr = await requestXrSession({ env: env({ xr }) }).catch((e) => e);
    expect(arErr.message).toMatch(/camera/i);

    const vrErr = await requestXrSession({ mode: 'immersive-vr', env: env({ xr }) }).catch((e) => e);
    expect(vrErr.code).toBe('denied');
    expect(vrErr.message).not.toMatch(/camera/i);
  });

  it('leaves no active session behind after a failed request', async () => {
    const { xr } = xrSystem({ request: () => Promise.reject(new Error('boom')) });
    await requestXrSession({ env: env({ xr }) }).catch(() => undefined);

    expect(getActiveXrSession()).toBeNull();
    // And the failure must not have jammed the guard: retrying has to work.
    const { xr: xr2 } = xrSystem();
    await expect(requestXrSession({ env: env({ xr: xr2 }) })).resolves.toBeTruthy();
  });

  it('refuses a second request made while the first is still in flight', async () => {
    /*
      The reason the guard holds the in-flight PROMISE and not just the resolved
      session. `requestSession` is asynchronous, so a guard that only inspects
      the settled state lets two clicks 50 ms apart both reach the UA. Chrome
      rejects the second with InvalidStateError, which is survivable; other
      runtimes tear down the first session to grant the second, which leaves the
      app rendering into a dead session with a live one nobody owns.
    */
    const gate = deferred<XRSession>();
    const { xr, requestSession } = xrSystem({ request: () => gate.promise });
    const environment = env({ xr });

    const first = requestXrSession({ env: environment });
    const second = requestXrSession({ env: environment });

    await expect(second).rejects.toMatchObject({ code: 'already-active' });
    expect(requestSession).toHaveBeenCalledTimes(1);

    gate.resolve(makeFakeSession().session);
    await expect(first).resolves.toBeTruthy();
    expect(requestSession).toHaveBeenCalledTimes(1);
  });

  it('refuses a second request while one is live, then allows one after it ends', async () => {
    const { xr } = xrSystem();
    const handle = await requestXrSession({ env: env({ xr }) });

    await expect(requestXrSession({ env: env({ xr }) })).rejects.toMatchObject({
      code: 'already-active',
    });

    await handle.end();
    expect(getActiveXrSession()).toBeNull();
    await expect(requestXrSession({ env: env({ xr }) })).resolves.toBeTruthy();
  });

  it('releases the guard when the session ends outside the app', async () => {
    /*
      The failure this prevents is a stuck UI. Sessions end for reasons the app
      never initiated — the headset comes off, the user swipes the Android back
      gesture, the OS pre-empts for a call. If the module only cleared its state
      in `end()`, the button would stay on "Exit AR" with nothing behind it and
      no way to start another session short of a reload.
    */
    const fake = makeFakeSession();
    const { xr } = xrSystem({ request: async () => fake.session });
    const handle = await requestXrSession({ env: env({ xr }) });

    fake.fireEnd();

    expect(handle.active).toBe(false);
    expect(getActiveXrSession()).toBeNull();
    await expect(requestXrSession({ env: env({ xr }) })).resolves.toBeTruthy();
  });

  it('does not adopt a session that ended before the request resolved', async () => {
    /*
      A headset taken off between the UA granting the session and the app
      getting the handle back — one microtask, but a real one. The session is
      granted, so nothing rejects; it is simply dead on arrival. Installing it as
      the active session would leave the guard holding a corpse and refusing
      every subsequent request for the lifetime of the page.

      `endOnListen` is what pins the event inside that window: the handle
      subscribes during construction, so firing on subscribe lands the `end`
      strictly after the handle exists and strictly before `requestXrSession`
      decides whether to adopt it.
    */
    const fake = makeFakeSession({ endOnListen: true });
    const { xr } = xrSystem({ request: async () => fake.session });

    const handle = await requestXrSession({ env: env({ xr }) });

    expect(handle.active).toBe(false);
    expect(getActiveXrSession()).toBeNull();
    await expect(requestXrSession({ env: env({ xr }) })).resolves.toBeTruthy();
  });
});

describe('session handle lifecycle', () => {
  it('ends once, and is idempotent afterwards', async () => {
    const fake = makeFakeSession();
    const { xr } = xrSystem({ request: async () => fake.session });
    const handle = await requestXrSession({ env: env({ xr }) });

    await handle.end();
    await handle.end();
    expect(fake.end).toHaveBeenCalledTimes(1);
    expect(handle.active).toBe(false);
  });

  it('still marks itself ended when session.end() rejects', async () => {
    // `end()` rejects when the session is already ending — a race with the user
    // pulling the headset off mid-teardown. Either way the session is gone, and
    // treating the rejection as "still running" would jam the guard permanently.
    const fake = makeFakeSession({ endRejects: true });
    const { xr } = xrSystem({ request: async () => fake.session });
    const handle = await requestXrSession({ env: env({ xr }) });

    await expect(handle.end()).resolves.toBeUndefined();
    expect(handle.active).toBe(false);
    expect(getActiveXrSession()).toBeNull();
  });

  it('still marks itself ended when the UA never dispatches the end event', async () => {
    // Polyfills and older runtimes have shipped without dispatching `end` for a
    // programmatic end. Relying on the event alone would leave the module
    // believing a torn-down session is live.
    const fake = makeFakeSession({ dispatchEndOnEnd: false });
    const { xr } = xrSystem({ request: async () => fake.session });
    const handle = await requestXrSession({ env: env({ xr }) });

    await handle.end();
    expect(handle.active).toBe(false);
    expect(getActiveXrSession()).toBeNull();
  });

  it('detaches its end listener so a re-fired event cannot re-run teardown', async () => {
    const fake = makeFakeSession();
    const { xr } = xrSystem({ request: async () => fake.session });
    const handle = await requestXrSession({ env: env({ xr }) });

    expect(fake.endListenerCount()).toBe(1);
    await handle.end();
    expect(fake.endListenerCount()).toBe(0);
  });

  it('notifies onEnd listeners exactly once and supports unsubscribing', async () => {
    const fake = makeFakeSession();
    const { xr } = xrSystem({ request: async () => fake.session });
    const handle = await requestXrSession({ env: env({ xr }) });

    const kept = jest.fn();
    const dropped = jest.fn();
    handle.onEnd(kept);
    handle.onEnd(dropped)();

    fake.fireEnd();
    fake.fireEnd();

    expect(kept).toHaveBeenCalledTimes(1);
    expect(dropped).not.toHaveBeenCalled();
  });

  it('runs an onEnd listener immediately if the session has already ended', async () => {
    // Otherwise a component that subscribes in an effect, one tick after the
    // session died, never learns and never restores its UI.
    const fake = makeFakeSession();
    const { xr } = xrSystem({ request: async () => fake.session });
    const handle = await requestXrSession({ env: env({ xr }) });

    fake.fireEnd();
    const late = jest.fn();
    handle.onEnd(late);
    expect(late).toHaveBeenCalledTimes(1);
  });

  it('keeps running listeners after one of them throws', async () => {
    const fake = makeFakeSession();
    const { xr } = xrSystem({ request: async () => fake.session });
    const handle = await requestXrSession({ env: env({ xr }) });

    const after = jest.fn();
    handle.onEnd(() => {
      throw new Error('a component unmounted badly');
    });
    handle.onEnd(after);

    expect(() => fake.fireEnd()).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('reports the features the UA actually granted', async () => {
    const fake = makeFakeSession({ enabledFeatures: ['hit-test', 'viewer', 'local'] });
    const { xr } = xrSystem({ request: async () => fake.session });
    const handle = await requestXrSession({ env: env({ xr }) });

    expect(handle.enabledFeatures).toEqual(['hit-test', 'viewer', 'local']);
    expect(handle.isFeatureEnabled('hit-test')).toBe(true);
    // Asked for, not granted — the optional-feature case the caller must degrade
    // around rather than assume.
    expect(handle.isFeatureEnabled('local-floor')).toBe(false);
  });

  it('falls back to what the required list proves when enabledFeatures is absent', async () => {
    /*
      `XRSession.enabledFeatures` postdates the core spec and the Quest browser
      was late to it. With it missing, the only thing provable is that every
      REQUIRED feature is present, because the request would have rejected with
      NotSupportedError otherwise. Optional ones report false: a caller that
      wrongly believes it has hit-test throws on the first
      `requestHitTestSource`, whereas one that wrongly believes it lacks a
      feature merely renders the fallback.
    */
    const fake = makeFakeSession();
    const { xr } = xrSystem({ request: async () => fake.session });
    const handle = await requestXrSession({ env: env({ xr }) });

    expect(handle.enabledFeatures).toBeNull();
    expect(handle.isFeatureEnabled('hit-test')).toBe(true);
    expect(handle.isFeatureEnabled('local-floor')).toBe(false);
  });

  it('records exactly what was requested', async () => {
    const root = document.createElement('div');
    const { xr } = xrSystem();
    const handle = await requestXrSession({ env: env({ xr }), domOverlayRoot: root });

    expect(handle.requestedFeatures).toEqual({
      required: ['hit-test'],
      optional: ['local-floor', 'dom-overlay'],
    });
  });
});

describe('endXrSession', () => {
  it('is safe to call with nothing running', async () => {
    await expect(endXrSession()).resolves.toBeUndefined();
  });

  it('ends whatever is running', async () => {
    const fake = makeFakeSession();
    const { xr } = xrSystem({ request: async () => fake.session });
    await requestXrSession({ env: env({ xr }) });

    await endXrSession();
    expect(fake.end).toHaveBeenCalledTimes(1);
    expect(getActiveXrSession()).toBeNull();
  });
});

describe('resolveReferenceSpace', () => {
  it('takes local-floor when the device has a floor', async () => {
    const fake = makeFakeSession();
    const result = await resolveReferenceSpace(fake.session);
    expect(result.type).toBe('local-floor');
    expect(fake.requestReferenceSpace).toHaveBeenCalledTimes(1);
  });

  it('falls back to local when the optional local-floor was not granted', async () => {
    /*
      The other half of making `local-floor` optional. A caller that just asks
      for 'local-floor' gets a rejection on every device where the optional
      feature was refused, which turns a deliberate soft failure straight back
      into the hard one the optional list existed to avoid.
    */
    const fake = makeFakeSession({ referenceSpaces: ['local', 'viewer'] });
    const result = await resolveReferenceSpace(fake.session);
    expect(result.type).toBe('local');
  });

  it('ends at viewer, which every session is guaranteed to have', async () => {
    const fake = makeFakeSession({ referenceSpaces: ['viewer'] });
    const result = await resolveReferenceSpace(fake.session);
    expect(result.type).toBe('viewer');
  });

  it('throws a typed error when nothing at all is available', async () => {
    const fake = makeFakeSession({ referenceSpaces: [] });
    const err = await resolveReferenceSpace(fake.session).catch((e) => e);
    expect(isXrSessionError(err)).toBe(true);
    expect(err.code).toBe('failed');
    expect(err.message).toMatch(/local-floor, local, viewer/);
  });

  it('honours an explicit preference order', async () => {
    const fake = makeFakeSession();
    const result = await resolveReferenceSpace(fake.session, ['local', 'local-floor']);
    expect(result.type).toBe('local');
  });
});

describe('isXrSessionError', () => {
  it('accepts a real one and rejects anything else', () => {
    expect(isXrSessionError(new XrSessionError('denied', 'immersive-ar', 'no'))).toBe(true);
    expect(isXrSessionError(new Error('no'))).toBe(false);
    expect(isXrSessionError(null)).toBe(false);
    expect(isXrSessionError('denied')).toBe(false);
  });

  it('recognises a structurally identical error from a duplicated module copy', () => {
    /*
      `instanceof` on a subclass of a native Error is fragile twice over: a
      down-levelled class body breaks the prototype chain (jest's browserslist
      keeps classes native, so this only ever shows up in the production bundle),
      and a bundler that emits two copies of this module gives two unrelated
      constructors. The brand check is what keeps `catch` blocks working in both
      cases.
    */
    const lookalike = { name: 'XrSessionError', code: 'denied', message: 'no' };
    expect(isXrSessionError(lookalike)).toBe(true);
  });

  it('keeps instanceof working despite extending a built-in', () => {
    const err = new XrSessionError('unsupported', 'immersive-vr', 'no');
    expect(err instanceof XrSessionError).toBe(true);
    expect(err instanceof Error).toBe(true);
  });
});
