/**
 * WebXR: capability detection, feature negotiation, and the one-session-at-a-time
 * lifecycle.
 *
 * Deliberately free of React and of three.js. Everything here is a plain
 * function over an injectable environment, for two reasons that are not about
 * tidiness:
 *
 *   1. `App.tsx` code-splits the viewers precisely so that `main.js` does not
 *      contain three, Spark or MediaPipe (see the block comment at the top of
 *      App.tsx — it is an 82% reduction and nothing in CI will catch its loss).
 *      An AR button has to live in the always-loaded shell, so the module it
 *      imports must not drag a renderer in behind it. This one imports nothing.
 *
 *   2. The whole point of the module is behaviour in environments the test
 *      runner does not have — an Android phone with passthrough, a Quest, an
 *      iPhone with no WebXR at all, a page served over plain http. Those are
 *      reachable only by injecting a fake `XRSystem`, so the environment is a
 *      parameter everywhere and `navigator` is only read as its default.
 *
 * ── The two rules that keep the product video green ─────────────────────────
 *
 * `video/` captures this app with Playwright in headless Chromium: no WebXR, no
 * webcam, XR off. Two properties of this module exist for that:
 *
 *   • NOTHING here touches `navigator.xr` at module-evaluation time. Every read
 *     happens inside a function call. A module-scope read would bake a value at
 *     import (wrong for a polyfill that installs `navigator.xr` late, wrong for
 *     SSR, wrong for a UA that fires `sessiongranted`) and, worse, it would make
 *     the answer available synchronously — which is the shortest path to a UI
 *     that renders an AR button optimistically and then hides it.
 *
 *   • Support is ONLY ever reported as `true` after `isSessionSupported`
 *     resolves `true`. There is no synchronous "probably supported" accessor to
 *     misuse, and every failure path — no `navigator.xr`, a rejected query, a
 *     thrown SecurityError — resolves to `supported: false`. A caller that
 *     renders on `supported` therefore cannot flash a control into a capture.
 *
 * ── What the honest report is for ───────────────────────────────────────────
 *
 * On iOS there is no WebXR at all: Safari implements neither `immersive-ar` nor
 * `immersive-vr`, and every third-party iOS browser is Safari's engine wearing a
 * different icon. That is a large fraction of the people who will open this app,
 * and "AR unavailable" with no further explanation reads as a bug in the app. It
 * is not — and there is a real answer for them, because the head-tracked magic
 * window runs on getUserMedia + MediaPipe, which iOS does support. So the report
 * carries a reason and a sentence, and the iOS sentence points at the feature
 * that does work rather than at a dead end.
 */

/* ────────────────────────────────────────────────────────────────────────────
   Environment

   Every browser fact this module needs, in one injectable value. Read at call
   time, never at import time.
   ──────────────────────────────────────────────────────────────────────────── */

export interface XrEnvironment {
  /** `navigator.xr`, or null when this browser has no WebXR. */
  xr: XRSystem | null;
  userAgent: string;
  /** `navigator.platform`. Deprecated by the spec, still the iPadOS tell. */
  platform: string;
  maxTouchPoints: number;
  isSecureContext: boolean;
}

/**
 * Snapshot the globals.
 *
 * `isSecureContext` defaults to `true` when there is no window (SSR, a node
 * jest environment). Defaulting to `false` there would make the module invent
 * an "open this over HTTPS" message in an environment that has no URL at all,
 * which is a confidently wrong diagnosis of a non-problem.
 */
export const readXrEnvironment = (): XrEnvironment => {
  const nav: Navigator | undefined = typeof navigator === 'undefined' ? undefined : navigator;
  return {
    xr: nav?.xr ?? null,
    userAgent: nav?.userAgent ?? '',
    platform: nav?.platform ?? '',
    maxTouchPoints: typeof nav?.maxTouchPoints === 'number' ? nav.maxTouchPoints : 0,
    isSecureContext: typeof window === 'undefined' ? true : window.isSecureContext !== false,
  };
};

