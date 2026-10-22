import React, { useEffect, useRef, useState } from 'react';
import { HardDrive, Loader2, Check, AlertTriangle, Server } from 'lucide-react';
import {
  ProbeResult,
  SAME_ORIGIN,
  TargetInfo,
  describeTarget,
  normalizeTarget,
  probeServer,
  setApiTarget,
} from '../utils/apiTarget';
import { DOCS_URL, HOSTED_VIEWER_HOST } from '../siteLinks';
import { CompanionCallouts } from './SiteLinks';

/**
 * Where the user names their processing server.
 *
 * This app does not ship pointing anywhere — see `utils/apiTarget.ts`. So on a fresh
 * browser this is the first and only thing on screen, and it is the one piece of UI that
 * has to explain a distributed system to someone who just wants to look at a photo.
 *
 * It is built around one decision: **probe before committing**. The alternative — accept
 * the URL, store it, let the app fail on its first request — produces the worst possible
 * failure, because a wrong server, a stopped server, a browser-blocked request and a
 * missing CORS header all surface as the same blank gallery. Testing first means the
 * error arrives attached to the field that caused it, while the user is still looking at
 * it.
 */

/*
  A deliberately fictional host. This used to be https://photo-origin.ci.computer, which
  looks like a real address and is not one — it does not resolve — so anyone who took the
  hint at its word got a connection error from a placeholder. `.example.com` is reserved
  by RFC 2606 and can never be someone's server.
*/
const PLACEHOLDER = 'https://my-server.example.com';

/** True on the published viewer, whose edge is a static page with no server behind it. */
function isStaticHostedViewer(): boolean {
  return typeof window !== 'undefined' && window.location.hostname === HOSTED_VIEWER_HOST;
}

/** The answers that are worth one click each. */
const PRESETS: { label: string; value: string; hint: string }[] = [
  {
    label: 'This machine',
    value: 'http://localhost:8000',
    hint: 'A server running on the same computer as this browser',
  },
  {
    label: 'Same host as this page',
    value: SAME_ORIGIN,
    hint: 'The whole stack behind one hostname — docker compose, or a reverse proxy',
  },
];

/*
  "Same host as this page" means the server answers on the hostname serving this page.
  On photo.ci.computer nothing does — the Worker answers /healthz with 503
  `origin_not_configured` by design — so offering the preset there is a button whose only
  possible outcome is an error. It is hidden from the start on that host, and hidden after
  the fact on any other host whose probe comes back with the same answer.
*/

interface ServerFormProps {
  /** Pre-fill, for the "change it later" case. */
  initialValue?: string;
  onConnected: () => void;
  /** Rendered under the buttons; the setup card and the panel want different things. */
  footer?: React.ReactNode;
  autoFocus?: boolean;
}

