import React, { useEffect, useState } from "react";

// Lightweight wrapper around Google's <model-viewer> web component for glTF/GLB meshes.
// Loaded lazily so the splat path (Spark) has no dependency on it. Gives free mobile AR
// (Scene Viewer / Quick Look) via the `ar` attribute.

interface MeshViewerProps {
  src: string;
  className?: string;
  poster?: string;
}

const MeshViewer: React.FC<MeshViewerProps> = ({ src, className, poster }) => {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // @ts-ignore — optional dependency, resolved at runtime
    import("@google/model-viewer")
      .then(() => !cancelled && setReady(true))
      .catch(() => !cancelled && setReady(false));
    return () => {
      cancelled = true;
    };
  }, []);

  if (!ready) {
    return (
      <div className={`flex items-center justify-center bg-ground text-white/60 ${className}`}>
        Loading mesh viewer…
      </div>
    );
  }

  return React.createElement("model-viewer", {
    src,
    poster,
    "camera-controls": true,
    "auto-rotate": true,
    ar: true,
    "shadow-intensity": "1",
    style: { width: "100%", height: "100%", backgroundColor: "#0c1018" },
    className,
  });
};

export default MeshViewer;