/**
 * iPhone, iPod, iPad — including the iPad that claims to be a Mac.
 *
 * Since iPadOS 13 the "Request Desktop Website" behaviour is the DEFAULT for
 * Safari on iPad, so a stock iPad sends a user agent string containing
 * "Macintosh; Intel Mac OS X" and reports `navigator.platform === 'MacIntel'`.
 * A UA regex alone therefore misses every iPad in the field, which is the
 * failure this function exists to prevent.
 *
 * The disambiguator is `maxTouchPoints`. A desktop Mac reports 0 — a trackpad
 * is a pointing device, not a touch screen, and macOS has never shipped a touch
 * display — while an iPad reports 5. So "Mac-like AND touch-capable" is an iPad,
 * and the two-branch test costs nothing.
 *
 * `> 1` rather than `> 0` on purpose: a Windows or Linux box with a single-touch
 * digitiser reports 1, and while such a machine would not match the Mac branch
 * anyway, keeping the threshold at the multi-touch boundary means the predicate
 * stays right if the Mac branch is ever loosened.
 */
export const isIOSLike = (env: XrEnvironment = readXrEnvironment()): boolean => {
  const ua = env.userAgent;
  if (/\b(iPhone|iPod|iPad)\b/.test(ua)) return true;
  const macLike = /\b(Macintosh|Mac OS X)\b/.test(ua) || env.platform === 'MacIntel';
  return macLike && env.maxTouchPoints > 1;
};

/* ────────────────────────────────────────────────────────────────────────────
   Capability report
   ──────────────────────────────────────────────────────────────────────────── */

export type XrSupportReason =
  /** `isSessionSupported` resolved true. The only value that permits UI. */
  | 'supported'
  /** No `navigator.xr` in a browser that could plausibly have had one. */
  | 'no-webxr-api'
  /** No `navigator.xr`, and this is an iPhone/iPad, where there never will be. */
  | 'ios-no-webxr'
  /** No `navigator.xr` because the page is not a secure context. Fixable. */
  | 'insecure-context'
  /** WebXR exists; this specific mode does not (a phone with no passthrough). */
  | 'mode-unsupported'
  /** `isSessionSupported` itself threw or rejected. Treated as unsupported. */
  | 'query-failed';

export interface XrModeSupport {
  mode: XRSessionMode;
  /** True only after a confirmed `isSessionSupported` → true. */
  supported: boolean;
  reason: XrSupportReason;
  /** One sentence, suitable for rendering verbatim next to a disabled control. */
  message: string;
}

export interface XrCapabilities {
  ar: XrModeSupport;
  vr: XrModeSupport;
  /** Convenience: is there any immersive mode at all to offer? */
  anyImmersive: boolean;
  hasWebXr: boolean;
  isIOS: boolean;
  secureContext: boolean;
}

const modeLabel = (mode: XRSessionMode): string =>
  mode === 'immersive-ar' ? 'immersive AR' : mode === 'immersive-vr' ? 'immersive VR' : 'inline XR';

/**
 * The iOS sentence. Exported because the same words belong in the AR panel and
 * in whatever the caller shows when it decides not to render an AR button at
 * all, and two hand-written copies of a message drift.
 */
export const IOS_NO_WEBXR_MESSAGE =
  'Safari on iPhone and iPad does not implement WebXR, so there is no in-browser AR mode on this device — ' +
  'no browser on iOS has one, because they all run Safari’s engine. ' +
  'Turn on XR for the head-tracked window instead: it uses the front camera and works here.';

export const NO_WEBXR_MESSAGE =
  'This browser does not support WebXR. Chrome on Android and the Quest browser do. ' +
  'The head-tracked window (the XR toggle) works here regardless.';

export const INSECURE_CONTEXT_MESSAGE =
  'WebXR is only exposed over HTTPS or on localhost. This page is not a secure context.';

/**
 * Why WebXR is missing entirely, or null when `navigator.xr` exists.
 *
 * Order matters and is not arbitrary. iOS is checked BEFORE the secure-context
 * rule because on iOS the secure-context message is a wild goose chase: the user
 * moves the app to HTTPS, WebXR is still absent, and the app has now lied to
 * them once. The insecure-context branch is only reached on a platform where
 * fixing the context would actually produce a `navigator.xr`.
 */