const ServerForm: React.FC<ServerFormProps> = ({
  initialValue = '',
  onConnected,
  footer,
  autoFocus,
}) => {
  const [value, setValue] = useState(initialValue);
  const [probing, setProbing] = useState(false);
  const [result, setResult] = useState<ProbeResult | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  /*
    Preview the caveats as they type, not after they submit. `describeTarget` needs a
    normalized target, and a half-typed one does not have it — so this is null for most
    keystrokes, which is why it renders nothing rather than flickering.
  */
  const [info, setInfo] = useState<TargetInfo | null>(null);
  const [sameHostUnavailable, setSameHostUnavailable] = useState(isStaticHostedViewer);
  const presets = PRESETS.filter((p) => p.value !== SAME_ORIGIN || !sameHostUnavailable);
  useEffect(() => {
    const normalized = normalizeTarget(value);
    setInfo(normalized === null ? null : describeTarget(normalized));
    // A new address invalidates the previous verdict; leaving it on screen next to a
    // different URL is the one genuinely misleading state this form could have.
    setResult(null);
  }, [value]);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  const connect = async (raw: string) => {
    setProbing(true);
    setResult(null);
    const probe = await probeServer(raw);
    setProbing(false);
    setResult(probe);
    if (probe.code === 'origin_not_configured') setSameHostUnavailable(true);
    if (probe.ok && setApiTarget(raw)) onConnected();
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!probing && value.trim()) connect(value);
  };

  const disabled = probing || normalizeTarget(value) === null;

  return (
    <form onSubmit={submit} className="space-y-3">
      <label className="block">
        <span className="text-xs uppercase tracking-wide text-gray-400">Server address</span>
        <input
          ref={inputRef}
          type="url"
          inputMode="url"
          autoComplete="url"
          spellCheck={false}
          value={value === SAME_ORIGIN ? '' : value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={PLACEHOLDER}
          aria-label="Processing server address"
          className="mt-1 w-full rounded border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 placeholder:text-gray-400 focus:border-primary-400 focus:outline-none"
        />
      </label>

      <div className="flex flex-wrap gap-2">
        {presets.map((preset) => (
          <button
            key={preset.value}
            type="button"
            onClick={() => {
              setValue(preset.value);
              connect(preset.value);
            }}
            disabled={probing}
            title={preset.hint}
            className="rounded border border-gray-700 bg-gray-800 px-2.5 py-1 text-xs text-gray-300 transition-colors hover:border-gray-600 hover:text-white disabled:opacity-50"
          >
            {preset.label}
          </button>
        ))}
      </div>

      <button
        type="submit"
        disabled={disabled}
        className="flex w-full items-center justify-center gap-2 rounded bg-primary-600 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-500 disabled:cursor-not-allowed disabled:bg-gray-700 disabled:text-gray-500"
      >
        {probing ? (
          <>
            <Loader2 size={15} className="animate-spin" aria-hidden="true" />
            Checking…
          </>
        ) : (
          'Connect'
        )}
      </button>

      {/*
        One live region for the verdict, so a screen reader hears the outcome without
        having to go looking for it.
      */}
      <div role="status" aria-live="polite" className="space-y-2 text-xs">
        {result && !result.ok && (
          <p className="flex gap-2 text-red-300" role="alert">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>{result.error}</span>
          </p>
        )}
        {result?.ok && (
          <p className="flex gap-2 text-emerald-300">
            <Check size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>
              Connected{result.version ? ` to version ${result.version}` : ''}
              {result.engineCount !== undefined
                ? `, ${result.engineCount} engine${result.engineCount === 1 ? '' : 's'} available`
                : ''}
              .
            </span>
          </p>
        )}

        {/*
          Caveats show whether or not the probe passed, and that is the point: a probe
          against a plain-HTTP LAN address succeeds — `fetch` is annotated so the browser
          allows it — while thumbnails and meshes, which are element loads and cannot be
          annotated, will still be blocked. A green tick on its own would be a lie.
        */}
        {info?.warnings.map((warning) => (
          <p key={warning} className="flex gap-2 text-amber-300/90">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>{warning}</span>
          </p>
        ))}
      </div>

      {footer}
    </form>
  );
};

/**
 * The first-run screen: shown instead of the app when no server is configured.
 *
 * Deliberately says what the edge does and does not do. Someone arriving at a hosted URL
 * and being asked for a server address has every reason to wonder what they have landed
 * on, and "this page holds no data and cannot see yours" is both the answer and the
 * product's whole argument.
 *
 * `sharedLink` is for the visitor who did not come to set anything up: they were sent
 * /view/:assetId, and that link only means something to a viewer pointed at the server
 * that holds the asset. Without the sentence below they would be asked for an address
 * they have never heard of, with nothing to say whose it is.
 *
 * It is also the first screen a stranger sees, so it carries the way on to the rest of
 * Companion Intelligence — the Buy and Download callouts — inside the card, where a
 * visitor with no server is already reading, rather than leaving them to the footer.
 */
