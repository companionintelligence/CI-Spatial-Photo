/**
 * Which processing server this browser talks to, chosen at runtime.
 *
 * The product claim is that nothing leaves your hardware. That is only true if the
 * server is *your* server, so the viewer does not ship pointing at one: the deployed
 * bundle starts with no target at all and asks, and the answer lives in this browser's
 * localStorage. photo.ci.computer is then a static page and nothing else — it never
 * proxies, never sees a photo, and has no idea where your server is.
 *
 * Four shapes are supported, and they are not equally easy on a browser. Everything
 * awkward about them is encoded once, here, rather than discovered one bug at a time:
 *
 *   https://my-server.example.com      a tunnel to your machine. Works everywhere.
 *   http://localhost:8000              your machine, sitting at it. Needs a Chrome
 *                                      Local Network Access grant; Safari refuses.
 *   https://ci-hub.example             any always-on HTTPS host. Works everywhere.
 *   (same origin)                      the whole stack behind one hostname, e.g.
 *                                      `docker compose up` or `npm start`.
 *
 * `screenGeometry.ts` is the pattern this follows: a module-level store with a
 * `useSyncExternalStore` surface, because the value has consumers that never meet —
 * a settings panel writes it, `api.ts` reads it on every request — and their only
 * common ancestor is App, which should not own it.
 */

/*
  `targetAddressSpace` is part of the Local Network Access spec and is not in
  TypeScript's DOM lib yet. Declared here rather than cast at the call site, so the one
  place that sets it is type-checked and the reason is written down once.
*/
declare global {
  interface RequestInit {
    /**
     * Asserts, before DNS resolution, which address space this request is headed for.
     * Required for a private-address target to be exempt from the mixed-content check
     * once the Local Network Access permission is granted.
     *
     * The value names are Local Network Access's, not the older Private Network Access
     * ones, and the difference is not cosmetic: LNA renamed PNA's `private` to `local`
     * and split loopback out as its own space. Measured against Chromium 141 —
     * `'loopback'` reaches 127.0.0.1, while `'local'`, `'private'` and `'public'` all
     * fail it with "target IP address space of `unknown` yet the resource is in address
     * space `loopback`".
     */
    targetAddressSpace?: 'loopback' | 'local' | 'public' | 'unknown';
  }
}

const STORAGE_KEY = 'ci_api_base';

/**
 * The value meaning "same origin as this page": relative `/api/v1/...` requests.
 *
 * A distinct sentinel rather than the empty string, because empty is what an
 * untouched text input holds and that must mean "not configured", not "silently
 * point at whatever host is serving the bundle".
 */
export const SAME_ORIGIN = 'same-origin';

/**
 * Build-time default, still honoured — it is what makes local development need no
 * clicking. `npm start` and the Docker viewer both pass a value, so they come up
 * already pointed at a server. The Cloudflare build deliberately passes nothing, so
 * the deployed bundle is unconfigured and asks.
 *
 * Note `undefined` vs `''`: CRA inlines an unset variable as undefined and an
 * explicitly-empty one as `''`. Empty means same-origin, which is the single-origin
 * self-host, and is a deliberate answer rather than an absent one.
 */
const buildTimeTarget: string | null = (() => {
  const raw = process.env.REACT_APP_API_BASE as string | undefined;
  if (raw === undefined) return null;
  if (raw === '') return SAME_ORIGIN;
  return normalizeTarget(raw);
})();

export type AddressSpace = 'same-origin' | 'loopback' | 'private' | 'public';

export interface TargetInfo {
  /** The stored value, verbatim. */
  target: string;
  /** What to prefix a request path with. Empty for same-origin. */
  base: string;
  space: AddressSpace;
  /** Whether the target itself is served over TLS (same-origin inherits the page's). */
  secure: boolean;
  /**
   * Things that will visibly not work, in the user's terms. Empty for a target with
   * no caveats, which is the point of showing it.
   */
  warnings: string[];
}

