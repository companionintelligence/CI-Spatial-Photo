import React, { useState, useEffect, useCallback } from 'react';
import SplatViewer from './components/SplatViewer';
import MeshViewer from './components/MeshViewer';
import TopBar from './components/TopBar';
import CreatePanel from './components/CreatePanel';
import Gallery from './components/Gallery';
import MemoryPicker from './components/MemoryPicker';
import { useHeadTracking } from './hooks/useHeadTracking';
import { Asset, api, fetchAssetAsFile, viewerSplatFormat, API_BASE } from './api';

type Tab = 'create' | 'explore' | 'memory';

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

  // UI / XR state
  const [isDarkMode, setIsDarkMode] = useState(true);
  const [isXREnabled, setIsXREnabled] = useState(false);
  const [showControls, setShowControls] = useState(true);

  const { headPosition, videoRef } = useHeadTracking(isXREnabled);

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
      window.history.replaceState({}, '', `/view/${assetId}`);
    } catch (e: any) {
      setLoadError(e.message || 'Failed to load asset');
    }
  }, []);

  // Deep-link: /view/:assetId opens straight into the shared asset.
  useEffect(() => {
    const id = parseViewId();
    if (id) loadAsset(id);
  }, [loadAsset]);

  const handleCreated = (assetId: string) => {
    setRefreshKey((k) => k + 1);
    setTab('explore');
    loadAsset(assetId);
  };

  const share = () => {
    if (asset?.share_url) {
      navigator.clipboard?.writeText(asset.share_url).catch(() => {});
    }
  };

  return (
    <div className={isDarkMode ? 'text-white' : 'text-gray-900'}>
      {/* Full-screen viewer background */}
      <div className="absolute inset-0 z-0 overflow-hidden bg-black">
        {asset && asset.kind === 'mesh' ? (
          <MeshViewer
            src={`${API_BASE}/api/v1/assets/${asset.asset_id}/file?format=glb`}
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
            The empty-state hero used to be centred in the whole viewport while
            the controls panel floated over its top-left corner. The panel is
            opaque, so the hero came out sliced: on desktop the subtitle read
            "reate a 3D memory, or open one to explore." and on a 360px phone
            stray half-glyphs poked out of both panel edges. Neither is a
            capture artifact — that is what the app draws.

            So the hero now respects the panel's footprint instead of sitting
            under it. `md:pl-[30rem]` is the panel's own width budget
            (max-w-md = 28rem, plus m-4 either side), which re-centres the hero
            in the space the panel does not use — and fills the dead right half
            of a wide window. Below `md` there is no such space, so the hero
            steps aside entirely while the panel is up; the panel already says
            everything the hero would. Toggling the panel off (the eye button)
            brings the hero back full-screen at every width, which is the one
            moment it is actually needed.
          */
          <div
            className={`w-full h-full items-center justify-center text-center opacity-30 px-6 md:pl-[30rem] ${
              showControls ? 'hidden md:flex' : 'flex'
            }`}
          >
            <div>
              <p className="mb-3 text-4xl font-bold">Photo Time Machine</p>
              <p className="text-xl">Create a 3D memory, or open one to explore.</p>
            </div>
          </div>
        )}
      </div>

      {/* Overlay UI */}
      <div className="relative z-10 flex flex-col h-screen pointer-events-none">
        <TopBar
          isXREnabled={isXREnabled}
          setIsXREnabled={setIsXREnabled}
          isDarkMode={isDarkMode}
          setIsDarkMode={setIsDarkMode}
          showControls={showControls}
          setShowControls={setShowControls}
          headPosition={headPosition}
          videoRef={videoRef}
        />

        {/*
          No `w-full` on the panel. `width: 100%` resolves against the flex
          container (the full viewport), and `m-4` then adds 16px on each side on
          top of that — so on a 360px phone the panel laid out 392px wide and its
          rightmost tab, "From Memory", hung off the screen. Letting the flex item
          stretch instead sizes it to the container MINUS its margins. `max-w-md`
          (28rem = 448px) still clamps it, so anything wider than 480px — every
          desktop layout — renders exactly as before.
        */}
        {showControls && (
          <div className="pointer-events-auto max-w-md m-4 rounded-xl bg-gray-900/90 backdrop-blur border border-gray-700 shadow-2xl overflow-hidden">
            <div className="flex border-b border-gray-700 text-sm">
              {(['create', 'explore', 'memory'] as Tab[]).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`flex-1 py-2 capitalize ${tab === t ? 'bg-gray-800 font-medium' : 'hover:bg-gray-800/50'}`}
                >
                  {t === 'memory' ? 'From Memory' : t}
                </button>
              ))}
            </div>

            {/*
              loadError used to live inside the background hero, which now hides
              itself behind the panel on phones — so a failed deep-link would have
              gone silent there. It belongs on the panel regardless: that is the
              layer the user is looking at.
            */}
            {loadError && (
              <p className="px-4 pt-3 text-sm text-red-400" role="alert">
                {loadError}
              </p>
            )}

            <div className="max-h-[60vh] overflow-y-auto">
              {tab === 'create' && <CreatePanel onCreated={handleCreated} />}
              {tab === 'explore' && <Gallery onSelect={(a) => loadAsset(a.asset_id)} refreshKey={refreshKey} />}
              {tab === 'memory' && <MemoryPicker onCreated={handleCreated} />}
            </div>

            {/*
              Side by side, the share URL had ~200px on a 360px phone and
              truncated to "https://photo-time-machine.local/vie…" — the one
              string on the screen a viewer might want to read. Stacking it
              above the button below `sm` gives it the full panel width.
            */}
            {asset && (
              <div className="flex flex-col items-stretch gap-2 p-3 border-t border-gray-700 text-xs sm:flex-row sm:items-center sm:justify-between">
                <span className="min-w-0 truncate text-gray-400">{asset.share_url}</span>
                <button onClick={share} className="px-3 py-1 rounded bg-blue-600 hover:bg-blue-500 shrink-0">
                  Copy link
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
