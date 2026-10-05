import {
  SAME_ORIGIN,
  classifyHost,
  describeTarget,
  getApiBase,
  getApiTarget,
  isConfigured,
  localFetchOptions,
  normalizeTarget,
  probeServer,
  resetApiTargetCache,
  setApiTarget,
  subscribeApiTarget,
} from './apiTarget';

/*
  jsdom does not implement fetch, so there is no global `Response` to construct. These
  stand in for one with exactly the surface the code under test touches.
*/
const jsonResponse = (body: unknown, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) } as Response);
const errorResponse = (status: number): Response =>
  ({ ok: false, status, json: async () => ({}), text: async () => 'nope' } as Response);

/*
  The page's own origin decides whether a target has caveats, so several tests need to
  move it. jsdom's location is not writable, so replace the descriptor.
*/
function setPageOrigin(href: string) {
  const url = new URL(href);
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: {
      ...window.location,
      href,
      protocol: url.protocol,
      hostname: url.hostname,
      host: url.host,
      origin: url.origin,
    },
  });
}

const originalLocation = window.location;

beforeEach(() => {
  window.localStorage.clear();
  resetApiTargetCache();
});

afterEach(() => {
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: originalLocation,
  });
  jest.restoreAllMocks();
});

describe('normalizeTarget', () => {
  it('keeps scheme, host and port and drops everything after them', () => {
    // A base carrying a path would build `https://h/some/path/api/v1/...`, and one
    // carrying a query would build `...?x=1/api/v1/...`. Neither is a real route.
    expect(normalizeTarget('https://my-server.example.com/some/path?x=1#frag')).toBe(
      'https://my-server.example.com',
    );
    expect(normalizeTarget('http://localhost:8000/')).toBe('http://localhost:8000');
    expect(normalizeTarget('  http://localhost:8000///  ')).toBe('http://localhost:8000');
  });

  it('assumes https for a bare host, not http', () => {
    // Guessing http would produce a mixed-content block, which reads to a user as
    // "the app is broken". Guessing https produces a connection error that names itself.
    expect(normalizeTarget('ci-hub.example')).toBe('https://ci-hub.example');
    expect(normalizeTarget('ci-hub.example:8443')).toBe('https://ci-hub.example:8443');
  });

  it('passes the same-origin sentinel through untouched', () => {
    expect(normalizeTarget(SAME_ORIGIN)).toBe(SAME_ORIGIN);
  });

  it('refuses anything that is not http(s), and anything empty', () => {
    // This string is concatenated into a fetch URL, so the scheme check is a whitelist.
    expect(normalizeTarget('javascript:alert(1)')).toBeNull();
    expect(normalizeTarget('data:text/html,hi')).toBeNull();
    expect(normalizeTarget('file:///etc/passwd')).toBeNull();
    expect(normalizeTarget('')).toBeNull();
    expect(normalizeTarget('   ')).toBeNull();
  });
});

describe('classifyHost', () => {
  it('recognises loopback by name and by literal', () => {
    ['localhost', '127.0.0.1', 'LOCALHOST', 'api.localhost'].forEach((h) =>
      expect(classifyHost(h)).toBe('loopback'),
    );
  });

  it('recognises the private ranges and mDNS names', () => {
    ['10.0.0.5', '192.168.1.50', '172.16.0.1', '172.31.255.255', 'mac-studio.local'].forEach(
      (h) => expect(classifyHost(h)).toBe('private'),
    );
  });

  it('does not mistake a near-miss range for private', () => {
    // 172.15 and 172.32 are outside RFC1918; a regex that checked only `172.` would
    // wrongly exempt public hosts from the mixed-content warning.
    ['172.15.0.1', '172.32.0.1', '11.0.0.1', '193.168.1.1'].forEach((h) =>
      expect(classifyHost(h)).toBe('public'),
    );
  });

  it('treats a name that merely resolves privately as public', () => {
    // Chrome cannot classify it up front either, which is exactly why such a target
    // gets no mixed-content exemption. Conservative is correct here.
    expect(classifyHost('nas.example.com')).toBe('public');
  });
});

