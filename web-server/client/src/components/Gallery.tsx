import React, { useEffect, useState } from "react";
import { api, Asset } from "../api";

/**
 * What this 3D memory is *of*.
 *
 * The card used to lead with `{kind} · {engine}` — "Splat · Preview" — which
 * names the file format and the reconstruction backend and says nothing about
 * the memory. The asset already carries the source it was built from
 * (`source_filenames`, set in server/app/jobs.py), so lead with that and let
 * the machinery be the subtitle.
 */
function assetTitle(a: Asset): string {
  const source = a.source_filenames?.[0];
  if (source) {
    const stem = source.replace(/\.[^./\\]+$/, "").trim();
    if (stem) return a.source_filenames.length > 1 ? `${stem} +${a.source_filenames.length - 1}` : stem;
  }
  if (a.source_origin === "memory") return "From Companion memory";
  return `${a.kind} · ${a.engine}`;
}

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
          {/*
            `toLocaleString()` printed to the second — "6/15/2026, 2:58:12 PM".
            A gallery is browsed by day, not by second; the seconds were pure
            noise competing with the title for a 2-column card's width.
          */}
          <div className="p-2 text-xs">
            <div className="truncate font-medium" title={assetTitle(a)}>
              {assetTitle(a)}
            </div>
            <div className="truncate capitalize text-gray-400">
              {a.kind} · {a.engine} ·{" "}
              {new Date(a.created_at).toLocaleDateString(undefined, {
                year: "numeric",
                month: "short",
                day: "numeric",
              })}
            </div>
          </div>
        </button>
      ))}
    </div>
  );
};

export default Gallery;