export const ServerSetup: React.FC<{ onConnected: () => void; sharedLink?: boolean }> = ({
  onConnected,
  sharedLink = false,
}) => (
  /*
    `m-auto` on the card, not `items-center` on the row. Centring with align-items clips the
    TOP of anything taller than its scroll container — the overflow goes above the scroll
    origin, where no scrolling can reach it — and on a 360x640 phone this card, which now
    carries the Buy and Download callouts, is taller than the space the header and footer
    leave it: the heading was gone. Auto margins centre it when there is room and fall back
    to the top edge when there is not, so the whole card is always reachable.
  */
  <div className="flex min-h-0 flex-1 overflow-y-auto px-6 py-4">
    <div className="pointer-events-auto m-auto w-full max-w-md rounded-lg border border-gray-700 bg-gray-900 p-5">
      <div className="mb-3 flex items-center gap-2">
        <HardDrive size={18} className="text-primary-400" aria-hidden="true" />
        <h2 className="text-base font-semibold text-white">Point this at your server</h2>
      </div>

      {sharedLink && (
        <p
          role="note"
          className="mb-3 rounded border border-primary-400/40 bg-primary-600/10 px-3 py-2 text-xs leading-relaxed text-gray-100"
        >
          This link opens a 3D memory held on someone&rsquo;s own server. Ask whoever sent it for
          that server&rsquo;s address, enter it below, and the memory will load.
        </p>
      )}

      <p className="mb-4 text-xs leading-relaxed text-gray-400">
        Photos are turned into 3D on a machine you control — this page is static and never
        handles them. Give it the address of your Photo Time Machine server and it is
        remembered in this browser only.
      </p>

      <ServerForm
        onConnected={onConnected}
        autoFocus
        footer={
          <div className="space-y-3 border-t border-gray-800 pt-3">
            <p className="text-xs leading-snug text-gray-400">
              No server yet? It runs on a computer you control: start it there, then choose
              &ldquo;This machine&rdquo;. To reach it from a phone or a headset it needs an HTTPS
              address, and a tunnel is the usual way. The{' '}
              <a
                href={DOCS_URL}
                className="text-primary-200 underline underline-offset-2 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-400"
              >
                Companion Intelligence docs
              </a>{' '}
              are the place to start.
            </p>
            <CompanionCallouts />
          </div>
        }
      />
    </div>
  </div>
);

/**
 * The change-it-later popover, opened from the TopBar.
 *
 * Shows the current target and its caveats up front, because the question this panel
 * gets opened to answer is almost always "wait, which server am I talking to?".
 */
export const ServerPanel: React.FC<{ target: string; onClose: () => void }> = ({
  target,
  onClose,
}) => {
  const [editing, setEditing] = useState(false);
  const info = describeTarget(target);
  const label = target === SAME_ORIGIN ? 'this host' : target;

  return (
    /* z-30, above the XR panel (z-20): both popovers anchor to the same container edge,
       and if XR is on while this is open the one the user just asked for should be the
       one they can read. Opaque enough that the overlap reads as a stack, not a bleed. */
    <div className="absolute right-0 top-full z-30 mt-2 w-80 overflow-hidden rounded-lg border border-gray-700 bg-gray-900 p-3 text-xs">
      <div className="mb-2 flex items-center gap-2 text-gray-200">
        <Server size={14} className="shrink-0 text-primary-400" aria-hidden="true" />
        <span className="min-w-0 break-all font-medium">{label}</span>
      </div>

      {info.warnings.length > 0 && (
        <ul className="mb-2 space-y-1.5">
          {info.warnings.map((warning) => (
            <li key={warning} className="flex gap-2 text-amber-300/90">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span>{warning}</span>
            </li>
          ))}
        </ul>
      )}

      {editing ? (
        <ServerForm
          initialValue={target === SAME_ORIGIN ? '' : target}
          autoFocus
          onConnected={() => {
            setEditing(false);
            onClose();
          }}
        />
      ) : (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="flex-1 rounded bg-gray-700 py-1.5 text-gray-100 transition-colors hover:bg-gray-600"
          >
            Change server
          </button>
          <button
            type="button"
            onClick={() => {
              // Back to the setup screen rather than to a hidden fallback: the user
              // should always be able to see which server is in play.
              setApiTarget(null);
              onClose();
            }}
            className="rounded border border-gray-700 px-2.5 py-1.5 text-gray-400 transition-colors hover:border-gray-600 hover:text-gray-200"
          >
            Forget
          </button>
        </div>
      )}
    </div>
  );
};

export default ServerSetup;
