import { nativeShell } from './nativeShell';

/*
  What each runtime leaves on `window`, as the real ones do: Tauri 2 injects
  `__TAURI_INTERNALS__` into every page it loads, and Capacitor's Android bridge injects a
  `Capacitor` object whose platform is 'android'. The website has neither.
*/
type Globals = { __TAURI_INTERNALS__?: unknown; isTauri?: unknown; Capacitor?: unknown };
const globals = window as unknown as Globals;

/** A window whose location is the given URL, for the origin checks. */
function windowAt(href: string): Window {
  const url = new URL(href);
  return { location: { href, protocol: url.protocol, hostname: url.hostname } } as unknown as Window;
}

afterEach(() => {
  delete globals.__TAURI_INTERNALS__;
  delete globals.isTauri;
  delete globals.Capacitor;
});

describe('nativeShell', () => {
  it('is null on the website, which is also what every other suite sees', () => {
    expect(nativeShell()).toBeNull();
    expect(nativeShell(windowAt('https://photo.ci.computer/'))).toBeNull();
    expect(nativeShell(windowAt('http://localhost:3000/'))).toBeNull();
  });

  it('recognises the desktop app by the globals Tauri injects', () => {
    globals.__TAURI_INTERNALS__ = {};
    expect(nativeShell()).toBe('desktop');
    delete globals.__TAURI_INTERNALS__;
    globals.isTauri = true;
    expect(nativeShell()).toBe('desktop');
  });

  it("recognises the desktop app's bundled page by its origin on every platform", () => {
    expect(nativeShell(windowAt('tauri://localhost/'))).toBe('desktop');
    expect(nativeShell(windowAt('http://tauri.localhost/view/abc'))).toBe('desktop');
    expect(nativeShell(windowAt('https://tauri.localhost/'))).toBe('desktop');
  });

  it('recognises the Android app by its native Capacitor bridge', () => {
    globals.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android' };
    expect(nativeShell()).toBe('android');
  });

  it('is not fooled by a Capacitor object that is not the Android app', () => {
    // Capacitor's web build, a page's own variable, or a platform this repo does not ship.
    globals.Capacitor = { isNativePlatform: () => false, getPlatform: () => 'web' };
    expect(nativeShell()).toBeNull();
    globals.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios' };
    expect(nativeShell()).toBeNull();
    globals.Capacitor = { isNativePlatform: () => { throw new Error('nope'); } };
    expect(nativeShell()).toBeNull();
    globals.Capacitor = 'not an object';
    expect(nativeShell()).toBeNull();
  });

  it('is null without a window at all', () => {
    expect(nativeShell(undefined)).toBeNull();
  });
});