describe('describeTarget warnings', () => {
  it('says nothing about an HTTPS public target — the case with no caveats', () => {
    setPageOrigin('https://photo.ci.computer/');
    expect(describeTarget('https://my-server.example.com').warnings).toEqual([]);
  });

  it('warns about the local-network permission when a public page reaches loopback', () => {
    setPageOrigin('https://photo.ci.computer/');
    const info = describeTarget('http://localhost:8000');
    expect(info.space).toBe('loopback');
    expect(info.warnings.join(' ')).toMatch(/permission/i);
    // And that "localhost" is this desk only — the mistake someone makes once, by
    // configuring it on their laptop and then opening the app on their phone.
    expect(info.warnings.join(' ')).toMatch(/phone|headset/i);
  });

  it('warns that thumbnails and meshes break on a plain-HTTP private address', () => {
    // The asymmetry worth naming: splats go through fetch and can be annotated,
    // thumbnails are <img src> and meshes are <model-viewer src> and cannot.
    setPageOrigin('https://photo.ci.computer/');
    const info = describeTarget('http://192.168.1.50:8000');
    expect(info.space).toBe('private');
    expect(info.warnings.join(' ')).toMatch(/thumbnail/i);
    expect(info.warnings.join(' ')).toMatch(/mesh/i);
  });

  it('stays quiet when the page itself is local — same address space, no LNA', () => {
    // `npm start` talking to a local server is the fully-local mode, and Chrome does
    // not prompt for same-space requests.
    setPageOrigin('http://localhost:3000/');
    expect(describeTarget('http://localhost:8000').warnings).toEqual([]);
  });

  it('does not invoke mixed content against a page that is itself HTTP', () => {
    // A loopback dev page reaching a LAN server: no HTTPS anywhere, so no mixed-content
    // rule applies, and loopback -> LAN moves toward the public end so there is no
    // local-network prompt either. Warning here would be pure noise — and this is the
    // case a browser screenshot caught the first version getting wrong.
    setPageOrigin('http://127.0.0.1:8787/');
    expect(describeTarget('http://192.168.1.50:8000').warnings).toEqual([]);
  });

  it('describes same-origin as secure with no caveats', () => {
    const info = describeTarget(SAME_ORIGIN);
    expect(info.base).toBe('');
    expect(info.space).toBe('same-origin');
    expect(info.warnings).toEqual([]);
  });
});

describe('the store', () => {
  it('starts unconfigured, so the app asks instead of guessing', () => {
    // The deployed bundle is built with no REACT_APP_API_BASE precisely so this holds.
    expect(getApiTarget()).toBeNull();
    expect(isConfigured()).toBe(false);
    expect(getApiBase()).toBe('');
  });

  it('round-trips a target through localStorage and notifies subscribers', () => {
    const seen: (string | null)[] = [];
    setApiTarget('https://my-server.example.com');
    seen.push(getApiTarget());

    expect(seen).toEqual(['https://my-server.example.com']);
    expect(getApiBase()).toBe('https://my-server.example.com');
    expect(isConfigured()).toBe(true);

    resetApiTargetCache();
    expect(getApiTarget()).toBe('https://my-server.example.com');
  });

  it('normalizes on the way in', () => {
    setApiTarget('my-server.example.com/ignored/path');
    expect(getApiTarget()).toBe('https://my-server.example.com');
  });

  it('rejects an unusable value without disturbing the current one', () => {
    setApiTarget('https://good.example');
    expect(setApiTarget('javascript:alert(1)')).toBe(false);
    expect(getApiTarget()).toBe('https://good.example');
  });

  it('forgetting returns to the setup card rather than an invisible fallback', () => {
    setApiTarget('https://good.example');
    setApiTarget(null);
    expect(getApiTarget()).toBeNull();
    expect(isConfigured()).toBe(false);
  });

  it('survives localStorage throwing, which is a private window', () => {
    // Spied on the prototype: jsdom's localStorage instance properties are not
    // configurable, so jest cannot replace the method on the object itself.
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    // Accepted for this tab; the app must not refuse the choice outright.
    expect(setApiTarget('https://good.example')).toBe(true);
    expect(getApiTarget()).toBe('https://good.example');
  });

  it('ignores a corrupt stored value instead of building requests from it', () => {
    window.localStorage.setItem('ci_api_base', 'javascript:alert(1)');
    resetApiTargetCache();
    expect(getApiTarget()).toBeNull();
  });

  it('notifies subscribers and stops after unsubscribe', () => {
    let calls = 0;
    const unsubscribe = subscribeApiTarget(() => calls++);
    setApiTarget('https://a.example');
    expect(calls).toBe(1);
    unsubscribe();
    setApiTarget('https://b.example');
    expect(calls).toBe(1);
  });
});

