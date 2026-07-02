// API client for the CI Photo Time Machine processing server.

export const API_BASE =
  (process.env.REACT_APP_API_BASE as string) || "http://localhost:8000";

export type AssetKind = "splat" | "mesh";
export type Intent = "auto" | "object" | "scene";

export interface Asset {
  asset_id: string;
  owner: string;
  kind: AssetKind;
  engine: string;
  source_type: "image" | "images" | "video";
  source_origin: "upload" | "memory";
  source_filenames: string[];
  temporal: boolean;
  formats: Record<string, string>;
  thumbnail?: string | null;
  share_url: string;
  created_at: string;
  tags: string[];
}

export interface Job {
  job_id: string;
  owner: string;
  status: "queued" | "running" | "done" | "error";
  engine?: string | null;
  message: string;
  error?: string | null;
  asset_id?: string | null;
}

export interface EngineCapabilities {
  name: string;
  description: string;
  inputs: string[];
  intents: Intent[];
  output_kind: AssetKind;
  output_formats: string[];
  commercial: boolean;
  requires_gpu: boolean;
  license: string;
  available: boolean;
  unavailable_reason?: string | null;
}

export interface MemoryMedia {
  ref: string;
  kind: "image" | "video";
  title?: string | null;
  thumbnail_url?: string | null;
}

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("ci_token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error((await res.text()) || res.statusText);
  return res.json() as Promise<T>;
}

export const api = {
  listEngines: () =>
    fetch(`${API_BASE}/api/v1/engines`, { headers: authHeaders() }).then((r) =>
      j<{ engines: EngineCapabilities[] }>(r)
    ),

  createJob: (opts: {
    files?: File[];
    memoryRefs?: string[];
    engine?: string;
    intent?: Intent;
  }) => {
    const fd = new FormData();
    (opts.files || []).forEach((f) => fd.append("files", f));
    if (opts.memoryRefs?.length) fd.append("memory_refs", JSON.stringify(opts.memoryRefs));
    if (opts.engine) fd.append("engine", opts.engine);
    if (opts.intent) fd.append("intent", opts.intent);
    return fetch(`${API_BASE}/api/v1/jobs`, {
      method: "POST",
      headers: authHeaders(),
      body: fd,
    }).then((r) => j<Job>(r));
  },

  getJob: (id: string) =>
    fetch(`${API_BASE}/api/v1/jobs/${id}`, { headers: authHeaders() }).then((r) => j<Job>(r)),

  listAssets: () =>
    fetch(`${API_BASE}/api/v1/assets`, { headers: authHeaders() }).then((r) =>
      j<{ assets: Asset[] }>(r)
    ),

  getAsset: (id: string) =>
    fetch(`${API_BASE}/api/v1/assets/${id}`, { headers: authHeaders() }).then((r) => j<Asset>(r)),

  listMemoryMedia: (type: "image" | "video" = "image") =>
    fetch(`${API_BASE}/api/v1/memory/media?type=${type}`, { headers: authHeaders() }).then((r) =>
      j<{ media: MemoryMedia[] }>(r)
    ),

  assetFileUrl: (id: string, format: string) =>
    `${API_BASE}/api/v1/assets/${id}/file?format=${format}`,

  thumbnailUrl: (id: string) => `${API_BASE}/api/v1/assets/${id}/thumbnail`,
};

// Poll a job to completion.
export async function waitForJob(
  id: string,
  onUpdate?: (job: Job) => void,
  intervalMs = 1500,
  timeoutMs = 20 * 60 * 1000
): Promise<Job> {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const job = await api.getJob(id);
    onUpdate?.(job);
    if (job.status === "done" || job.status === "error") return job;
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for job.");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// Best on-the-wire format available for an asset.
export function bestFormat(asset: Asset): { format: string; url: string } {
  const order = asset.kind === "mesh" ? ["glb", "gltf"] : ["spz", "sog", "ply", "splat"];
  const fmt = order.find((f) => asset.formats[f]) || Object.keys(asset.formats)[0];
  return { format: fmt, url: api.assetFileUrl(asset.asset_id, fmt) };
}

// Format the Spark viewer's format registry can parse, smallest-on-the-wire first.
export function viewerSplatFormat(asset: Asset): string {
  return ["spz", "sog", "ply"].find((f) => asset.formats[f]) || Object.keys(asset.formats)[0];
}

// Download an asset artifact as a named File (so the viewer's extension-based format
// detection works regardless of the query-string download URL).
export async function fetchAssetAsFile(asset: Asset, format: string): Promise<File> {
  const res = await fetch(api.assetFileUrl(asset.asset_id, format), { headers: authHeaders() });
  if (!res.ok) throw new Error(await res.text());
  const blob = await res.blob();
  return new File([blob], `model.${format}`);
}