const missingWebXrReason = (
  env: XrEnvironment,
): { reason: XrSupportReason; message: string } | null => {
  if (env.xr) return null;
  if (isIOSLike(env)) return { reason: 'ios-no-webxr', message: IOS_NO_WEBXR_MESSAGE };
  if (!env.isSecureContext) return { reason: 'insecure-context', message: INSECURE_CONTEXT_MESSAGE };
  return { reason: 'no-webxr-api', message: NO_WEBXR_MESSAGE };
};

/**
 * Does this browser support `mode`? Never throws, never rejects.
 *
 * `isSessionSupported` is specified to reject with a SecurityError when a
 * permissions policy blocks XR — which is the normal state of an app embedded in
 * a cross-origin iframe, i.e. a plausible way for this app to be viewed. It can
 * also throw synchronously on a partial polyfill. Both collapse to `false` here
 * rather than propagating, so that a caller which awaits this in an effect
 * cannot produce an unhandled rejection on a page that merely has no AR.
 */
export const isSessionModeSupported = async (
  mode: XRSessionMode,
  env: XrEnvironment = readXrEnvironment(),
): Promise<boolean> => {
  const xr = env.xr;
  if (!xr || typeof xr.isSessionSupported !== 'function') return false;
  try {
    return (await xr.isSessionSupported(mode)) === true;
  } catch {
    return false;
  }
};

const describeMode = async (mode: XRSessionMode, env: XrEnvironment): Promise<XrModeSupport> => {
  const missing = missingWebXrReason(env);
  if (missing) return { mode, supported: false, reason: missing.reason, message: missing.message };

  const xr = env.xr as XRSystem;
  let supported = false;
  let threw = false;
  try {
    supported = (await xr.isSessionSupported(mode)) === true;
  } catch {
    threw = true;
  }

  if (supported) {
    return { mode, supported: true, reason: 'supported', message: `${modeLabel(mode)} is available.` };
  }
  if (threw) {
    return {
      mode,
      supported: false,
      reason: 'query-failed',
      message:
        `This browser refused to answer whether ${modeLabel(mode)} is available. ` +
        'That is usually a permissions policy blocking XR for an embedded page.',
    };
  }
  return {
    mode,
    supported: false,
    reason: 'mode-unsupported',
    message: `This browser has WebXR but no ${modeLabel(mode)} device.`,
  };
};

/**
 * The full report. One await for the caller, both modes probed concurrently.
 *
 * Probing `immersive-vr` as well as `immersive-ar` is worth the second query: a
 * Quest reports both, an Android phone reports only AR, and a tethered PC
 * headset reports only VR. Knowing which lets the caller offer the mode the
 * device actually has instead of showing an AR button that a Rift user cannot
 * use — and every splat this app produces is equally at home in either.
 */
export const detectXrCapabilities = async (
  env: XrEnvironment = readXrEnvironment(),
): Promise<XrCapabilities> => {
  const [ar, vr] = await Promise.all([
    describeMode('immersive-ar', env),
    describeMode('immersive-vr', env),
  ]);
  return {
    ar,
    vr,
    anyImmersive: ar.supported || vr.supported,
    hasWebXr: Boolean(env.xr),
    isIOS: isIOSLike(env),
    secureContext: env.isSecureContext,
  };
};

/* ────────────────────────────────────────────────────────────────────────────
   Errors
   ──────────────────────────────────────────────────────────────────────────── */

export type XrSessionErrorCode =
  /** `navigator.xr` is absent. The request never left the building. */
  | 'no-webxr'
  /** The UA rejected with SecurityError: plain http, or a blocking permissions policy. */
  | 'insecure-context'
  /** NotSupportedError: this mode, or one of the required features, is not available. */
  | 'unsupported'
  /** NotAllowedError: the user declined the consent prompt, or camera access is blocked. */
  | 'denied'
  /** A session is already open (or one is mid-request). Our own guard. */
  | 'already-active'
  /** AbortError / InvalidStateError: dismissed, pre-empted, or the device went away. */
  | 'aborted'
  /** Anything else, verbatim. */
  | 'failed';

