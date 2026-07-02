import React, { useEffect, useState } from "react";
import { api, waitForJob, MemoryMedia, Job } from "../api";

interface MemoryPickerProps {
  onCreated: (assetId: string) => void;
}

// Browse the photos/videos in the user's Companion (CI-Server) memory and turn one into a splat.
const MemoryPicker: React.FC<MemoryPickerProps> = ({ onCreated }) => {
  const [media, setMedia] = useState<MemoryMedia[]>([]);
  const [type, setType] = useState<"image" | "video">("image");
  const [job, setJob] = useState<Job | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    api
      .listMemoryMedia(type)
      .then((r) => {
        setMedia(r.media);
        if (!r.media.length) setNote("No media in Companion memory (or memory not configured).");
        else setNote(null);
      })
      .catch(() => setNote("Companion memory is not connected."));
  }, [type]);

  const create = async (ref: string) => {
    setJob(null);
    try {
      const created = await api.createJob({ memoryRefs: [ref] });
      const done = await waitForJob(created.job_id, setJob);
      if (done.status === "done" && done.asset_id) onCreated(done.asset_id);
    } catch {
      setNote("Failed to create from memory item.");
    }
  };

  return (
    <div className="p-4 space-y-3 text-sm">
      <div className="flex gap-2">
        <button
          className={`px-2 py-1 rounded ${type === "image" ? "bg-blue-600" : "bg-gray-800"}`}
          onClick={() => setType("image")}
        >
          Photos
        </button>
        <button
          className={`px-2 py-1 rounded ${type === "video" ? "bg-blue-600" : "bg-gray-800"}`}
          onClick={() => setType("video")}
        >
          Videos
        </button>
      </div>
      {note && <p className="text-gray-400">{note}</p>}
      {job && <p className="text-gray-400">Status: {job.status} — {job.message}</p>}
      <div className="grid grid-cols-3 gap-2">
        {media.map((m) => (
          <button
            key={m.ref}
            onClick={() => create(m.ref)}
            title={m.title || m.ref}
            className="rounded overflow-hidden bg-gray-800 hover:ring-2 ring-blue-500 aspect-square"
          >
            {m.thumbnail_url ? (
              <img src={m.thumbnail_url} alt={m.title || ""} className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-xs text-gray-500">
                {m.kind}
              </div>
            )}
          </button>
        ))}
      </div>
    </div>
  );
};

export default MemoryPicker;
