import React, { useEffect, useState } from "react";
import { useDropzone } from "react-dropzone";
import { api, waitForJob, EngineCapabilities, Intent, Job } from "../api";
import { jobStatusLine } from "../jobStatus";

interface CreatePanelProps {
  onCreated: (assetId: string) => void;
}

const CreatePanel: React.FC<CreatePanelProps> = ({ onCreated }) => {
  const [files, setFiles] = useState<File[]>([]);
  const [engines, setEngines] = useState<EngineCapabilities[]>([]);
  const [engine, setEngine] = useState<string>("");
  const [intent, setIntent] = useState<Intent>("auto");
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.listEngines().then((r) => setEngines(r.engines)).catch(() => {});
  }, []);

  const onDrop = (accepted: File[]) => setFiles(accepted);
  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { "image/*": [], "video/*": [] },
  });

  const submit = async () => {
    if (!files.length) return;
    setBusy(true);
    setError(null);
    setJob(null);
    try {
      const created = await api.createJob({ files, engine: engine || undefined, intent });
      const done = await waitForJob(created.job_id, setJob);
      if (done.status === "error") throw new Error(done.error || "Job failed");
      if (done.asset_id) onCreated(done.asset_id);
    } catch (e: any) {
      setError(e.message || "Failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-4 space-y-3 text-sm">
      <div
        {...getRootProps()}
        className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition ${
          isDragActive ? "border-blue-400 bg-blue-500/10" : "border-gray-600 hover:border-gray-400"
        }`}
      >
        <input {...getInputProps()} />
        {files.length ? (
          <p>{files.length} file(s) selected — {files.map((f) => f.name).join(", ").slice(0, 60)}</p>
        ) : (
          <p>Drop an image, a set of images, or a video — or click to browse.</p>
        )}
      </div>

      {/*
        Two columns inside a panel that is only as wide as the viewport left the
        Engine select ~144px on a 360px phone, and the browser clipped its own
        selected option to "Auto (recommen" — a control failing to render its
        value, which reads as a bug rather than as a narrow screen. The pair
        stacks below `sm` and keeps the side-by-side layout everywhere the panel
        is at its full 448px. `min-w-0` lets each select actually shrink to its
        grid track instead of forcing the track wider than the panel.
      */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-gray-400">Engine</span>
          <select
            className="w-full min-w-0 bg-gray-800 rounded px-2 py-1"
            value={engine}
            onChange={(e) => setEngine(e.target.value)}
          >
            <option value="">Auto (recommended)</option>
            {engines.map((e) => (
              <option key={e.name} value={e.name} disabled={!e.available}>
                {e.name}
                {e.available ? "" : " (unavailable)"}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-gray-400">Intent</span>
          <select
            className="w-full min-w-0 bg-gray-800 rounded px-2 py-1"
            value={intent}
            onChange={(e) => setIntent(e.target.value as Intent)}
          >
            <option value="auto">Auto</option>
            <option value="object">Object (full 3D)</option>
            <option value="scene">Scene (portal)</option>
          </select>
        </label>
      </div>

      <button
        onClick={submit}
        disabled={busy || !files.length}
        className="w-full py-2 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-40"
      >
        {busy ? "Processing…" : "Create 3D"}
      </button>

      {job && <p className="text-gray-400">{jobStatusLine(job)}</p>}
      {error && <p className="text-red-400">Error: {error}</p>}
    </div>
  );
};

export default CreatePanel;