const XR_SESSION_ERROR_NAME = 'XrSessionError';

/**
 * A rejected session request, with a code the UI can branch on.
 *
 * Two things about the shape, both defensive:
 *
 * `Object.setPrototypeOf` in the constructor. `tsconfig.json` targets es5 and
 * CRA's production browserslist (`>0.2%, not dead`) can have Babel down-level
 * classes; both transpilations break `instanceof` for a subclass of a NATIVE
 * built-in like Error, because the object the Error constructor returns is not
 * the one `_inherits` set up. The failure is invisible in `jest` (whose
 * browserslist is `last 1 chrome version`, so classes stay native and every
 * assertion passes) and appears only in the production bundle, as an error
 * handler silently taking its generic branch. Restoring the prototype is the
 * standard fix.
 *
 * `isXrSessionError` exists anyway, and checks a brand rather than the
 * prototype, because the prototype fix does not survive two copies of this
 * module ending up in one page (a bundler that duplicates it across chunks).
 */
export class XrSessionError extends Error {
  readonly code: XrSessionErrorCode;
  readonly mode: XRSessionMode;
  /** The DOMException (or whatever) the UA rejected with, when there was one. */
  readonly cause?: unknown;

  constructor(code: XrSessionErrorCode, mode: XRSessionMode, message: string, cause?: unknown) {
    super(message);
    this.name = XR_SESSION_ERROR_NAME;
    this.code = code;
    this.mode = mode;
    this.cause = cause;
    Object.setPrototypeOf(this, XrSessionError.prototype);
  }
}

export const isXrSessionError = (e: unknown): e is XrSessionError => {
  if (e instanceof XrSessionError) return true;
  if (typeof e !== 'object' || e === null) return false;
  const candidate = e as { name?: unknown; code?: unknown };
  return candidate.name === XR_SESSION_ERROR_NAME && typeof candidate.code === 'string';
};

/**
 * Map a `requestSession` rejection onto a code and a sentence.
 *
 * The mode is threaded through because the honest explanation differs: an
 * `immersive-ar` denial on Android is very often the site's CAMERA permission
 * being blocked (AR passthrough needs it, and Chrome surfaces that refusal as
 * the same NotAllowedError as dismissing the XR consent prompt), whereas an
 * `immersive-vr` denial never involves a camera and telling a Quest user to
 * check their camera permission would be nonsense.
 *
 * NotSupportedError is deliberately NOT split into "mode unsupported" versus
 * "required feature unsupported". Chrome uses the same DOMException name for
 * both and the distinguishing text is not stable enough to parse, so the code is
 * one value and the message names both possibilities rather than guessing.
 */
const describeRequestFailure = (
  err: unknown,
  mode: XRSessionMode,
  requiredFeatures: string[],
): XrSessionError => {
  const name = (err as { name?: string } | null)?.name || '';
  const detail = (err as { message?: string } | null)?.message || String(err);

  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return new XrSessionError(
      'denied',
      mode,
      mode === 'immersive-ar'
        ? 'Permission for AR was declined. AR needs camera access — allow the camera for this site, then try again.'
        : 'Permission for the immersive session was declined.',
      err,
    );
  }
  if (name === 'SecurityError') {
    return new XrSessionError('insecure-context', mode, INSECURE_CONTEXT_MESSAGE, err);
  }
  if (name === 'NotSupportedError') {
    const features = requiredFeatures.length ? ` (required: ${requiredFeatures.join(', ')})` : '';
    return new XrSessionError(
      'unsupported',
      mode,
      `This device cannot start ${modeLabel(mode)}${features}.`,
      err,
    );
  }
  if (name === 'AbortError' || name === 'InvalidStateError') {
    return new XrSessionError(
      'aborted',
      mode,
      `Starting ${modeLabel(mode)} was interrupted. Another session may already be running.`,
      err,
    );
  }
  return new XrSessionError('failed', mode, detail, err);
};

