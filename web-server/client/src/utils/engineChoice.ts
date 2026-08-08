import { EngineCapabilities, EngineModelInfo, Intent, SourceType } from "../api";

/**
 * What the Create panel needs to say about engine choice before the job exists.
 *
 * All of this is a *prediction* of what server/app/engines/registry.py
 * `EngineRegistry.route()` will do, computed from the same capability data the
 * server publishes at `GET /engines`. It is deliberately data-driven rather
 * than a hard-coded copy of that function: the engine roster is server-owned
 * and grows (depth estimators, new photogrammetry backends) without this bundle
 * being rebuilt, and a mirror keyed on engine NAMES would quietly start lying
 * the first time one shipped.
 *
 * Three inputs to the real router are not on the wire, and that is why nothing
 * here is phrased as a promise:
 *   - `settings.default_engine` (config.py, currently "triposplat") decides the
 *     single-image tie the capability data cannot.
 *   - `settings.sharp_enable_research` gates SHARP's `can_handle`, though it
 *     also drives `available`, so it does reach us in the normal case.
 *   - `settings.depth_auto_route` (off by default) keeps the depth engines OUT
 *     of automatic routing even while they report themselves available, so an
 *     engine this file ranks first can still be one the router skips.
 * So the multi-candidate case says "the server has the final say" outright, and
 * the single-candidate case is worded as a fact about the roster ("the only
 * available engine that takes a video") rather than as a routing guarantee.
 * Once a job exists this stops predicting altogether and the panel reports the
 * engine the server actually chose (`Job.engine`).
 */
export interface SourceSummary {
  type: SourceType;
  count: number;
}

export interface AutoRoute {
  /** The engine Auto is expected to route to, or null when nothing can take the input. */
  engine: EngineCapabilities | null;
  /** One sentence for the panel. Always populated, including for the null case. */
  reason: string;
  /** True only when the capability data admits exactly one answer. */
  confident: boolean;
  /** Engines that match the input but report themselves unavailable, with reasons to show. */
  blocked: EngineCapabilities[];
  /** Set when the current intent finds nothing but another intent would. */
  alternative: { intent: Intent; engine: EngineCapabilities } | null;
}

/**
 * Suffixes copied from server/app/routes.py `VIDEO_EXT`.
 *
 * Classification is by filename suffix ONLY, deliberately ignoring `File.type`,
 * because this has to predict the branch the SERVER takes and the server never
 * sees the browser's MIME guess — it re-derives the type from the uploaded
 * filename. A `.mov` renamed to `.bin` is an "image" to `_classify()`, so it
 * has to be an image here too; a panel that says "video → photogrammetry" and
 * then watches the server run the preview engine on frame zero is worse than
 * one that says nothing.
 */
const VIDEO_SUFFIXES = [".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v"];

export function classifySource(files: readonly { name: string }[]): SourceSummary | null {
  if (!files.length) return null;
  // Matches `_classify`: ANY video among the files makes the whole set a video.
  const hasVideo = files.some((f) => {
    const name = (f.name || "").toLowerCase();
    return VIDEO_SUFFIXES.some((suffix) => name.endsWith(suffix));
  });
  if (hasVideo) return { type: "video", count: files.length };
  return { type: files.length > 1 ? "images" : "image", count: files.length };
}

export function describeSource(source: SourceSummary): string {
  if (source.type === "video") {
    return source.count > 1 ? `${source.count} files (routed as video)` : "a video";
  }
  return source.count === 1 ? "1 image" : `${source.count} images`;
}

export function intentLabel(intent: Intent): string {
  return intent === "auto" ? "Auto" : intent === "object" ? "Object" : "Scene";
}

/** The one line that sits under the Intent select. Short enough for one line at 360px. */
export function describeIntent(intent: Intent): string {
  if (intent === "object") return "One subject, orbit from any side.";
  if (intent === "scene") return "A room-scale portal you look into.";
  return "Server infers it from your input.";
}

export function handlesSource(engine: EngineCapabilities, source: SourceSummary): boolean {
  return engine.inputs.includes(source.type);
}

/**
 * An engine accepts an intent if it names it, or if it lists "auto" — an engine
 * that advertises "auto" is telling the router it will take whatever it is
 * handed. SHARP lists `["scene"]` and nothing else, which is exactly why
 * `route()` only reaches for it on the scene branch.
 */