/** Trim trailing slashes and whitespace. Returns null for anything unusable. */
export function normalizeTarget(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed === SAME_ORIGIN) return SAME_ORIGIN;

  // A bare host is what people type. Assume https, not http: guessing wrong toward
  // http produces a mixed-content failure that reads as "the app is broken", while
  // guessing wrong toward https produces a connection error that names itself.
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  // Only ever http(s). `javascript:` and `data:` are the reason this is a whitelist
  // and not a blacklist — this string is concatenated into a fetch URL.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname) return null;

  // Keep scheme, host and port; drop path, query and hash. A base with a path would
  // produce `https://host/some/path/api/v1/...`, and one with a query would produce
  // `...?x=1/api/v1/...`, neither of which is a route on any server.
  return `${url.protocol}//${url.host}`;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0']);

/**
 * Which address space a host sits in, as Chrome's Local Network Access spec divides
 * them. Deliberately conservative: anything not recognisably local is treated as
 * public, because that is the case with no special browser handling.
 */
export function classifyHost(hostname: string): Exclude<AddressSpace, 'same-origin'> {
  const host = hostname.toLowerCase();
  if (LOOPBACK_HOSTS.has(host)) return 'loopback';
  if (host.endsWith('.localhost')) return 'loopback';
  // mDNS names resolve on the local link. Chrome can tell these are local before
  // resolving, which is what makes them exempt from the mixed-content check.
  if (host.endsWith('.local')) return 'private';
  // RFC1918 and friends, as literals. A *name* that resolves to a private address
  // cannot be classified here, and Chrome cannot classify it up front either — which
  // is exactly why such a target gets no mixed-content exemption.
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return 'private';
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return 'private';
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host)) return 'private';
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(host)) return 'private';
  return 'public';
}

/** Which address space the page itself was served from. */
export function pageAddressSpace(): Exclude<AddressSpace, 'same-origin'> {
  if (typeof window === 'undefined') return 'public';
  return classifyHost(window.location.hostname);
}

/** How public a space is. A request only needs declaring when it moves down this scale. */
const OPENNESS: Record<Exclude<AddressSpace, 'same-origin'>, number> = {
  public: 2,
  private: 1,
  loopback: 0,
};

/** True when the page itself is a secure context served from a public origin. */
function pageIsPublicHttps(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.location.protocol !== 'https:') return false;
  return pageAddressSpace() === 'public';
}

/** True when the page is HTTPS — the precondition for any mixed-content rule. */
function pageIsHttps(): boolean {
  return typeof window !== 'undefined' && window.location.protocol === 'https:';
}

/**
 * True when a request to this space leaves the page's own space for a more private one.
 *
 * The single predicate behind both the Local Network Access warnings and the
 * `targetAddressSpace` annotation, deliberately: a UI that warns about a case the code
 * does not actually handle specially — or stays silent about one it does — is worse than
 * no UI, and keeping them on one function is what stops them drifting apart.
 */
function crossesIntoMorePrivateSpace(targetSpace: Exclude<AddressSpace, 'same-origin'>): boolean {
  return OPENNESS[pageAddressSpace()] > OPENNESS[targetSpace];
}

/**
 * Describe a target, including what will not work.
 *
 * The warnings are the honest part. Chrome 142 enforces Local Network Access: a public
 * page reaching loopback or a private address needs a permission grant. Requests made
 * with `fetch` can be annotated so Chrome knows in advance that the destination is
 * local, and permission-gated local requests are then exempt from the mixed-content
 * check — but two things in this app are *element* loads, not fetches: gallery
 * thumbnails are `<img src>` and meshes are `<model-viewer src>`. Those cannot carry
 * the annotation, so against a plain-HTTP private address they are blocked while
 * splats (fetched) still load. A viewer that shows splats but no thumbnails and no
 * meshes is a confusing thing to debug from scratch, so it is stated up front.
 */