/* ────────────────────────────────────────────────────────────────────────────
   Feature negotiation

   A required feature the device lacks makes `requestSession` reject outright,
   with a NotSupportedError whose text no user can act on. An optional feature
   the device lacks costs nothing: the session opens without it and
   `session.enabledFeatures` says so. The split below therefore encodes exactly
   one question per feature — "is the experience meaningless without this?" —
   and everything the app can degrade around is optional.
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * `hit-test` is the only genuinely required one, and only for AR.
 *
 * Tap-to-place against a real surface IS the AR product here. Without hit-test
 * the alternative is to hang the splat at a guessed distance in front of the
 * camera, which is a worse thing than an honest "your device can't do this" —
 * it looks broken rather than absent, because the memory floats through the
 * furniture. Every device that reports `immersive-ar` today (Android Chrome,
 * Quest browser) also supports hit-test, so this rejects essentially nobody;
 * it is three.js's own `ARButton` default for the same reason.
 */
export const AR_REQUIRED_FEATURES: readonly string[] = ['hit-test'];

/**
 * `local-floor` is optional even though placement wants it.
 *
 * It is not one of the two reference spaces the spec guarantees (`viewer` and
 * `local` are), so requiring it hands a hard failure to any device that has not
 * yet found a floor plane — which on a handheld phone is the entire first second
 * of every session. `resolveReferenceSpace` below falls back to `local`, whose
 * origin is the headset's starting pose; the placement is then relative to the
 * viewer instead of the floor, which is a slightly worse experience and not a
 * broken one.
 */
export const AR_OPTIONAL_FEATURES: readonly string[] = ['local-floor'];

/** Nothing is required for VR: the mode alone gets you a rendering surface. */
export const VR_REQUIRED_FEATURES: readonly string[] = [];

/**
 * `bounded-floor` as well as `local-floor`, because on a room-scale headset it
 * gives the guardian polygon, which is the difference between placing a
 * room-sized splat in the room and placing it inside a wall.
 */
export const VR_OPTIONAL_FEATURES: readonly string[] = ['local-floor', 'bounded-floor'];

const defaultFeatures = (mode: XRSessionMode): { required: string[]; optional: string[] } => {
  switch (mode) {
    case 'immersive-ar':
      return { required: AR_REQUIRED_FEATURES.slice(), optional: AR_OPTIONAL_FEATURES.slice() };
    case 'immersive-vr':
      return { required: VR_REQUIRED_FEATURES.slice(), optional: VR_OPTIONAL_FEATURES.slice() };
    case 'inline':
      return { required: [], optional: [] };
    default:
      return { required: [], optional: [] };
  }
};

/** Written out rather than `Array.from(new Set(...))`: es5 target, no iterator helpers. */
const dedupe = (values: string[]): string[] => values.filter((v, i) => values.indexOf(v) === i);

export interface XrSessionRequestOptions {
  /** Defaults to `immersive-ar`. */
  mode?: XRSessionMode;
  /**
   * Element to expose to the session as the DOM overlay root. Supplying one
   * adds `dom-overlay` to the OPTIONAL features and sets `domOverlay.root`.
   *
   * This is how handheld AR gets any UI at all — on a phone the page is replaced
   * by the camera feed, so without an overlay there is no Exit button, no
   * placement hint and no way out except the system back gesture. It stays
   * optional because a headset browser may not implement it, and losing the
   * overlay is survivable while losing the whole session is not.
   *
   * The root must be attached to the document when the session starts and must
   * stay attached: a detached (or later unmounted) root gives a session whose
   * `domOverlayState` is undefined, i.e. an AR view with no controls.
   */
  domOverlayRoot?: Element | null;
  /** Merged with the per-mode defaults, not a replacement for them. */
  requiredFeatures?: string[];
  /** Merged with the per-mode defaults. Anything also required is dropped from here. */
  optionalFeatures?: string[];
  /** Test seam / explicit environment. */
  env?: XrEnvironment;
}

