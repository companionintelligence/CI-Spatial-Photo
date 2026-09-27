import React from 'react';
// Imported per-suite rather than from a shared setup file, matching TopBar.test.tsx:
// this repo has no src/setupTests.ts, and adding one changes every other suite's
// environment.
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ServerPanel, ServerSetup } from './ServerPicker';
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

    type('photo-origin.ci.computer');
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));

    await waitFor(() => expect(onConnected).toHaveBeenCalled());
    // Normalized on the way in: a bare host becomes https, not http.
    expect(getApiTarget()).toBe('https://photo-origin.ci.computer');
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
    render(<ServerPanel target="https://photo-origin.ci.computer" onClose={jest.fn()} />);
    expect(screen.getByText('https://photo-origin.ci.computer')).toBeInTheDocument();
  });

  it('names same-origin in words rather than showing the sentinel', () => {
    render(<ServerPanel target="same-origin" onClose={jest.fn()} />);
    expect(screen.getByText(/this host/i)).toBeInTheDocument();
    expect(screen.queryByText('same-origin')).not.toBeInTheDocument();
  });

  it('forgetting clears the target so the setup card comes back', async () => {
    window.localStorage.setItem('ci_api_base', 'https://photo-origin.ci.computer');
    resetApiTargetCache();
    const onClose = jest.fn();
    render(<ServerPanel target="https://photo-origin.ci.computer" onClose={onClose} />);

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
