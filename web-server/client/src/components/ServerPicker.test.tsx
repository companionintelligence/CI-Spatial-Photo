import React from 'react';
// Imported per-suite rather than from a shared setup file, matching TopBar.test.tsx:
// this repo has no src/setupTests.ts, and adding one changes every other suite's
// environment.
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ServerPanel, ServerSetup, presetsFor } from './ServerPicker';
import { getApiTarget, resetApiTargetCache } from '../utils/apiTarget';

/*
  jsdom has no fetch, so `probeServer` needs one. These build the two answers that
  matter: a server that is there, and one that is not.
*/
const reachable = (version = '2.0.0', engines = 2) =>
  jest.spyOn(global, 'fetch').mockImplementation((input) =>
    Promise.resolve(
      (String(input).endsWith('/healthz')
        ? { ok: true, status: 200, json: async () => ({ status: 'ok', version }) }
        : {
            ok: true,
            status: 200,
            json: async () => ({ engines: Array.from({ length: engines }, () => ({})) }),
          }) as Response,
    ),
  );

const unreachable = () =>
  jest.spyOn(global, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));

beforeEach(() => {
  window.localStorage.clear();
  resetApiTargetCache();
});

afterEach(() => jest.restoreAllMocks());

/** Set the address field's value the way the rest of this suite drives inputs. */
function type(value: string) {
  fireEvent.change(screen.getByLabelText(/processing server address/i), { target: { value } });
}

describe('ServerSetup', () => {
  it('stores the server and reports back only after the probe succeeds', async () => {
    reachable('2.0.0', 3);
    const onConnected = jest.fn();
    render(<ServerSetup onConnected={onConnected} />);

    type('my-server.example.com');
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));

    await waitFor(() => expect(onConnected).toHaveBeenCalled());
    // Normalized on the way in: a bare host becomes https, not http.
    expect(getApiTarget()).toBe('https://my-server.example.com');
    expect(screen.getByRole('status')).toHaveTextContent(/version 2\.0\.0/i);
    expect(screen.getByRole('status')).toHaveTextContent(/3 engines/i);
  });

  it('stores nothing when the server cannot be reached', async () => {
    unreachable();
    const onConnected = jest.fn();
    render(<ServerSetup onConnected={onConnected} />);

    type('https://nope.example');
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    // The whole point of probing first: a bad address must not become the stored one,
    // or the app boots into a state where every request fails and the setup card is gone.
    expect(getApiTarget()).toBeNull();
    expect(onConnected).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/not running|blocked|CORS/i);
  });

  it('connects in one click from the "This machine" preset', async () => {
    reachable();
    render(<ServerSetup onConnected={jest.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /this machine/i }));

    await waitFor(() => expect(getApiTarget()).toBe('http://localhost:8000'));
  });

  it('offers same-origin for a single-host deployment', async () => {
    reachable();
    render(<ServerSetup onConnected={jest.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /same host as this page/i }));

    await waitFor(() => expect(getApiTarget()).toBe('same-origin'));
  });

  it('will not submit an address it cannot parse', async () => {
    render(<ServerSetup onConnected={jest.fn()} />);
    const connect = screen.getByRole('button', { name: /^connect$/i });

    // Empty is the initial state.
    expect(connect).toBeDisabled();
    type('javascript:alert(1)');
    expect(connect).toBeDisabled();
  });

  it('drops a stale verdict when the address changes underneath it', async () => {
    reachable();
    render(<ServerSetup onConnected={jest.fn()} />);
    type('https://good.example');
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/connected/i));

    // A green tick sitting next to a different URL is the one genuinely misleading
    // state this form could have.
    type('https://good.example2');
    expect(screen.getByRole('status')).not.toHaveTextContent(/connected/i);
  });
});

describe('ServerPanel', () => {
  it('shows which server is in use', () => {
    render(<ServerPanel target="https://my-server.example.com" onClose={jest.fn()} />);
    expect(screen.getByText('https://my-server.example.com')).toBeInTheDocument();
  });

  it('names same-origin in words rather than showing the sentinel', () => {
    render(<ServerPanel target="same-origin" onClose={jest.fn()} />);
    expect(screen.getByText(/this host/i)).toBeInTheDocument();
    expect(screen.queryByText('same-origin')).not.toBeInTheDocument();
  });

  it('forgetting clears the target so the setup card comes back', async () => {
    window.localStorage.setItem('ci_api_base', 'https://my-server.example.com');
    resetApiTargetCache();
    const onClose = jest.fn();
    render(<ServerPanel target="https://my-server.example.com" onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: /forget/i }));

    expect(getApiTarget()).toBeNull();
    expect(onClose).toHaveBeenCalled();
  });

  it('switching servers probes the new one before adopting it', async () => {
    window.localStorage.setItem('ci_api_base', 'https://old.example');
    resetApiTargetCache();
    unreachable();
    render(<ServerPanel target="https://old.example" onClose={jest.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /change server/i }));
    type('https://new.example');
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    // A failed switch leaves the working server in place.
    expect(getApiTarget()).toBe('https://old.example');
  });
});

