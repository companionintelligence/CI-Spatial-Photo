// API client for the CI Photo Time Machine processing server.

export const API_BASE =
  (process.env.REACT_APP_API_BASE as string) || "http://localhost:8000";

export type AssetKind = "splat" | "mesh";
export type Intent = "auto" | "object" | "scene";
/** How the server classifies an upload — server/app/models.py `SourceType`. */
export type SourceType = "image" | "images" | "video";

export interface Asset {
  asset_id: string;
  owner: string;
  kind: AssetKind;
  engine: string;
  source_type: SourceType;
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

/**
 * One selectable checkpoint inside an engine — `EngineModelInfo` in models.py.
 *
 * The depth engines wrap a family of interchangeable weights and advertise them
 * here rather than registering one engine per checkpoint, so an engine's own
 * `license` and `requires_gpu` can be a pointer ("Per-model — see
 * models[].license") while the checkpoint that will actually run carries the
 * real answer. Anything the panel says about licence or hardware for such an
 * engine has to come from here or it is wrong.
 */
export interface EngineModelInfo {
  id: string;
  label: string;
  description: string;
  license: string;
  commercial: boolean;
  requires_gpu: boolean;
  temporal: boolean;
  approx_download_mb: number | null;
  weights_cached: boolean;
  available: boolean;
  unavailable_reason?: string | null;
}

/**
 * One entry of `GET /api/v1/engines`, normalized — see {@link normalizeEngine}.
 *
 * Mirrors `EngineCapabilities` in server/app/models.py. Every field here is
 * non-optional because the normalizer guarantees it, NOT because the wire does.
 */
export interface EngineCapabilities {
  name: string;
  description: string;
  inputs: SourceType[];
  intents: Intent[];
  output_kind: AssetKind;
  output_formats: string[];
  commercial: boolean;
  requires_gpu: boolean;
  license: string;
  available: boolean;
  unavailable_reason?: string | null;
  /** Empty for a single-model engine; models.py defaults it to []. */
  models: EngineModelInfo[];
  default_model: string | null;
}

/**
 * Coerce one raw `/engines` entry into a shape the Create panel can render blind.
 *
 * The engine roster is server-owned and grows independently of this bundle: a
 * new depth-estimation engine can ship, or an existing one can gain a field,
 * without the client being rebuilt. The panel does arithmetic on the list
 * (`inputs.includes(...)`, `output_formats.join(...)`) the moment it renders, so
 * a single absent array is not a missing label — it is a TypeError thrown during
 * render, which React escalates into an unmounted subtree. The user sees the
 * whole Create tab go blank because one engine shipped without `intents`.
 *
 * So: every field this build knows about gets a conservative default, and the
 * raw object is spread through first so fields it does NOT know about survive
 * for a later build to read. Entries that cannot be an `<option>` at all — no
 * usable `name` — are dropped rather than rendered as a nameless choice.
 */
export function normalizeEngine(raw: unknown): EngineCapabilities | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;

  const name = typeof e.name === "string" ? e.name.trim() : "";
  if (!name) return null;

  // Unrecognised members are kept rather than filtered out: `inputs: ["pointcloud"]`
  // from a future server should make this engine match nothing, not make it match
  // everything by arriving as an empty list.
  const stringList = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

  const models = (Array.isArray(e.models) ? e.models : [])
    .map((raw): EngineModelInfo | null => {
      if (!raw || typeof raw !== "object") return null;
      const m = raw as Record<string, unknown>;
      const id = typeof m.id === "string" ? m.id.trim() : "";
      if (!id) return null;
      const mb = typeof m.approx_download_mb === "number" ? m.approx_download_mb : null;
      return {
        ...m,
        id,
        label: typeof m.label === "string" && m.label ? m.label : id,
        description: typeof m.description === "string" ? m.description : "",
        license: typeof m.license === "string" ? m.license : "",
        commercial: m.commercial === true,
        requires_gpu: m.requires_gpu === true,
        temporal: m.temporal === true,
        approx_download_mb: mb,
        weights_cached: m.weights_cached === true,
        available: m.available !== false,
        unavailable_reason:
          typeof m.unavailable_reason === "string" && m.unavailable_reason.trim()
            ? m.unavailable_reason
            : null,
      };
    })
    .filter((m): m is EngineModelInfo => m !== null);

  return {
    ...e,
    name,
    description: typeof e.description === "string" ? e.description : "",
    inputs: stringList(e.inputs) as SourceType[],
    intents: stringList(e.intents) as Intent[],
    output_kind: e.output_kind === "mesh" ? "mesh" : "splat",
    output_formats: stringList(e.output_formats),
    commercial: e.commercial === true,
    requires_gpu: e.requires_gpu === true,
    license: typeof e.license === "string" ? e.license : "",
    // models.py defaults `available` to True, so only an explicit false is a no.
    // Treating "absent" as unavailable would grey out every engine on a server
    // that trims default-valued fields from its JSON.
    available: e.available !== false,
    unavailable_reason:
      typeof e.unavailable_reason === "string" && e.unavailable_reason.trim()
        ? e.unavailable_reason
        : null,
    models,
    default_model: typeof e.default_model === "string" ? e.default_model : null,
  };
}

export function normalizeEngines(raw: unknown): EngineCapabilities[] {
  const list = raw && typeof raw === "object" ? (raw as { engines?: unknown }).engines : null;
  if (!Array.isArray(list)) return [];
  return list
    .map(normalizeEngine)
    .filter((e): e is EngineCapabilities => e !== null);
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
  listEngines: (): Promise<{ engines: EngineCapabilities[] }> =>
    fetch(`${API_BASE}/api/v1/engines`, { headers: authHeaders() })
      .then((r) => j<unknown>(r))
      .then((raw) => ({ engines: normalizeEngines(raw) })),

  createJob: (opts: {
    files?: File[];
    memoryRefs?: string[];
    engine?: string;
    intent?: Intent;
    /*
      Which checkpoint inside the engine should run. Optional, and omitted
      rather than sent empty: the server treats an absent `model` as "use this
      engine's default_model", and sending "" would be a request for a
      checkpoint named "" — a 4xx instead of the default.

      Only meaningful for engines that advertise `models`. The single-model
      engines (preview, triposplat, sharp, photogrammetry) ignore it.
    */
    model?: string;
  }) => {
    const fd = new FormData();
    (opts.files || []).forEach((f) => fd.append("files", f));
    if (opts.memoryRefs?.length) fd.append("memory_refs", JSON.stringify(opts.memoryRefs));
    if (opts.engine) fd.append("engine", opts.engine);
    if (opts.intent) fd.append("intent", opts.intent);
    if (opts.model) fd.append("model", opts.model);
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