export function describeTarget(target: string): TargetInfo {
  if (target === SAME_ORIGIN) {
    return { target, base: '', space: 'same-origin', secure: true, warnings: [] };
  }

  const url = new URL(target);
  const space = classifyHost(url.hostname);
  const secure = url.protocol === 'https:';
  const warnings: string[] = [];

  if (crossesIntoMorePrivateSpace(space)) {
    warnings.push(
      'Chrome will ask permission the first time this page reaches your local network. ' +
        'Safari and Firefox do not implement that permission and may refuse the request outright.',
    );
  }

  // Mixed content is a rule about HTTPS pages loading HTTP subresources, so none of the
  // below applies to a page that is itself HTTP — the fully-local setup.
  if (!secure && pageIsHttps()) {
    if (space === 'loopback') {
      // http://localhost is a "potentially trustworthy" origin, so it is exempt from
      // mixed content in every current browser: images and meshes do load.
      //
      // Only worth saying when the page is public, because then "localhost" means
      // this one desk. Page and server both local is the ordinary `npm start` setup,
      // where nothing is broken and a warning would be noise.
      if (pageIsPublicHttps()) {
        warnings.push(
          'This only works at the machine running the server — "localhost" means ' +
            'whatever device is showing this page, so your phone or a headset will ' +
            'find nothing there.',
        );
      }
      // else: an HTTPS page on a private host reaching loopback. Allowed, nothing to say.
    } else if (space === 'private') {
      warnings.push(
        'Plain HTTP to a private address: splats will load, but gallery thumbnails and ' +
          'meshes will not. They are loaded by the browser as images, which cannot carry ' +
          'the annotation that exempts them from mixed-content blocking. Use a tunnel or ' +
          'HTTPS to fix it.',
      );
    } else {
      warnings.push(
        'Plain HTTP to a public host is blocked outright from this HTTPS page. Use https:// ' +
          'or a tunnel.',
      );
    }
  }

  return { target, base: target, space, secure, warnings };
}

// ── The store ─────────────────────────────────────────────────────────────────
// localStorage can throw (private windows, blocked site data) and can come back empty,
// so every access is guarded and the app renders correctly without it.

function readStored(): string | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === null ? null : normalizeTarget(raw);
  } catch {
    return null;
  }
}

let cached: string | null | undefined;
const listeners = new Set<() => void>();

/**
 * The active target, or null when none is configured and the app should ask.
 *
 * Cached because this is read on every request and `getSnapshot` must be cheap and
 * referentially stable — `useSyncExternalStore` re-renders in a loop otherwise.
 */
export function getApiTarget(): string | null {
  if (cached === undefined) cached = readStored() ?? buildTimeTarget;
  return cached;
}

/** The string to prefix request paths with: '' for same-origin, else scheme://host. */
export function getApiBase(): string {
  const target = getApiTarget();
  if (target === null || target === SAME_ORIGIN) return '';
  return target;
}

export function isConfigured(): boolean {
  return getApiTarget() !== null;
}

/**
 * Point this browser at a server. `null` forgets it, which returns the app to the
 * setup card rather than falling back to a build-time value the user cannot see.
 *
 * Returns false for a value that is not a usable target, so a caller can report it
 * without having to re-run the validation itself.
 */
export function setApiTarget(raw: string | null): boolean {
  const next = raw === null ? null : normalizeTarget(raw);
  if (raw !== null && next === null) return false;

  cached = next;
  try {
    if (next === null) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Unwritable storage means the choice lasts for this tab only. Better than
    // refusing to accept it at all.
  }
  listeners.forEach((l) => l());
  return true;
}

