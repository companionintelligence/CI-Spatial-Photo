import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useDropzone } from "react-dropzone";
import { api, waitForJob, EngineCapabilities, Intent, Job } from "../api";
import { jobStatusLine } from "../jobStatus";
import {
  chooseAutoEngine,
  classifySource,
  describeIntent,
  engineMetaLine,
  engineRosterLine,
  explicitEngineBlocker,
  intentLabel,
  modelLine,
} from "../utils/engineChoice";

interface CreatePanelProps {
  onCreated: (assetId: string) => void;
}

/**
 * The engine list is the one thing on this panel that can fail on its own, and
 * the three outcomes need different copy — `.catch(() => {})` used to collapse
 * all of them into "the dropdown has one option in it", which reads as an app
 * with exactly one engine rather than as a server that never answered.
 */
type EngineLoad =
  | { state: "loading" }
  | { state: "ready"; engines: EngineCapabilities[] }
  | { state: "error"; message: string };

function loadErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e ?? "");
  const text = raw.trim();
  if (!text) return "the server did not answer.";
  // `j()` in api.ts throws the response body verbatim; a proxy or a crashed
  // worker answers with an HTML error page, and pasting a page of markup into a
  // 448px panel loses the one line above it that says what broke.
  return text.length > 140 ? `${text.slice(0, 140)}…` : text;
}