/*
  Inside the apps. What each runtime leaves on `window` (utils/nativeShell.ts): Tauri's
  internals in the desktop app, Capacitor's native bridge in the Android app.
*/
const shellGlobals = window as unknown as { __TAURI_INTERNALS__?: unknown; Capacitor?: unknown };
const inDesktopApp = () => {
  shellGlobals.__TAURI_INTERNALS__ = {};
};
const inAndroidApp = () => {
  shellGlobals.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android' };
};

describe('ServerSetup inside the desktop and Android apps', () => {
  afterEach(() => {
    delete shellGlobals.__TAURI_INTERNALS__;
    delete shellGlobals.Capacitor;
  });

  it('drops "Same host as this page" in the desktop app and keeps "This machine"', async () => {
    // The app's own page (tauri://localhost, http://tauri.localhost) has no server behind it,
    // while localhost is still the computer the app runs on.
    inDesktopApp();
    reachable();
    render(<ServerSetup onConnected={jest.fn()} />);

    expect(screen.queryByRole('button', { name: /same host as this page/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /this machine/i }));
    await waitFor(() => expect(getApiTarget()).toBe('http://localhost:8000'));
  });

  it('offers neither preset in the Android app, where localhost is the phone', () => {
    inAndroidApp();
    render(<ServerSetup onConnected={jest.fn()} />);

    expect(screen.queryByRole('button', { name: /this machine/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /same host as this page/i })).not.toBeInTheDocument();
    // The copy that sent people to "This machine" says what to type instead.
    expect(screen.queryByText(/choose .this machine/i)).not.toBeInTheDocument();
    expect(screen.getByText(/not on this phone/i)).toHaveTextContent(/18831/);
  });

  it('talks about the app, not the browser, in either app', () => {
    inDesktopApp();
    const { unmount } = render(<ServerSetup onConnected={jest.fn()} />);
    expect(screen.getByText(/remembered in this app only/i)).toBeInTheDocument();
    expect(screen.queryByText(/this page is static/i)).not.toBeInTheDocument();
    unmount();

    delete shellGlobals.__TAURI_INTERNALS__;
    inAndroidApp();
    render(<ServerSetup onConnected={jest.fn()} />);
    expect(screen.getByText(/remembered in this app only/i)).toBeInTheDocument();
  });

  it('warns in the Android app that a typed localhost is the phone itself', () => {
    inAndroidApp();
    render(<ServerSetup onConnected={jest.fn()} />);
    type('http://localhost:8000');
    expect(screen.getByRole('status')).toHaveTextContent(/phone itself/i);
  });

  it('connects the Android app to a plain-HTTP address on the network, with no caveat', async () => {
    // The app allows cleartext and its page is http://localhost, so nothing here is mixed
    // content and the browser's half-works warning would be wrong.
    inAndroidApp();
    reachable();
    const onConnected = jest.fn();
    render(<ServerSetup onConnected={onConnected} />);

    type('http://mac-studio.local:8000');
    expect(screen.getByRole('status')).toHaveTextContent('');
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));
    await waitFor(() => expect(onConnected).toHaveBeenCalled());
    expect(getApiTarget()).toBe('http://mac-studio.local:8000');
  });

  it('leaves the website as it was', () => {
    render(<ServerSetup onConnected={jest.fn()} />);
    expect(screen.getByRole('button', { name: /this machine/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /same host as this page/i })).toBeInTheDocument();
    expect(screen.getByText(/remembered in this browser only/i)).toBeInTheDocument();
  });
});

describe('presetsFor', () => {
  const labels = (shell: Parameters<typeof presetsFor>[0], sameHostUnavailable = false) =>
    presetsFor(shell, sameHostUnavailable).map((p) => p.label);

  it('offers both presets on the website, and hides same-host where it cannot work', () => {
    expect(labels(null)).toEqual(['This machine', 'Same host as this page']);
    expect(labels(null, true)).toEqual(['This machine']);
  });

  it('keeps only "This machine" on the desktop and nothing on Android', () => {
    expect(labels('desktop')).toEqual(['This machine']);
    expect(labels('android')).toEqual([]);
  });
});
