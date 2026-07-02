import React, { useEffect, useState } from "react";
import { api, Asset } from "../api";

interface GalleryProps {
  onSelect: (asset: Asset) => void;
  refreshKey?: number;
}

const Gallery: React.FC<GalleryProps> = ({ onSelect, refreshKey }) => {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listAssets()
      .then((r) => setAssets(r.assets))
      .catch((e) => setError(e.message));
  }, [refreshKey]);

  if (error) return <p className="p-4 text-red-400 text-sm">Could not load assets: {error}</p>;
  if (!assets.length)
    return <p className="p-4 text-gray-400 text-sm">No 3D memories yet — create one above.</p>;

  return (
    <div className="grid grid-cols-2 gap-2 p-4">
      {assets.map((a) => (
        <button
          key={a.asset_id}
          onClick={() => onSelect(a)}
          className="group text-left rounded-lg overflow-hidden bg-gray-800 hover:ring-2 ring-blue-500"
        >
          <div className="aspect-video bg-black overflow-hidden">
            {a.thumbnail ? (
              <img
                src={api.thumbnailUrl(a.asset_id)}
                alt={a.engine}
                className="w-full h-full object-cover group-hover:scale-105 transition"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-gray-500 text-xs">
                {a.kind}
              </div>
            )}
          </div>
          <div className="p-2 text-xs">
            <div className="font-medium capitalize">{a.kind} · {a.engine}</div>
            <div className="text-gray-400">{new Date(a.created_at).toLocaleString()}</div>
          </div>
        </button>
      ))}
    </div>
  );
};

export default Gallery;