export function acceptsIntent(engine: EngineCapabilities, intent: Intent): boolean {
  if (intent === "auto") return engine.intents.includes("auto");
  return engine.intents.includes(intent) || engine.intents.includes("auto");
}

/**
 * 2 for a DEDICATED engine — one that names this intent and does not also
 * advertise "auto" — and 0 for everything else.
 *
 * "Names the intent" is not enough, and getting that wrong made the panel state
 * a falsehood. `route()` does not look for "an engine that lists scene"; step 3
 * reaches for SHARP *by name* and, if SHARP is unavailable, falls straight
 * through to `settings.default_engine` (registry.py). Preview lists
 * `["auto", "scene"]`, so scoring it as a scene specialist made it beat
 * triposplat on the stock posture — SHARP_ENABLE_RESEARCH=0, DEFAULT_ENGINE
 * =triposplat — and the panel announced "Auto's pick: preview" for a job the
 * server routes to triposplat.
 *
 * Requiring the absence of "auto" reproduces the server's actual shape without
 * hard-coding "sharp" here: an engine that lists ONLY `["scene"]` is opting out
 * of general routing, which is exactly the property that earns SHARP its own
 * branch. Everything that lists "auto" competes on the later tiebreaks, which
 * are the ones that model `default_engine`.
 */
function specialism(engine: EngineCapabilities, intent: Intent): number {
  if (intent === "auto") return 0;
  return engine.intents.includes(intent) && !engine.intents.includes("auto") ? 2 : 0;
}

function rank(engines: EngineCapabilities[], intent: Intent): EngineCapabilities[] {
  return engines.slice().sort(
    (a, b) =>
      // A named specialty beats a generalist: `route()` reaches for SHARP on
      // intent=scene before it falls through to the configured default.
      specialism(b, intent) - specialism(a, intent) ||
      // Then the narrower engine: SHARP lists one intent, Preview lists two, and
      // on the scene branch the server prefers SHARP.
      a.intents.length - b.intents.length ||
      // Then GPU over CPU. An engine that requires a GPU and still reports itself
      // available is one the operator provisioned on purpose; the CPU engine is
      // documented as the fallback that guarantees *something* renders
      // (preview.py). That ordering is what makes intent=auto on a single image
      // land on triposplat, which is `default_engine` in config.py.
      Number(b.requires_gpu) - Number(a.requires_gpu),
    // Array.prototype.sort is stable, so a full tie keeps the server's own order.
  );
}

const ALL_INTENTS: Intent[] = ["auto", "object", "scene"];

/** The eligible/blocked split for one (source, intent) pair. No recursion, no copy. */
function candidates(
  engines: readonly EngineCapabilities[],
  source: SourceSummary,
  intent: Intent,
) {
  const handles = engines.filter((e) => handlesSource(e, source));
  const wanted = handles.filter((e) => acceptsIntent(e, intent));
  return {
    handles,
    eligible: wanted.filter((e) => e.available),
    blocked: wanted.filter((e) => !e.available),
  };
}

export function chooseAutoEngine(
  engines: readonly EngineCapabilities[],
  source: SourceSummary | null,
  intent: Intent,
): AutoRoute {
  const empty: AutoRoute = {
    engine: null,
    reason: "",
    confident: false,
    blocked: [],
    alternative: null,
  };

  if (!engines.length) {
    return { ...empty, reason: "The server lists no engines, so nothing can run." };
  }
  if (!source) {
    // Under 40 characters on purpose: this is the line the empty Create tab
    // shows, it renders on one row of a 296px column, and the empty state is
    // the one that has to fit beside the hero on a 360x640 phone.
    return { ...empty, reason: "Add a file to see the engine Auto picks." };
  }

  const src = describeSource(source);
  const label = intentLabel(intent);
  const { handles, eligible, blocked } = candidates(engines, source, intent);

  if (!eligible.length) {
    // A dead end is worth naming a way out of, and the capability data knows one:
    // an engine that lists only `["scene"]` (SHARP) is invisible to intent=auto,
    // so on a box where it is the only thing installed, Auto fails while Scene
    // would have worked. Nothing in the dropdown says that.
    const alternative = ALL_INTENTS.filter((i) => i !== intent)
      .map((i) => {
        const [best] = rank(candidates(engines, source, i).eligible, i);
        return best ? { intent: i, engine: best } : null;
      })
      .find((hit): hit is { intent: Intent; engine: EngineCapabilities } => hit !== null);

    const reason = blocked.length
      ? `Nothing available takes ${src} on intent ${label}.`
      : handles.length
        ? `No engine lists intent ${label} for ${src}.`
        : `No engine takes ${src}.`;
    return { ...empty, reason, blocked, alternative: alternative ?? null };
  }

  const [winner, ...rest] = rank(eligible, intent);
  if (!rest.length) {
    return {
      engine: winner,
      reason: `The only available engine that takes ${src} on intent ${label}.`,
      confident: true,
      blocked,
      alternative: null,
    };
  }

  const others = `${rest.length} other engine${rest.length === 1 ? "" : "s"} could also take it`;
  const reason = specialism(winner, intent)
    ? `Names ${intent} as a specialty for ${src}; ${others}, so the server has the final say.`
    : `The most capable of ${eligible.length} engines that take ${src} on intent ${label}; the server has the final say.`;
  return { engine: winner, reason, confident: false, blocked, alternative: null };
}