export function subscribeApiTarget(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam: drop the cache so a fresh localStorage read happens. */
export function resetApiTargetCache(): void {
  cached = undefined;
  listeners.forEach((l) => l());
}

// ── Fetching ──────────────────────────────────────────────────────────────────

/**
 * Extra `fetch` options needed to reach the configured target.
 *
 * Declaring the target's address space is what lets Chrome permission-gate a request
 * into the local network and exempt it from the mixed-content check. But the assertion
 * is checked against reality, so a *wrong* declaration is worse than none: Chromium 141
 * rejects `http://127.0.0.1:8000` outright when the request claims `'local'`, with
 * "target IP address space of `unknown` yet the resource is in address space
 * `loopback`" — a request that succeeds unannotated. Both halves of this function exist
 * because of that:
 *
 *   * the space name matches what the target actually is (`loopback` vs `local`), and
 *   * it is only sent when the request really does cross from a more public page into a
 *     more private target. Page and server both on loopback — `npm start`, the Docker
 *     stack — is the ordinary case, needs nothing, and breaks if it gets something.
 *
 * Browsers without Local Network Access ignore the unknown key, so sending it when it
 * is genuinely needed is safe.
 */
export function localFetchOptions(target: string | null = getApiTarget()): RequestInit {
  if (target === null || target === SAME_ORIGIN) return {};

  let targetSpace: Exclude<AddressSpace, 'same-origin'>;
  try {
    targetSpace = classifyHost(new URL(target).hostname);
  } catch {
    return {};
  }
  if (targetSpace === 'public') return {};
  if (OPENNESS[pageAddressSpace()] <= OPENNESS[targetSpace]) return {};

  return { targetAddressSpace: targetSpace === 'loopback' ? 'loopback' : 'local' };
}

/** Absolute (or same-origin relative) URL for an API path. `path` starts with a slash. */
export function apiUrl(path: string): string {
  return `${getApiBase()}${path}`;
}

export interface ProbeResult {
  ok: boolean;
  /**
   * Set when the failure has a cause the UI should act on rather than just print.
   * `origin_not_configured` is the static edge's own answer to /healthz: the host is
   * there, it is a viewer, and no server sits behind it.
   */
  code?: 'origin_not_configured';
  /** Server version from /healthz, when it answered. */
  version?: string;
  /** How many engines it advertises — the first genuinely useful signal. */
  engineCount?: number;
  /** Present when the probe failed; written for a human, not a log. */
  error?: string;
}

/**
 * Ask a candidate server whether it is there, before committing to it.
 *
 * `/healthz` answers without auth, so this distinguishes "wrong URL / server down /
 * blocked by the browser" from "server fine, you are not signed in" — which a probe
 * against an authenticated route could not.
 *
 * A network-level failure gives `TypeError: Failed to fetch` and nothing else: the
 * browser deliberately withholds the reason to avoid leaking whether a host exists.
 * So the message here names the candidates rather than pretending to know.
 */
export async function probeServer(rawTarget: string): Promise<ProbeResult> {
  const target = normalizeTarget(rawTarget);
  if (target === null) return { ok: false, error: 'That is not a valid server address.' };

  const base = target === SAME_ORIGIN ? '' : target;
  const options = localFetchOptions(target);

  try {
    const health = await fetch(`${base}/healthz`, { ...options, method: 'GET' });
    if (!health.ok) {
      // The published viewer's Worker answers /healthz with 503 and a JSON body naming
      // the reason (worker/index.js). "Reached it, but /healthz answered 503" would bury
      // that — the reply is accurate and the explanation is the useful half.
      // Via a promise so a body that is not JSON (or a response with no json() at all)
      // degrades to null instead of throwing out of the probe.
      const body: unknown = await Promise.resolve()
        .then(() => health.json())
        .catch(() => null);
      if (body && (body as { error?: unknown }).error === 'origin_not_configured') {
        return {
          ok: false,
          code: 'origin_not_configured',
          error:
            'That address is a static page with no server behind it. Run your own server, ' +
            'then choose “This machine” or enter its tunnel address.',
        };
      }
      return {
        ok: false,
        error: `Reached it, but /healthz answered ${health.status}. Is that a Photo Time Machine server?`,
      };
    }
    const body = (await health.json()) as { status?: string; version?: string };

    // Engines are optional for a pass: a server with none is still a server, and
    // saying how many it has is more useful than a bare green tick.
    let engineCount: number | undefined;
    try {
      const engines = await fetch(`${base}/api/v1/engines`, options);
      if (engines.ok) {
        const parsed = (await engines.json()) as { engines?: unknown[] };
        if (Array.isArray(parsed.engines)) engineCount = parsed.engines.length;
      }
    } catch {
      // Left undefined; /healthz already proved reachability.
    }

    return { ok: true, version: body.version, engineCount };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error:
        `Could not reach it (${detail}). Either the server is not running, the browser ` +
        `blocked the request, or it is not sending CORS headers for this page.`,
    };
  }
}
