/**
 * Which app, if any, this viewer is running inside.
 *
 * The same build is the website and the inside of the desktop app (desktop/, Tauri) and the
 * Android app (mobile/, Capacitor). Two things the server picker says are only true on the
 * website, and this is how it tells:
 *
 *   - "Same host as this page" means a server behind the page's own origin. An app's page
 *     comes from inside the app (tauri://localhost, http://tauri.localhost,
 *     http://localhost), and no server answers there.
 *   - "This machine", http://localhost:8000, is the computer running the browser. In the
 *     Android app, localhost is the phone.
 *
 * Detection reads what each runtime puts on `window` before the bundle runs, and never
 * imports either runtime: the website must not carry them, and the viewer never calls a
 * native API.
 */

export type NativeShell = 'desktop' | 'android';

interface ShellGlobals {
  /** Tauri 2 injects this into every page it loads, release builds included. */
  __TAURI_INTERNALS__?: unknown;
  /** Set by Tauri 2 as well; checked in case the internals are ever renamed. */
  isTauri?: unknown;
  /** Capacitor's native bridge, injected ahead of the page's own scripts. */
  Capacitor?: { getPlatform?: () => string; isNativePlatform?: () => boolean };
}

/** The app this page is inside, or null on the website (and in tests). */
export function nativeShell(win: Window | undefined = typeof window === 'undefined' ? undefined : window): NativeShell | null {
  if (!win) return null;
  const globals = win as unknown as ShellGlobals;

  if (globals.__TAURI_INTERNALS__ !== undefined || globals.isTauri === true) return 'desktop';
  // The bundled page's own origin, in case the globals are not there yet.
  const { protocol, hostname } = win.location;
  if (protocol === 'tauri:' || hostname === 'tauri.localhost') return 'desktop';

  const capacitor = globals.Capacitor;
  try {
    if (capacitor?.isNativePlatform?.() && capacitor.getPlatform?.() === 'android') return 'android';
  } catch {
    // A page that defines its own `Capacitor` is not the app.
  }
  return null;
}