/**
 * Why an explicitly chosen engine cannot run this input, phrased for the user.
 *
 * These are the two failures `route()` raises for a requested engine, and they
 * arrive today as a job that goes straight to `error` after the upload. Saying
 * it before the upload is the whole point of listing `available` in the API.
 */
export function explicitEngineBlocker(
  engine: EngineCapabilities,
  source: SourceSummary | null,
): string | null {
  if (!engine.available) {
    return engine.unavailable_reason || `${engine.name} reports itself unavailable.`;
  }
  if (source && !handlesSource(engine, source)) {
    const takes = engine.inputs.length ? engine.inputs.join(", ") : "nothing this build recognises";
    return `${engine.name} does not take ${describeSource(source)} — it accepts ${takes}.`;
  }
  return null;
}

/**
 * The checkpoint this engine will actually run, for an engine that has a choice.
 *
 * `JobInput.requested_model` defaults to None and the engine falls back to
 * `default_model`, so with no model picker in this panel the default IS what
 * runs — which makes it, not the engine row, the honest source for licence and
 * hardware. Falls back to the first advertised model when `default_model` names
 * something the roster does not contain.
 */
export function activeModel(engine: EngineCapabilities): EngineModelInfo | null {
  if (!engine.models.length) return null;
  return engine.models.find((m) => m.id === engine.default_model) ?? engine.models[0];
}

/** Hardware, output and licence, in the order that survives truncation best. */
export function engineMetaLine(engine: EngineCapabilities): string {
  const output = engine.output_formats.length
    ? `${engine.output_kind} (${engine.output_formats.join(", ")})`
    : engine.output_kind;
  // A multi-model engine's own licence is a pointer — depth_image.py literally
  // says "Per-model — see models[].license" — and printing a pointer where the
  // user is looking for a licence is worse than printing nothing. Same for the
  // GPU flag: the engine says CPU because its *small* checkpoint is CPU-only.
  const model = activeModel(engine);
  return [
    (model ?? engine).requires_gpu ? "Needs a GPU" : "Runs on CPU",
    output,
    (model?.license || engine.license) ?? "",
    (model ?? engine).commercial ? "Commercial OK" : "Non-commercial",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** One line per checkpoint for the expanded roster. */
export function modelLine(engine: EngineCapabilities, model: EngineModelInfo): string {
  const size = model.approx_download_mb ? `${model.approx_download_mb} MB` : null;
  return [
    model.id === (engine.default_model ?? "") ? "default" : null,
    model.license,
    model.requires_gpu ? "GPU" : "CPU",
    model.temporal ? "temporally consistent" : null,
    size,
    model.weights_cached ? "downloaded" : "not downloaded yet",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The fuller line for the expanded roster, where wrapping is free. */
export function engineRosterLine(engine: EngineCapabilities): string {
  const takes = engine.inputs.length ? engine.inputs.join(", ") : "no input this build recognises";
  const intents = engine.intents.length ? engine.intents.join(", ") : "no intent";
  const checkpoints = engine.models.length
    ? ` · ${engine.models.length} checkpoint${engine.models.length === 1 ? "" : "s"}`
    : "";
  return `Takes ${takes} · intent ${intents} · ${engineMetaLine(engine)}${checkpoints}`;
}