/**
 * The pure half of the request: mode + options → the exact `XRSessionInit`.
 *
 * Split out and exported so the feature negotiation can be asserted without a
 * fake `XRSystem`, and so a caller can log precisely what it is about to ask
 * for. A feature listed as both required and optional is dropped from the
 * optional list — the spec says the required list wins, but some UAs have
 * historically counted the duplicate as a second consent-requiring feature.
 */
export const buildXrSessionInit = (
  mode: XRSessionMode,
  options: Pick<
    XrSessionRequestOptions,
    'requiredFeatures' | 'optionalFeatures' | 'domOverlayRoot'
  > = {},
): XRSessionInit => {
  const defaults = defaultFeatures(mode);
  const required = dedupe(defaults.required.concat(options.requiredFeatures || []));

  const root = options.domOverlayRoot || null;
  const optional = dedupe(
    defaults.optional.concat(options.optionalFeatures || []).concat(root ? ['dom-overlay'] : []),
  ).filter((f) => required.indexOf(f) === -1);

  const init: XRSessionInit = { requiredFeatures: required, optionalFeatures: optional };
  if (root) init.domOverlay = { root };
  return init;
};

/* ────────────────────────────────────────────────────────────────────────────
   Session lifecycle
   ──────────────────────────────────────────────────────────────────────────── */

export interface XrSessionHandle {
  readonly session: XRSession;
  readonly mode: XRSessionMode;
  /** Exactly what was asked for, for logging and for the `isFeatureEnabled` fallback. */
  readonly requestedFeatures: { required: string[]; optional: string[] };
  /** `session.enabledFeatures`, or null on a UA that does not report it. */
  readonly enabledFeatures: readonly string[] | null;
  /** False once the session has ended, however it ended. */
  readonly active: boolean;
  isFeatureEnabled(name: string): boolean;
  /** @returns an unsubscribe function. Listeners fire at most once. */
  onEnd(listener: () => void): () => void;
  /** Idempotent. Resolves once the session is down; never rejects. */
  end(): Promise<void>;
}

/**
 * One session, module-wide.
 *
 * `pending` is separate from `active` and is the half that actually matters.
 * `requestSession` is asynchronous, so a guard that only inspects the resolved
 * session lets two clicks 50 ms apart both pass the check and both call into the
 * UA. What happens then is UA-specific and all of it is bad: Chrome rejects the
 * second with InvalidStateError (recoverable), while some runtimes tear down the
 * first session to grant the second, leaving the app holding a handle to a dead
 * session and a live session nobody is rendering into. Holding the in-flight
 * promise closes that window.
 */
let activeHandle: XrSessionHandle | null = null;
let pendingRequest: Promise<XrSessionHandle> | null = null;

const ALREADY_ACTIVE_MESSAGE =
  'An immersive session is already open or starting. End it before requesting another.';

