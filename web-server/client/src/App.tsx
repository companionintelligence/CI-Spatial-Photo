import React, { useState, useEffect, useCallback, useRef, Suspense, lazy, useSyncExternalStore } from 'react';
import TopBar from './components/TopBar';
import CreatePanel from './components/CreatePanel';
import Gallery from './components/Gallery';
import MemoryPicker from './components/MemoryPicker';
import { useHeadTracking } from './hooks/useHeadTracking';
import { Asset, api, fetchAssetAsFile, viewerSplatFormat } from './api';
import { ServerSetup } from './components/ServerPicker';
import { SiteFooter, CompanionCallouts } from './components/SiteLinks';
import { getApiTarget, subscribeApiTarget } from './utils/apiTarget';

/*
  The two viewers are code-split, and this is the single highest-leverage thing
  in the bundle.

  Between them they pull in three.js, @sparkjsdev/spark and (via MeshViewer)
  @google/model-viewer. None of that is needed to render the screen almost
  everyone sees first — the Create empty state, which is HTML and Tailwind and
  nothing else. Statically imported, they sat in `main.js` and every first load
  paid for a WebGL splat renderer before the user had chosen a photo.

  Splitting on the viewers rather than on the libraries directly is deliberate:
  `utils/magicWindow.ts` and `utils/cameraUtils.ts` also import three, but they
  are only reachable FROM the viewers, so webpack puts them in the same async
  chunk automatically. Importing either of them eagerly from App would silently
  drag three back into the main bundle — so don't.
*/
const SplatViewer = lazy(() => import('./components/SplatViewer'));
const MeshViewer = lazy(() => import('./components/MeshViewer'));

type Tab = 'create' | 'explore' | 'memory';

const TABS: Tab[] = ['create', 'explore', 'memory'];

/** The title a /view/:assetId page carries — the shell's own title describes the product. */
const VIEW_TITLE = 'A 3D memory — Photo Time Machine';

function parseViewId(): string | null {
  const m = window.location.pathname.match(/^\/view\/([A-Za-z0-9_]+)/);
  return m ? m[1] : null;
}