const CreatePanel: React.FC<CreatePanelProps> = ({ onCreated }) => {
  const [files, setFiles] = useState<File[]>([]);
  const [load, setLoad] = useState<EngineLoad>({ state: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const [engine, setEngine] = useState<string>("");
  /*
    "" means "let the engine use its own default_model", which is exactly what
    an absent `model` field means to the server — so the empty state needs no
    special case at submit time.

    Cleared whenever the engine changes (see the Engine select's onChange):
    checkpoint ids are scoped to their engine, so carrying
    `depth-anything-v2-large` across to `depth-video` would submit a model that
    engine has never heard of.
  */
  const [model, setModel] = useState<string>("");
  const [intent, setIntent] = useState<Intent>("auto");
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoad({ state: "loading" });
    api
      .listEngines()
      .then((r) => {
        if (!cancelled) setLoad({ state: "ready", engines: r.engines });
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoad({ state: "error", message: loadErrorMessage(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  /**
   * Changing any input clears the last job. The panel reports the engine that
   * job actually ran ("Auto chose preview"), so leaving it in place while the
   * user re-picks would leave a stale answer attached to a question they have
   * already changed — and the status line under the button would describe a run
   * that no longer corresponds to what is staged.
   */
  const restage = () => {
    setJob(null);
    setError(null);
  };

  const onDrop = (accepted: File[]) => {
    setFiles(accepted);
    restage();
  };
  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { "image/*": [], "video/*": [] },
  });

  const engines = load.state === "ready" ? load.engines : [];
  const source = useMemo(() => classifySource(files), [files]);
  const auto = useMemo(() => chooseAutoEngine(engines, source, intent), [engines, source, intent]);

  const chosen = engine ? engines.find((e) => e.name === engine) ?? null : null;

  /*
    Checkpoints offered by the explicitly chosen engine. Empty under Auto (no
    engine settled yet) and empty for the four single-model engines, which is
    what keeps the Model select from rendering at all in those cases.
  */
  const modelChoices = chosen?.models ?? [];
  const defaultModelLabel =
    modelChoices.find((m) => m.id === chosen?.default_model)?.label ?? null;
  const pickedModel = model ? modelChoices.find((m) => m.id === model) ?? null : null;
  /**
   * Once the server has answered we stop guessing. `Job.engine` is what actually
   * ran, so an Auto route that predicted triposplat and got preview corrects
   * itself in place rather than leaving a confident wrong label on screen.
   */
  const settled = job?.engine ? engines.find((e) => e.name === job.engine) ?? null : null;
  const shown = chosen ?? settled ?? auto.engine;
  const autoTag = engine ? null : settled ? "Auto chose" : auto.engine ? "Auto's pick" : null;

  /**
   * Why the engine on screen is the engine on screen. `auto.reason` explains
   * Auto's candidate and NOTHING else: printing it under an engine the user
   * picked by hand attributes SHARP's "names scene as a specialty" line to
   * preview, which is not merely unhelpful, it is false. An override gets the
   * one fact Auto can still contribute — what it would have done instead.
   */
  const rationale = chosen
    ? auto.engine
      ? auto.engine.name === chosen.name
        ? "Your pick — the same engine Auto would route to."
        : `Your pick. Auto would route to ${auto.engine.name}.`
      : "Your pick, in place of Auto."
    : settled
      ? "The engine the server actually routed this job to."
      : auto.reason;

  /**
   * A reason the submit is already known to fail, computed from the same
   * capability data the server routes on. Today these arrive as a job that
   * uploads, queues, and then flips to `error` — `route()` raises for an
   * unavailable or mismatched engine — so the whole round trip is spent
   * learning something `/engines` already said.
   *
   * Never derived from a list we do not have: while the engines are loading or
   * unreachable, Auto still routes server-side, so the button stays live.
   * An explicitly chosen engine is checked before any file is staged, because
   * "why is this one greyed out" is the question the user has at that moment.
   */
  const blocker =
    load.state === "ready" && engines.length
      ? chosen
        ? /*
            A hand-picked checkpoint is checked BEFORE the engine itself.
            `available` on the engine is true when ANY of its checkpoints is
            usable (depth_image.py rolls them up that way), so an engine can be
            green while the specific model the user just chose is a 1.3 GB
            download away or non-commercial and disabled. Reporting the engine
            as fine and then failing the job on the model would be the exact
            round trip this whole blocker exists to avoid.
          */
          (pickedModel && !pickedModel.available
            ? pickedModel.unavailable_reason ||
              `${pickedModel.label} is not available on this server.`
            : explicitEngineBlocker(chosen, source))
        : engine
          ? `The server no longer lists an engine called "${engine}".`
          : files.length && !auto.engine
            ? auto.reason
            : null
      : null;

  const submit = async () => {
    if (!files.length) return;
    setBusy(true);
    setError(null);
    setJob(null);
    try {
      const created = await api.createJob({
        files,
        engine: engine || undefined,
        intent,
        // Only ever sent alongside an explicit engine — a checkpoint id is
        // meaningless without the engine that owns it, and `model` is cleared
        // whenever the engine changes, so this cannot carry a stale id.
        model: engine ? model || undefined : undefined,
      });
      const done = await waitForJob(created.job_id, setJob);
      if (done.status === "error") throw new Error(done.error || "Job failed");
      if (done.asset_id) onCreated(done.asset_id);
    } catch (e: any) {
      setError(e.message || "Failed");
    } finally {
      setBusy(false);
    }
  };

  const retry = useCallback(() => setReloadKey((k) => k + 1), []);

  return (
    <div className="p-4 space-y-2 text-sm sm:space-y-3">
      {/*
        `p-4` below `sm` rather than `p-6` everywhere. The panel's scroll area is
        capped at `max-h-[60vh]`, which on the 360x640 capture phone is 384px,
        and the Create button plus the running job's status line have to stay
        inside it — the moment they do not, the panel scrolls and the primary
        control is half under the fold. Sixteen pixels of dropzone padding is
        what pays for the engine summary underneath.
      */}
      <div
        {...getRootProps()}
        className={`border-2 border-dashed rounded-lg p-4 sm:p-6 text-center cursor-pointer transition ${
          isDragActive ? "border-primary-400 bg-primary-500/10" : "border-gray-600 hover:border-gray-400"
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

        The same 204px budget is why the option labels stay bare engine names.
        "photogrammetry (unavailable)" is 28 characters and clips at roughly 24,
        so the availability marker goes in FRONT of the name: truncation eats
        the tail, and the one glyph that must survive is the warning.

        Unavailable engines are selectable rather than `disabled`. A disabled
        option can be read but not reached, so the server's `unavailable_reason`
        — which is a real instruction, "install COLMAP + Brush" — had no way to
        reach the screen. Picking one now explains itself and blocks the submit.
      */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-gray-400">Engine</span>
          <select
            className="w-full min-w-0 bg-gray-800 rounded px-2 py-1"
            value={engine}
            aria-describedby="engine-detail"
            onChange={(e) => {
              setEngine(e.target.value);
              setModel("");
              restage();
            }}
          >
            <option value="">Auto (recommended)</option>
            {engines.map((e) => (
              <option key={e.name} value={e.name} title={e.available ? e.description : e.unavailable_reason ?? ""}>
                {e.available ? e.name : `⚠ ${e.name}`}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-gray-400">Intent</span>
          <select
            className="w-full min-w-0 bg-gray-800 rounded px-2 py-1"
            value={intent}
            aria-describedby="engine-detail"
            onChange={(e) => {
              setIntent(e.target.value as Intent);
              restage();
            }}
          >
            <option value="auto">Auto</option>
            <option value="object">Object (full 3D)</option>
            <option value="scene">Scene (portal)</option>
          </select>
          <span className="text-[11px] leading-snug text-gray-400">{describeIntent(intent)}</span>
        </label>
      </div>

      {/*
        The model picker, and only for an engine that actually has a choice to
        offer. The depth engines wrap a family of interchangeable checkpoints
        (`models` / `default_model` in models.py); preview, triposplat, sharp
        and photogrammetry are one model each and would get a select with a
        single option, which is a control that cannot be operated.

        It is deliberately a THIRD select rather than a flattened
        "engine:model" list in the Engine dropdown. The server accepts that
        shorthand, but collapsing six checkpoints into the engine list turns a
        6-row dropdown into a 16-row one where "depth-image" appears six times,
        and it destroys the thing the roster below is for — the licence and
        download size differ per checkpoint, not per engine.

        Rendered only when an engine is EXPLICITLY chosen. Under Auto the
        server picks the engine, so there is no model list to pick from yet,
        and offering one would imply a promise about which engine will run.

        This select never exists in the product-video frames: the storyboard
        leaves Engine on Auto, and its one explicit pick is `preview`
        (`pick('preview', 'preview')` in the create-engine-picked beat), which
        advertises no models. The two capture probes find a select by looking
        for an option value — `preview` for Engine, `object` for Intent — and
        no checkpoint id collides with either, so `capture.config.mjs` still
        lands on the Engine and Intent selects, not this one. Verified against
        the captured frame, not just read: create-engine-picked renders two
        selects.
      */}
      {modelChoices.length > 1 && (
        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-gray-400">Model</span>
          <select
            className="w-full min-w-0 bg-gray-800 rounded px-2 py-1"
            value={model}
            aria-describedby="engine-detail"
            onChange={(e) => {
              setModel(e.target.value);
              restage();
            }}
          >
            {/*
              "" is not a checkpoint — it means "whatever this engine calls its
              default", which is what the server does with an absent `model`
              field. Naming the default in the label keeps that from being a
              mystery option.
            */}
            <option value="">
              {defaultModelLabel ? `Default (${defaultModelLabel})` : "Default"}
            </option>
            {modelChoices.map((m) => (
              <option
                key={m.id}
                value={m.id}
                title={m.available ? m.description : m.unavailable_reason ?? ""}
              >
                {m.available ? m.label : `⚠ ${m.label}`}
                {m.approx_download_mb && !m.weights_cached ? ` — ${m.approx_download_mb} MB download` : ""}
              </option>
            ))}
          </select>
        </label>
      )}

      {/*
        Hidden while a job is in flight, and only then. The choice is made at
        that point, the status line takes its place, and the panel's height on
        the running frame stays where it was — see the `max-h-[60vh]` note on
        the dropzone. `busy`, not `job`: a finished job leaves `job` set, and
        the chooser has to come back for the next one.
      */}
      {!busy && (
        <EngineDetail
          load={load}
          engine={shown}
          staged={files.length > 0}
          tag={autoTag}
          reason={rationale}
          deadEnd={auto.reason}
          blocked={auto.blocked}
          alternative={
            auto.alternative
              ? `Intent ${intentLabel(auto.alternative.intent)} would route to ${auto.alternative.engine.name}.`
              : null
          }
          engines={engines}
          onRetry={retry}
        />
      )}

      {blocker && (
        <p className="text-[11px] leading-snug text-amber-300" role="alert">
          {blocker}
        </p>
      )}

      <button
        onClick={submit}
        disabled={busy || !files.length || !!blocker}
        className="w-full py-2 rounded bg-primary-600 text-white hover:bg-primary-700 disabled:bg-primary-900 disabled:text-primary-200 disabled:cursor-not-allowed"
      >
        {busy ? "Processing…" : "Create 3D"}
      </button>

      {job && <p className="text-gray-400">{jobStatusLine(job)}</p>}
      {error && <p className="text-red-400">Error: {error}</p>}
    </div>
  );
};

interface EngineDetailProps {
  load: EngineLoad;
  engine: EngineCapabilities | null;
  /** Whether a file is staged — decides whether "no engine" is a warning or just an empty form. */
  staged: boolean;
  tag: string | null;
  /** Why the engine on screen is on screen — see `rationale` in CreatePanel. */
  reason: string;
  /** Auto's answer when there is no engine at all; never attributed to an engine. */
  deadEnd: string;
  blocked: EngineCapabilities[];
  alternative: string | null;
  engines: EngineCapabilities[];
  onRetry: () => void;
}

/**
 * Everything the server already knows about the engine that is going to run.
 *
 * One `<details>` rather than a card plus a separate roster: the two together
 * cost 30px of chrome that the 384px mobile budget does not have. The
 * `<summary>` is the always-visible part and is deliberately bounded — two
 * lines on a phone, four on a wider panel — because every string in it comes
 * from the server and a 400-character description would otherwise push the
 * Create button off the bottom of the scroll area.
 *
 * The text ramp is gray-100 for the engine name, gray-300 for prose and
 * gray-400 for metadata, and it stops there. This block sits on gray-800/40
 * over the gray-900/90 panel, roughly #172030, where gray-500 measures 3.5:1 —
 * under the 4.5:1 that 11px text needs, and this is 11px text throughout.
 * gray-400 is 6.4:1 on the same surface, gray-300 is 10:1.
 */
const EngineDetail: React.FC<EngineDetailProps> = ({
  load,
  engine,
  staged,
  tag,
  reason,
  deadEnd,
  blocked,
  alternative,
  engines,
  onRetry,
}) => {
  const frame = "rounded border border-gray-700 bg-gray-800/40 px-2 py-1 text-[11px] leading-snug";

  if (load.state === "loading") {
    return (
      <p id="engine-detail" className={`${frame} text-gray-400`}>
        Loading engines…
      </p>
    );
  }

  if (load.state === "error") {
    return (
      <div id="engine-detail" className={`${frame} text-amber-200`} role="alert">
        <p className="line-clamp-3">Could not load the engine list — {load.message}</p>
        {/*
          Not a dead end: `POST /jobs` with no `engine` field still routes
          server-side, so the only thing actually lost here is the ability to
          pick. Saying so keeps the user from concluding the app is down.
        */}
        <p className="mt-1 text-gray-300">Auto still works — the server picks for itself.</p>
        <button
          onClick={onRetry}
          className="mt-1 rounded bg-gray-700 px-2 py-0.5 text-gray-200 hover:bg-gray-600"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!engines.length) {
    return (
      <p id="engine-detail" className={`${frame} text-amber-200`} role="alert">
        The server lists no engines. Creating will fail until one is configured.
      </p>
    );
  }

  return (
    <details id="engine-detail" className="rounded border border-gray-700 bg-gray-800/40">
      <summary className="cursor-pointer list-none px-2 py-1 [&::-webkit-details-marker]:hidden">
        {engine ? (
          <>
            <span className="flex items-baseline gap-1.5">
              <span className="truncate font-medium text-gray-100">{engine.name}</span>
              {tag && (
                <span className="shrink-0 rounded bg-primary-500/20 px-1 text-[10px] text-primary-200">
                  {tag}
                </span>
              )}
              {!engine.available && (
                <span className="shrink-0 rounded bg-amber-500/20 px-1 text-[10px] text-amber-200">
                  unavailable
                </span>
              )}
              <span className="ml-auto shrink-0 text-[10px] text-gray-400">details</span>
            </span>
            <span
              className="mt-0.5 block truncate text-[11px] text-gray-300"
              title={engineMetaLine(engine)}
            >
              {engineMetaLine(engine)}
            </span>
            {/*
              Description and rationale are collapsed away below `sm`, and only
              there. Measured in a browser at both capture sizes, with the file
              staged: 1280x720 leaves the panel 632px to sit in and it uses 394,
              while 360x640 leaves 552 and uses 523. The wide layout can afford
              to explain itself at a glance; the narrow one is 29px from pushing
              its own Create button under the fold. Neither loses the text —
              expanding shows it at both widths.
            */}
            {/*
              No `block` alongside `line-clamp-2`: the clamp works by setting
              `display: -webkit-box`, and Tailwind emits its display utilities
              after the line-clamp ones, so `block` would win the cascade and
              the clamp would silently stop clamping — which is exactly the case
              where a long server-written description overflows the panel.
              `-webkit-box` is block-level on its own.
            */}
            <span className="hidden sm:block">
              {engine.description && (
                <span className="mt-1 line-clamp-2 text-[11px] leading-snug text-gray-300">
                  {engine.description}
                </span>
              )}
              {reason && (
                <span className="mt-1 line-clamp-2 text-[11px] leading-snug text-gray-400">
                  {reason}
                </span>
              )}
            </span>
          </>
        ) : (
          /*
            One row, not three. With no file staged there is nothing to route
            and this is the least interesting the block will ever be — and it is
            also the state that has to share a 360x640 phone with the hero, and
            it holds the composition to 520 of the 552px available. `truncate` keeps it
            to that one row whatever the server-derived reason turns out to be;
            the same text appears in full in the alert above the button whenever
            it is a real dead end rather than an empty form.
          */
          <>
            <span className="flex items-baseline gap-1.5">
              <span className={`truncate text-[11px] ${staged ? "text-amber-200" : "text-gray-300"}`}>
                {deadEnd}
              </span>
              <span className="ml-auto shrink-0 text-[10px] text-gray-400">details</span>
            </span>
            {alternative && (
              <span className="mt-0.5 block text-[11px] leading-snug text-gray-400">
                {alternative}
              </span>
            )}
          </>
        )}
      </summary>

      <div className="border-t border-gray-700/70 px-2 py-1.5 text-[11px] leading-snug">
        {engine && (
          <div className="sm:hidden">
            {engine.description && <p className="text-gray-300">{engine.description}</p>}
            {reason && <p className="mt-1 text-gray-400">{reason}</p>}
          </div>
        )}
        {/*
          The roster below lists every engine, in the server's order. This list
          is only the ones that could have taken THIS input and cannot, which is
          the entire content of the question the user is stuck on — worth
          repeating above the roster rather than making them find it in it.
        */}
        {!engine && blocked.length > 0 && (
          <ul className="space-y-1">
            {blocked.map((e) => (
              <li key={e.name} className="text-amber-200">
                <span className="font-medium">{e.name}</span> — {e.unavailable_reason || "unavailable; the server did not say why."}
              </li>
            ))}
          </ul>
        )}

        <p className="mt-1 text-gray-400">
          {engines.length} engine{engines.length === 1 ? "" : "s"} on this server
        </p>
        <ul className="mt-1 space-y-1.5">
          {engines.map((e) => (
            <li
              key={e.name}
              className={
                engine && e.name === engine.name
                  ? "border-l-2 border-primary-500/60 pl-1.5"
                  : "border-l-2 border-transparent pl-1.5"
              }
            >
              <p>
                <span className="font-medium text-gray-200">{e.name}</span>
                {!e.available && <span className="ml-1 text-amber-300">· unavailable</span>}
              </p>
              {e.description && <p className="text-gray-300">{e.description}</p>}
              <p className="text-gray-400">{engineRosterLine(e)}</p>
              {/*
                The server's own words, not a paraphrase. `unavailable_reason` is
                written as an operator instruction ("Install COLMAP + Brush",
                "set SHARP_ENABLE_RESEARCH=1"), and a greyed-out option threw all
                of it away.
              */}
              {!e.available && (
                <p className="text-amber-200">
                  {e.unavailable_reason || "Unavailable; the server did not say why."}
                </p>
              )}
              {/*
                Checkpoints, when an engine has a family of them. Read-only: this
                panel sends no `model` field, so `default_model` is what runs, and
                the list exists to explain why the licence above says Apache-2.0
                on an engine whose other weights are CC-BY-NC — and to say which
                of them are a 1.3 GB download away from working.
              */}
              {e.models.length > 0 && (
                <ul className="mt-0.5 space-y-0.5 pl-2">
                  {e.models.map((m) => (
                    <li key={m.id} className={m.available ? "text-gray-400" : "text-amber-200/80"}>
                      <span className="text-gray-300">{m.label}</span> — {modelLine(e, m)}
                      {!m.available && m.unavailable_reason ? ` · ${m.unavailable_reason}` : ""}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
};

export default CreatePanel;