const makeHandle = (
  session: XRSession,
  mode: XRSessionMode,
  requestedFeatures: { required: string[]; optional: string[] },
): XrSessionHandle => {
  let ended = false;
  const listeners: Array<() => void> = [];

  /*
    Idempotent, and called from BOTH the `end` event and the `end()` method.

    Not just from the event, because a session that is ended programmatically is
    supposed to dispatch `end` but polyfills and older runtimes have shipped
    without doing so. If this only ran on the event, such a runtime would leave
    `activeHandle` non-null forever: the UI would sit on "Exit AR" with no
    session behind it and no way to request a new one, which is unrecoverable
    without a page reload.

    Not just from the method, because the far more common case is the session
    ending for reasons the app never initiated — the headset comes off, the user
    swipes the system back gesture, the OS pre-empts for a call.
  */
  const markEnded = () => {
    if (ended) return;
    ended = true;
    session.removeEventListener('end', markEnded);
    if (activeHandle === handle) activeHandle = null;
    // Copied before iterating: an unsubscribe called from inside a listener
    // would otherwise mutate the array mid-loop and skip the next listener.
    listeners.splice(0, listeners.length).forEach((l) => {
      try {
        l();
      } catch {
        /* A throwing teardown listener must not stop the others running, and
           must not surface as an unhandled rejection out of `end()`. */
      }
    });
  };

  const handle: XrSessionHandle = {
    session,
    mode,
    requestedFeatures,
    get enabledFeatures() {
      return session.enabledFeatures ?? null;
    },
    get active() {
      return !ended;
    },
    isFeatureEnabled(name: string) {
      const enabled = session.enabledFeatures;
      if (enabled) return enabled.indexOf(name) !== -1;
      /*
        No `enabledFeatures` on this UA (it postdates the core spec and Quest's
        browser was late to it). Fall back to what we can prove: a REQUIRED
        feature must be present, because the request would have rejected with
        NotSupportedError otherwise. An optional one is unknowable, and the safe
        answer is false — a caller that believes it has hit-test and does not
        will throw on the first `requestHitTestSource`, whereas one that believes
        it lacks a feature it actually has merely renders the fallback.
      */
      return requestedFeatures.required.indexOf(name) !== -1;
    },
    onEnd(listener: () => void) {
      if (ended) {
        listener();
        return () => undefined;
      }
      listeners.push(listener);
      return () => {
        const i = listeners.indexOf(listener);
        if (i !== -1) listeners.splice(i, 1);
      };
    },
    async end() {
      if (ended) return;
      try {
        await session.end();
      } catch {
        /* `end()` rejects if the session is already ending — a race with the
           user pulling the headset off. There is nothing to recover: either way
           the session is gone, which is all the caller wanted. */
      }
      markEnded();
    },
  };

  /*
    `addEventListener`, not `onend`. Assigning `session.onend` would silently
    overwrite a handler set by anything else holding this session — including
    three.js's WebXRManager, which attaches its own teardown when the session is
    handed to `renderer.xr.setSession()`. Clobbering that leaks the render loop.
  */
  session.addEventListener('end', markEnded);

  return handle;
};

const openSession = async (
  mode: XRSessionMode,
  options: XrSessionRequestOptions,
): Promise<XrSessionHandle> => {
  const env = options.env || readXrEnvironment();
  const xr = env.xr;

  if (!xr || typeof xr.requestSession !== 'function') {
    const missing = missingWebXrReason(env);
    throw new XrSessionError(
      missing?.reason === 'insecure-context' ? 'insecure-context' : 'no-webxr',
      mode,
      missing?.message || NO_WEBXR_MESSAGE,
    );
  }

  const init = buildXrSessionInit(mode, options);
  const requestedFeatures = {
    required: (init.requiredFeatures || []).slice(),
    optional: (init.optionalFeatures || []).slice(),
  };

  /*
    Straight to `requestSession`. This deliberately does NOT re-check
    `isSessionSupported` first.

    Immersive session requests need transient user activation, and activation is
    consumed/expires around awaits — an `isSessionSupported` round trip inserted
    between the click and the request is exactly the kind of thing that turns
    "Enter AR" into a button that works on a fast device and silently fails on a
    slow one. The support query belongs where `detectXrCapabilities` puts it: at
    the point the control is rendered, well before any click. That is the same
    architecture the capture constraint already forces (render the control only
    on a confirmed `true`), so by the time this runs the answer is known.
  */
  let session: XRSession;
  try {
    session = await xr.requestSession(mode, init);
  } catch (err) {
    throw describeRequestFailure(err, mode, requestedFeatures.required);
  }

  return makeHandle(session, mode, requestedFeatures);
};

/**
 * Start an immersive session. Call from a user gesture.
 *
 * Written as a non-async function that returns a promise, rather than an async
 * function, for one specific reason: the duplicate-request guard has to be set
 * BEFORE the first suspension point, and an async function cannot store its own
 * promise. This shape makes `pendingRequest` observably non-null the instant the
 * first call returns, so the second click's guard sees it.
 *
 * @throws {XrSessionError} always — every rejection from this function is one,
 *         so a caller can use `isXrSessionError` for exhaustive handling.
 */