describe('localFetchOptions', () => {
  /*
    These expectations are measurements, not guesses. Chromium 141, page on
    http://127.0.0.1:8787, fetching http://127.0.0.1:8000/healthz:

      (no annotation)              -> 200
      targetAddressSpace loopback  -> 200
      targetAddressSpace local     -> FAILS
      targetAddressSpace private   -> FAILS
      targetAddressSpace public    -> FAILS

    with "Request had a target IP address space of `unknown` yet the resource is in
    address space `loopback`". So the wrong name, or a right name on a request that did
    not need one, breaks a request that works untouched. Both rules below come from that.
  */
  it('names the space the target actually is — loopback is not "local"', () => {
    setPageOrigin('https://photo.ci.computer/');
    expect(localFetchOptions('http://localhost:8000')).toEqual({
      targetAddressSpace: 'loopback',
    });
    expect(localFetchOptions('http://192.168.1.50:8000')).toEqual({
      targetAddressSpace: 'local',
    });
  });

  it('says nothing when the request does not cross into a more private space', () => {
    // The ordinary local setup: `npm start` on loopback talking to a server on loopback.
    // It needs no declaration, and an unnecessary one is what fails it.
    setPageOrigin('http://localhost:3000/');
    expect(localFetchOptions('http://localhost:8000')).toEqual({});

    // A LAN page reaching a LAN server is likewise same-space.
    setPageOrigin('http://192.168.1.10:3000/');
    expect(localFetchOptions('http://192.168.1.50:8000')).toEqual({});

    // And a local page reaching out to a public server is moving the other way.
    setPageOrigin('http://localhost:3000/');
    expect(localFetchOptions('https://my-server.example.com')).toEqual({});
  });

  it('says nothing for a public target or no target', () => {
    setPageOrigin('https://photo.ci.computer/');
    expect(localFetchOptions('https://my-server.example.com')).toEqual({});
    expect(localFetchOptions(SAME_ORIGIN)).toEqual({});
    expect(localFetchOptions(null)).toEqual({});
  });

  it('a public page reaching a LAN address still declares it', () => {
    setPageOrigin('https://photo.ci.computer/');
    expect(localFetchOptions('http://mac-studio.local:8000')).toEqual({
      targetAddressSpace: 'local',
    });
  });
});

describe('probeServer', () => {
  it('reports the version and engine count from a server that answers', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.endsWith('/healthz')) {
        return Promise.resolve(jsonResponse({ status: 'ok', version: '2.0.0' }));
      }
      return Promise.resolve(
        jsonResponse({ engines: [{ name: 'preview' }, { name: 'depth-image' }] }),
      );
    });

    setPageOrigin('https://photo.ci.computer/');
    const result = await probeServer('http://localhost:8000');
    expect(result).toEqual({ ok: true, version: '2.0.0', engineCount: 2 });
    // The probe must carry the same options as the app, or it passes where the app fails
    // (or, worse, fails where the app would have worked).
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ targetAddressSpace: 'loopback' });
  });

  it('passes when /healthz answers but the engine list does not', async () => {
    jest.spyOn(global, 'fetch').mockImplementation((input) =>
      String(input).endsWith('/healthz')
        ? Promise.resolve(jsonResponse({ status: 'ok', version: '2.0.0' }))
        : Promise.reject(new TypeError('Failed to fetch')),
    );
    const result = await probeServer('https://ci-hub.example');
    expect(result.ok).toBe(true);
    expect(result.engineCount).toBeUndefined();
  });

  it('distinguishes "reached something that is not this server" from "unreachable"', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(errorResponse(404));
    const wrongServer = await probeServer('https://example.com');
    expect(wrongServer.ok).toBe(false);
    expect(wrongServer.error).toMatch(/404/);

    jest.spyOn(global, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    const unreachable = await probeServer('https://nothing-here.example');
    expect(unreachable.ok).toBe(false);
    // The browser withholds the reason, so the message names the candidates instead
    // of inventing one.
    expect(unreachable.error).toMatch(/not running|blocked|CORS/i);
  });

  it('refuses to probe a value that is not a valid target', async () => {
    const result = await probeServer('javascript:alert(1)');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not a valid/i);
  });
});
