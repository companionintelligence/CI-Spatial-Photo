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
          <div className="flex items-center justify-center w-full h-full text-center opacity-30">
            <div>
              <p className="mb-3 text-4xl font-bold">CI Photo Time Machine</p>
              <p className="text-xl">Create a 3D memory, or open one to explore.</p>
              {loadError && <p className="mt-3 text-red-400 text-sm">{loadError}</p>}
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

        {showControls && (
          <div className="pointer-events-auto w-full max-w-md m-4 rounded-xl bg-gray-900/90 backdrop-blur border border-gray-700 shadow-2xl overflow-hidden">
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

            <div className="max-h-[60vh] overflow-y-auto">
              {tab === 'create' && <CreatePanel onCreated={handleCreated} />}
              {tab === 'explore' && <Gallery onSelect={(a) => loadAsset(a.asset_id)} refreshKey={refreshKey} />}
              {tab === 'memory' && <MemoryPicker onCreated={handleCreated} />}
            </div>

            {asset && (
              <div className="flex items-center justify-between gap-2 p-3 border-t border-gray-700 text-xs">
                <span className="truncate text-gray-400">{asset.share_url}</span>
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