export const requestXrSession = (
  options: XrSessionRequestOptions = {},
): Promise<XrSessionHandle> => {
  const mode: XRSessionMode = options.mode || 'immersive-ar';

  if (pendingRequest || (activeHandle && activeHandle.active)) {
    return Promise.reject(new XrSessionError('already-active', mode, ALREADY_ACTIVE_MESSAGE));
  }

  const request = openSession(mode, options).then(
    (handle) => {
      pendingRequest = null;
      // `handle.active` can already be false if the session ended between being
      // granted and this microtask — a headset taken off mid-request. Adopting
      // it then would install a dead session as the active one.
      activeHandle = handle.active ? handle : null;
      return handle;
    },
    (err) => {
      pendingRequest = null;
      throw err;
    },
  );

  pendingRequest = request;
  return request;
};

/** The live session, or null. Cleared automatically when the session ends. */
export const getActiveXrSession = (): XrSessionHandle | null =>
  activeHandle && activeHandle.active ? activeHandle : null;

/** End the live session if there is one. Safe to call unconditionally; never rejects. */
export const endXrSession = async (): Promise<void> => {
  const handle = activeHandle;
  if (handle) {
    await handle.end();
    return;
  }

  /*
    Cancelling DURING the request, which is the window this used to ignore.

    `activeHandle` is only assigned once `requestSession` resolves, so between
    the click that starts AR and the headset/phone actually granting a session
    there is a stretch — a user consent prompt, so potentially many seconds —
    where this function found nothing and returned. The caller had already
    switched its UI into the entering state, where the AR overlay stops being
    `pointer-events-none` and covers the viewer: orbit was dead, and the one
    control offered, "Exit AR", did nothing at all. The only way out was to
    grant a session and then leave it.

    Awaiting the pending request and ending whatever it produces is the honest
    fix — there is no way to retract an in-flight `requestSession`, so the
    session may briefly exist before closing. `.catch` because a request that
    REJECTS is already the outcome the user asked for; surfacing its error from
    a cancel path would report a failure for something that succeeded.
  */
  const pending = pendingRequest;
  if (!pending) return;
  const settled = await pending.catch(() => null);
  if (settled) await settled.end();
};

/**
 * Test seam. Drops the module's session state without touching a real session.
 *
 * Only for suites: calling this in the app would strand a live XRSession with
 * nothing holding a reference to end it.
 */
export const resetXrSessionState = (): void => {
  activeHandle = null;
  pendingRequest = null;
};

/* ────────────────────────────────────────────────────────────────────────────
   Reference spaces
   ──────────────────────────────────────────────────────────────────────────── */

export interface XrReferenceSpaceResult {
  space: XRReferenceSpace;
  type: XRReferenceSpaceType;
}

/**
 * Preference order, best first.
 *
 * `local-floor` puts the origin on the floor, which is what placing a
 * room-scale memory wants. `local` puts it at the viewer's starting pose, which
 * is workable. `viewer` is head-locked and is a genuinely poor experience — but
 * the spec guarantees it for every session, so it is here as the terminator that
 * makes the loop total.
 */
export const XR_REFERENCE_SPACE_FALLBACKS: readonly XRReferenceSpaceType[] = [
  'local-floor',
  'local',
  'viewer',
];

/**
 * Ask for the best reference space the session will actually give us.
 *
 * This is the other half of making `local-floor` optional: a caller that just
 * calls `requestReferenceSpace('local-floor')` gets a rejection on every device
 * where the optional feature was not granted, which converts a deliberate soft
 * failure back into a hard one. Walking the list is what makes the optional
 * feature safe to have asked for.
 */
export const resolveReferenceSpace = async (
  session: Pick<XRSession, 'requestReferenceSpace'>,
  preferred: readonly XRReferenceSpaceType[] = XR_REFERENCE_SPACE_FALLBACKS,
): Promise<XrReferenceSpaceResult> => {
  let lastError: unknown;
  for (let i = 0; i < preferred.length; i += 1) {
    const type = preferred[i];
    try {
      const space = await session.requestReferenceSpace(type);
      return { space, type };
    } catch (err) {
      lastError = err;
    }
  }
  throw new XrSessionError(
    'failed',
    'immersive-ar',
    `No usable reference space. Tried: ${preferred.join(', ')}.`,
    lastError,
  );
};