function App() {
  const [asset, setAsset] = useState<Asset | null>(null);
  const [splatFile, setSplatFile] = useState<File | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('create');
  const [refreshKey, setRefreshKey] = useState(0);

  // UI / XR state. There is no theme state: the app is dark-only (see TopBar).
  const [isXREnabled, setIsXREnabled] = useState(false);
  const [showControls, setShowControls] = useState(true);

  const { headPosition, videoRef } = useHeadTracking(isXREnabled);

  /*
    Which server we are talking to, read from the module store rather than held in
    state: `api.ts` reads the same value on every request, and a second copy here would
    let the two disagree about where a request just went. `getApiTarget` is memoized
    behind a cache, so it is a stable `getSnapshot`.
  */
  const serverTarget = useSyncExternalStore(subscribeApiTarget, getApiTarget, getApiTarget);
  const configured = serverTarget !== null;

  const loadAsset = useCallback(async (assetId: string) => {
    setLoadError(null);
    setSplatFile(null);
    try {
      const a = await api.getAsset(assetId);
      setAsset(a);
      if (a.kind === 'splat') {
        const fmt = viewerSplatFormat(a);
        setSplatFile(await fetchAssetAsFile(a, fmt));
      }
      // Puts the share link in the address bar without a reload. If Google Analytics is on
      // and the GA4 property reports history changes, that is a URL carrying this id: see
      // the GA4 note in docs/DEPLOY-CLOUDFLARE.md (the property's setting must be off).
      window.history.replaceState({}, '', `/view/${assetId}`);
    } catch (e: any) {
      setLoadError(e.message || 'Failed to load asset');
    }
  }, []);

  /*
    Deep-link: /view/:assetId opens straight into the shared asset.

    Gated on `configured`, and re-run when it changes. A share link is the most likely
    way someone arrives at this app for the first time, which is exactly the moment no
    server is set — so this used to fire immediately and paint "Failed to load asset"
    over the setup card. Now the link survives the detour: choose a server, and the
    asset it names loads.
  */
  useEffect(() => {
    if (!configured) return;
    const id = parseViewId();
    if (id) loadAsset(id);
  }, [loadAsset, configured]);

  const handleCreated = (assetId: string) => {
    setRefreshKey((k) => k + 1);
    setTab('explore');
    loadAsset(assetId);
  };

  /*
    Copy the share link, and SAY what happened. This used to be
    `clipboard?.writeText(...).catch(() => {})`: a click that did something, or did
    nothing, with no way for anyone — sighted or not — to tell which. The Clipboard API is
    absent on plain-HTTP origins (the whole local setup) and rejects without a user
    gesture or permission, so "nothing happened" was a real outcome, not an edge case.

    Success says so, in a live region a screen reader announces. Failure falls back to
    the oldest trick there is: select the URL text, so Ctrl/Cmd+C finishes the job, and
    say that is what to do. The span is `select-all` as well, so one click selects it.
  */
  const [copyNote, setCopyNote] = useState<string>('');
  const shareUrlRef = useRef<HTMLSpanElement>(null);
  const copyTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(copyTimer.current), []);

  const share = async () => {
    if (!asset?.share_url) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
      await navigator.clipboard.writeText(asset.share_url);
      setCopyNote('Link copied');
    } catch {
      const el = shareUrlRef.current;
      const selection = window.getSelection();
      if (el && selection) {
        const range = document.createRange();
        range.selectNodeContents(el);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      setCopyNote('Press Ctrl+C or ⌘C to copy');
    }
    window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopyNote(''), 4000);
  };

  /*
    The document title follows what is on screen. The shell's static title sells the
    product, which is right for the home page and wrong for a tab holding someone's shared
    memory — and a share link is the most common way this app is ever opened.
  */
  const baseTitle = useRef<string>(typeof document !== 'undefined' ? document.title : '');
  useEffect(() => {
    document.title = asset || parseViewId() ? VIEW_TITLE : baseTitle.current;
  }, [asset]);

  /*
    Roving arrow-key movement for the tab strip. `role="tab"` makes a promise to assistive
    tech — one Tab stop for the whole strip, arrows to move within it — and the buttons
    used to make that promise without keeping it.
  */
  const tabRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});
  const onTabKeyDown = (e: React.KeyboardEvent, index: number) => {
    let next = -1;
    if (e.key === 'ArrowRight') next = (index + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') next = (index - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = TABS.length - 1;
    if (next < 0) return;
    e.preventDefault();
    setTab(TABS[next]);
    tabRefs.current[TABS[next]]?.focus();
  };

  /*
    Is there anything actually rendering behind the UI? This is the one
    distinction the layout below turns on, and it used to be missing: the app
    has two modes and only ever drew one of them.

      viewer up   — the splat/mesh fills the viewport and the panel is a HUD
                    floating over live 3D. Correct, and unchanged.
      no viewer   — nothing is behind. The panel is the ONLY content on screen,
                    so laying it out as a HUD pins a 448px card to the top-left
                    corner of a 1280px window and leaves the rest black.

    In that second mode the hero was a separate object competing for the
    leftovers rather than composing with the panel, and the frame measured
    ~85% near-black (luma < 8/255) across all four Create shots and the
    Explore one. That is the empty state, not the capture.

    Keyed on `asset`, deliberately, and NOT on what the background is painting
    this instant. A splat is fetched after its asset resolves (`loadAsset`
    clears `splatFile` first), so a predicate like `mesh || splatFile` reads
    false for the whole download and the panel would slide corner → centre →
    corner on every gallery click. `asset` is set once and the viewer is
    committed from that moment, download or no download.
  */
  const viewerUp = Boolean(asset);

  /*
    One panel, two placements. This builds the card; the caller passes only the
    classes that decide where it sits, so the HUD and the composed layout cannot
    drift apart as the panel's contents change.
  */
  const renderPanel = (placement: string) => (
    <div
      className={`pointer-events-auto rounded-xl bg-gray-900/90 backdrop-blur border border-gray-700 shadow-2xl overflow-hidden ${placement}`}
    >
      <div
        role="tablist"
        aria-label="Photo Time Machine sections"
        className="flex border-b border-gray-700 text-sm"
      >
        {TABS.map((t, i) => (
          /*
            The selected tab used to be signalled by `bg-gray-800` alone:
            #1f2937 against the #0f1623 panel is 1.23:1, far under the
            3:1 a UI state change needs, and both states painted the same
            white label. The hover fill (gray-800/50) also landed BETWEEN
            the two, so hovering an inactive tab looked half-selected.
            Now the state is carried by three redundant cues — an accent
            underline (5.3:1 against the tab fill), label weight, and
            label colour (inactive #9ca3af is still 7.1:1).
          */
          <button
            key={t}
            ref={(el) => {
              tabRefs.current[t] = el;
            }}
            id={`tab-${t}`}
            onClick={() => setTab(t)}
            onKeyDown={(e) => onTabKeyDown(e, i)}
            role="tab"
            aria-selected={tab === t}
            aria-controls="tabpanel-main"
            tabIndex={tab === t ? 0 : -1}
            className={`flex-1 py-2 capitalize border-b-2 ${
              tab === t
                ? 'bg-gray-800 font-medium text-white border-primary-400'
                : 'text-gray-400 border-transparent hover:bg-gray-800/50 hover:text-gray-200'
            }`}
          >
            {t === 'memory' ? 'From Memory' : t}
          </button>
        ))}
      </div>

      {/*
        loadError lives on the panel, not in the hero: that is the layer the
        user is looking at, and the hero is not guaranteed to be on screen.
      */}
      {loadError && (
        <p className="px-4 pt-3 text-sm text-red-400" role="alert">
          {loadError}
        </p>
      )}

      <div
        role="tabpanel"
        id="tabpanel-main"
        aria-labelledby={`tab-${tab}`}
        className="max-h-[60vh] overflow-y-auto"
      >
        {tab === 'create' && <CreatePanel onCreated={handleCreated} />}
        {tab === 'explore' && <Gallery onSelect={(a) => loadAsset(a.asset_id)} refreshKey={refreshKey} />}
        {tab === 'memory' && <MemoryPicker onCreated={handleCreated} />}
      </div>

      {/*
        Side by side, the share URL had ~200px on a 360px phone and
        truncated to a share URL's first few segments — the one
        string on the screen a viewer might want to read. Stacking it
        above the button below `sm` gives it the full panel width.
      */}
      {asset && (
        <div className="flex flex-col items-stretch gap-2 p-3 border-t border-gray-700 text-xs sm:flex-row sm:items-center sm:justify-between">
          <span ref={shareUrlRef} className="min-w-0 select-all truncate text-gray-400">
            {asset.share_url}
          </span>
          <div className="flex shrink-0 items-center justify-end gap-2">
            {/* Always mounted, so the live region exists before its text changes. */}
            <span role="status" aria-live="polite" className="text-emerald-300">
              {copyNote}
            </span>
            <button onClick={share} className="px-3 py-1 rounded bg-primary-600 hover:bg-primary-500">
              Copy link
            </button>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div className="text-white">
      {/*
        Background layer: the viewer, or the flat black it paints anyway. The
        hero used to live down here too, which is why it could never compose
        with the panel — they were on different layers, each centring itself
        against the whole viewport in ignorance of the other.
      */}
      <div className="absolute inset-0 z-0 overflow-hidden bg-ground">
        {/*
          `fallback={null}` and not a spinner. This boundary only resolves while
          an asset's chunk is downloading, and the layer underneath is already
          the right colour — a spinner here would be a second loading indicator
          competing with `data-splat-status`, which is the one the product-video
          capture waits on. Rendering nothing keeps that contract single-valued.
        */}
        <Suspense fallback={null}>
          {asset && asset.kind === 'mesh' ? (
            <MeshViewer
              src={api.assetFileUrl(asset.asset_id, 'glb')}
              poster={api.thumbnailUrl(asset.asset_id)}
              className="w-full h-full"
            />
          ) : splatFile ? (
            <SplatViewer
              file={splatFile}
              className="w-full h-full"
              headPosition={isXREnabled ? headPosition : null}
            />
          ) : (
          /*
            Backdrop for the empty state, and ONLY the empty state — a splat or
            mesh still renders against true #000, which is what those viewers
            are colour-matched to.

            Recomposing the hero and panel fixed where things sit, but the frame
            was still ~84% pure black afterwards, because a centred layout on a
            void still reads as a void. #000 across two-thirds of a window is
            not a neutral background, it is an absence. This is the difference
            between "the app is composed on a dark surface" and "the app failed
            to fill its window".

            Two accents from the app's own palette (primary-600 #0A6358 and
            cyan-700 — the Create button and the tab underline live in that
            family) over a very dark teal-black.

            Every stop is deliberately above luma 8/255, the threshold the
            near-black audit uses. That is not gaming the metric — it is the
            point of the change. #04060a and #05070c both measure 5.9 and 6.9,
            so a gradient bottoming out there would still have audited as a void
            while looking like a surface, and the next person to measure it
            would have drawn the wrong conclusion. The darkest stop here,
            #070a11, measures 9.9.

            Inline style rather than a Tailwind arbitrary value: the value
            contains commas and percentages, and `bg-[radial-gradient(...)]`
            needs every space underscore-escaped, which turns an already dense
            declaration into something nobody will edit correctly later.
          */
            <div
              className="h-full w-full"
              style={{
                background: [
                  'radial-gradient(1100px 680px at 24% 34%, rgba(15, 113, 122, 0.12), transparent 68%)',
                  'radial-gradient(900px 620px at 80% 74%, rgba(14, 116, 144, 0.10), transparent 70%)',
                  // Re-tuned off the canon ground #041620 rather than the old
                  // blue-black. Every stop clears the luma-8/255 floor the
                  // comment above is about, with far more room than the old
                  // stops had — measured 27.7, 22.4, 19.8 against the previous
                  // 9.9 at the darkest point.
                  'linear-gradient(158deg, #08202b 0%, #061a23 55%, #05171f 100%)',
                ].join(', '),
              }}
            />
          )}
        </Suspense>
      </div>

      {/*
        Overlay UI. `100dvh` as well as `h-screen`: on a phone `100vh` is the viewport with
        the browser toolbar retracted, so a footer pinned to the bottom of it sits under the
        toolbar until the page is scrolled — and this page does not scroll. The inline style
        wins where `dvh` is supported and is dropped where it is not, leaving `h-screen`.
      */}
      <div
        className="relative z-10 flex flex-col h-screen pointer-events-none"
        style={{ height: '100dvh' }}
      >
        <TopBar
          isXREnabled={isXREnabled}
          setIsXREnabled={setIsXREnabled}
          showControls={showControls}
          setShowControls={setShowControls}
          headPosition={headPosition}
          videoRef={videoRef}
          serverTarget={serverTarget}
        />

        {/*
          No server, no app. Everything below this point issues requests, so rendering
          it unconfigured would mean a screenful of controls that all fail — and the
          gallery's own empty state ("nothing here yet") would be indistinguishable
          from "you have not said where your photos live".
        */}
        <main className="flex min-h-0 flex-1 flex-col">
        {!configured ? (
          <ServerSetup
            onConnected={() => setRefreshKey((k) => k + 1)}
            sharedLink={parseViewId() !== null}
          />
        ) : viewerUp ? (
          /*
            HUD placement, unchanged. No `w-full`: `width: 100%` resolves
            against the flex container (the full viewport) and `m-4` then adds
            16px on each side on top of that, so on a 360px phone the panel laid
            out 392px wide and its rightmost tab hung off the screen. Letting
            the flex item stretch sizes it to the container MINUS its margins,
            and `max-w-md` (448px) still clamps every desktop layout.
          */
          showControls && renderPanel('max-w-md m-4')
        ) : (
          /*
            Empty state. The panel and the hero are now one centred
            composition instead of two objects staking out opposite corners:
            side by side above `md` (the shape a 16:9 window wants), stacked
            below it. The group is centred in the space under the TopBar, so
            the remaining black reads as margin rather than as a window the app
            failed to fill.

            The panel keeps `max-w-md`. Widening it at large breakpoints was
            the other way to fill the frame, but every inner breakpoint in
            CreatePanel — the `sm:grid-cols-2` Engine/Intent pair, the stacked
            share footer — is tuned against exactly 448px, so widening buys
            frame coverage by invalidating all of it. Composing costs nothing.

            `min-h-0` + `overflow-y-auto` because the panel's own scroll area
            is `max-h-[60vh]`: on a 360x640 phone the From Memory grid plus the
            hero can exceed the viewport, and this is the valve.

            The group centres itself with `m-auto`, not `items-center` +
            `justify-center` on this row. Centring by alignment clips the TOP of
            anything taller than the scroll container — the overflow lands above
            the scroll origin, out of reach — which made the valve one-way: on a
            360x640 phone, with the header's logo row and the footer taking their
            share, the first line of the headline was gone and could not be
            scrolled to. Auto margins centre when there is room and sit at the
            top edge when there is not.
          */
          <div className="flex min-h-0 flex-1 overflow-y-auto px-6 py-4">
            <div className="m-auto flex w-full max-w-5xl flex-col items-center gap-8 md:flex-row md:justify-center md:gap-12">
              {/*
                The hero no longer repeats the product name. TopBar already
                prints "Photo Time Machine" in the corner of every frame, so
                the old hero title was the same string twice on one screen —
                the clearest symptom of the two halves competing. Ceding the
                name to TopBar lets the hero say what the app is FOR.

                Contrast, measured against the backdrop above rather than
                against #000, and quoted at the WORST point — inside the blue
                accent, which is the lightest the surface ever gets: title
                white 17.3:1, subtitle gray-300 11.8:1, steps gray-400 6.8:1.
                The first two clear the 7.4:1 that PR #32 set for this screen.
                The 14px step list does not, and is quoted honestly rather than
                rounded up: 6.8:1 is comfortably past the 4.5:1 WCAG AA needs
                at that size, and the list is supporting text, not the message.
                Away from the accent every figure is higher.

                The old `opacity-60` wash is gone. It existed to stop the hero
                competing with a panel that used to overlap it; nothing overlaps
                the hero now, so the wash was only costing contrast.
              */}
              <div className="min-w-0 text-center md:flex-1 md:text-left">
                <h2 className="text-2xl font-bold leading-tight sm:text-4xl lg:text-5xl">
                  Turn a photo into a 3D memory.
                </h2>
                <p className="mt-3 text-base text-gray-300 sm:mt-4 sm:text-lg lg:text-xl">
                  Create a 3D memory, or open one to explore.
                </p>

                {/*
                  An empty state's job is to say what happens next, and this
                  one said nothing but its own name — which is the other reason
                  it looked empty. It WAS empty. Hidden below `sm` (the capture
                  phone is 360x640) so the stacked mobile layout stays inside
                  one screen.
                */}
                <ol className="mt-8 hidden space-y-2.5 text-sm text-gray-400 sm:block">
                  {[
                    'Drop a photo, a burst, or a video.',
                    'An engine reconstructs it on your hardware.',
                    'Orbit the result, or share a link to it from your own server.',
                  ].map((step, i) => (
                    <li key={step} className="flex items-start gap-3">
                      {/*
                        gray-400, not gray-500: these numerals sit on the #000
                        viewport, and gray-500 is 4.34:1 there — under the 4.5:1
                        that 12px text needs, never mind PR #32's 7.4:1 bar for
                        this screen. `aria-hidden` because the <ol> already
                        conveys the ordering; that hides them from a screen
                        reader, not from the eye that has to read them.
                      */}
                      <span
                        aria-hidden="true"
                        className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-gray-600 text-xs text-gray-400"
                      >
                        {i + 1}
                      </span>
                      <span className="min-w-0">{step}</span>
                    </li>
                  ))}
                </ol>

                {/*
                  Buy / Download, under the steps: the hero is what a visitor reads, and
                  most visitors have no server of their own yet. Hidden below `sm` with
                  the steps — the footer carries both links on every screen.
                */}
                <CompanionCallouts variant="hero" />
              </div>

              {showControls && renderPanel('w-full max-w-md shrink-0')}
            </div>
          </div>
        )}
        </main>

        <SiteFooter />
      </div>
    </div>
  );
}

export default App;
