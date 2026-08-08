import { EngineCapabilities, Intent, SourceType, normalizeEngine, normalizeEngines } from '../api';
import {
  activeModel,
  chooseAutoEngine,
  classifySource,
  describeIntent,
  describeSource,
  engineMetaLine,
  engineRosterLine,
  explicitEngineBlocker,
  modelLine,
} from './engineChoice';

/**
 * Fixtures go through `normalizeEngine` rather than being written as typed
 * literals, so every case here is asserted against a wire shape rather than
 * against a TypeScript interface the server has never seen. The four below are
 * copied from video/capture.config.mjs, which is itself copied from
 * server/app/engines/*.py — the same JSON the product video renders against.
 */
const wire = (raw: unknown): EngineCapabilities => {
  const engine = normalizeEngine(raw);
  if (!engine) throw new Error(`fixture did not normalize: ${JSON.stringify(raw)}`);
  return engine;
};

const preview = wire({
  name: 'preview',
  description: 'CPU-only instant preview: image -> flat textured Gaussian plane.',
  inputs: ['image'],
  intents: ['auto', 'scene'],
  output_kind: 'splat',
  output_formats: ['ply'],
  commercial: true,
  requires_gpu: false,
  license: 'MIT (this project)',
  available: true,
  unavailable_reason: null,
});

const triposplat = wire({
  name: 'triposplat',
  description: 'Single image -> object-centric 3D Gaussians (up to 262k), MIT-licensed.',
  inputs: ['image'],
  intents: ['auto', 'object'],
  output_kind: 'splat',
  output_formats: ['ply', 'splat'],
  commercial: true,
  requires_gpu: true,
  license: 'MIT (code + weights)',
  available: true,
  unavailable_reason: null,
});

const sharp = wire({
  name: 'sharp',
  description: 'Single image -> monocular scene Gaussians (great for the XR portal).',
  inputs: ['image'],
  intents: ['scene'],
  output_kind: 'splat',
  output_formats: ['ply'],
  commercial: false,
  requires_gpu: false,
  license: 'Apple ML Research Model License (non-commercial)',
  available: true,
  unavailable_reason: null,
});

const photogrammetry = wire({
  name: 'photogrammetry',
  description: 'Multiple images or a video -> reconstructed Gaussian scene.',
  inputs: ['images', 'video'],
  intents: ['auto', 'scene'],
  output_kind: 'splat',
  output_formats: ['ply'],
  commercial: true,
  requires_gpu: true,
  license: 'COLMAP BSD + Brush/gsplat Apache-2.0',
  available: true,
  unavailable_reason: null,
});

const ALL = [preview, triposplat, sharp, photogrammetry];
const off = (engine: EngineCapabilities, reason: string): EngineCapabilities => ({
  ...engine,
  available: false,
  unavailable_reason: reason,
});

const named = (files: string[]) => files.map((name) => ({ name }));
const oneImage = { type: 'image' as const, count: 1 };

describe('classifySource', () => {
  it('reproduces the server classifier', () => {
    // server/app/routes.py `_classify`: any video suffix wins, then count.
    expect(classifySource([])).toBeNull();
    expect(classifySource(named(['porch-1998.png']))).toEqual({ type: 'image', count: 1 });
    expect(classifySource(named(['a.png', 'b.jpg']))).toEqual({ type: 'images', count: 2 });
    expect(classifySource(named(['clip.mp4']))).toEqual({ type: 'video', count: 1 });
    expect(classifySource(named(['a.png', 'b.MOV', 'c.png']))).toEqual({
      type: 'video',
      count: 3,
    });
  });

  it('classifies on the filename only, exactly as the server does', () => {
    // The server never sees the browser's MIME guess — it re-derives the type
    // from the uploaded name — so a suffixless video is an "image" to both. The
    // panel has to predict the route the server WILL take, not the truth.
    const suffixless = [{ name: 'clip', type: 'video/mp4' }];
    expect(classifySource(suffixless)).toEqual({ type: 'image', count: 1 });
  });
});

describe('chooseAutoEngine', () => {
  it('routes a single image on intent Auto the way default_engine does', () => {
    // config.py `default_engine = "triposplat"`, and route() prefers it over the
    // preview fallback. The client cannot see that setting, so it gets there via
    // "a GPU engine reporting itself available was provisioned on purpose".
    const route = chooseAutoEngine(ALL, oneImage, 'auto');
    expect(route.engine?.name).toBe('triposplat');
    expect(route.confident).toBe(false);
    expect(route.reason).toMatch(/final say/);
  });

  it('prefers the intent specialist over the generalists', () => {
    // route() step 3 reaches for SHARP on intent=scene before anything else,
    // even though preview also lists "scene". SHARP earns that by listing
    // "scene" and NOTHING else — it opts out of general routing.
    expect(chooseAutoEngine(ALL, oneImage, 'scene').engine?.name).toBe('sharp');
    expect(chooseAutoEngine(ALL, oneImage, 'scene').reason).toMatch(/specialty/);

    // Intent=object has no such branch in route(): it goes straight to
    // `settings.default_engine`. triposplat is still the answer, but NOT
    // because it specialises — it lists "auto" too, so it is a generalist that
    // wins on being the provisioned GPU engine. Claiming "specialty" here
    // would be inventing a reason the server does not have.
    expect(chooseAutoEngine(ALL, oneImage, 'object').engine?.name).toBe('triposplat');
    expect(chooseAutoEngine(ALL, oneImage, 'object').reason).not.toMatch(/specialty/);
    expect(chooseAutoEngine(ALL, oneImage, 'object').reason).toMatch(/final say/);
  });

  it('sends multi-image and video input to the only engine that takes it', () => {
    for (const source of [
      { type: 'images' as const, count: 4 },
      { type: 'video' as const, count: 1 },
    ]) {
      const route = chooseAutoEngine(ALL, source, 'auto');
      expect(route.engine?.name).toBe('photogrammetry');
      expect(route.confident).toBe(true);
      expect(route.reason).toMatch(/only available engine/);
    }
  });

  it('falls back to the CPU engine when the GPU one is unavailable', () => {
    const engines = [preview, off(triposplat, 'triposplat CLI not found.'), sharp];
    const route = chooseAutoEngine(engines, oneImage, 'auto');
    expect(route.engine?.name).toBe('preview');
    expect(route.blocked.map((e) => e.name)).toEqual(['triposplat']);
  });

  it('reports the blockers rather than an empty answer when nothing can run', () => {
    const engines = [
      off(preview, 'preview is switched off in this deployment.'),
      off(triposplat, 'triposplat CLI not found.'),
    ];
    const route = chooseAutoEngine(engines, oneImage, 'auto');
    expect(route.engine).toBeNull();
    expect(route.reason).toBe('Nothing available takes 1 image on intent Auto.');
    expect(route.blocked.map((e) => e.unavailable_reason)).toEqual([
      'preview is switched off in this deployment.',
      'triposplat CLI not found.',
    ]);
  });

  it('names an intent that would work when the current one is a dead end', () => {
    // SHARP lists ["scene"] and nothing else, so it is invisible to Auto. On a
    // box where it is the only engine installed, Auto fails and Scene works —
    // which nothing in the dropdown says.
    const route = chooseAutoEngine([sharp], oneImage, 'auto');
    expect(route.engine).toBeNull();
    expect(route.reason).toBe('No engine lists intent Auto for 1 image.');
    expect(route.alternative).toEqual({ intent: 'scene', engine: sharp });
  });

  it('distinguishes "no engine for this input" from "no engine for this intent"', () => {
    expect(chooseAutoEngine([triposplat], { type: 'video', count: 1 }, 'auto').reason).toBe(
      'No engine takes a video.',
    );
  });

  it('has something to say before any file is staged, and with no engines at all', () => {
    expect(chooseAutoEngine(ALL, null, 'auto').reason).toMatch(/Add a file/);
    expect(chooseAutoEngine([], oneImage, 'auto').reason).toMatch(/no engines/);
  });

  it('ranks an engine the client has never heard of on its declared capabilities', () => {
    // The server grows engines without this bundle being rebuilt, so nothing may
    // key on names. A future depth estimator that names "object" has to beat the
    // incumbent generalist on intent=object purely from its own capability row.
    const depth = wire({
      name: 'depth-anything-v3',
      description: 'Monocular depth -> splat.',
      inputs: ['image'],
      intents: ['object'],
      output_kind: 'splat',
      output_formats: ['ply', 'spz'],
      commercial: true,
      requires_gpu: true,
      license: 'Apache-2.0',
      available: true,
      speed_class: 'fast', // a field this build has never seen
    });
    expect(chooseAutoEngine([...ALL, depth], oneImage, 'object').engine?.name).toBe(
      'depth-anything-v3',
    );
    expect(chooseAutoEngine([...ALL, depth], oneImage, 'scene').engine?.name).toBe('sharp');
  });
});

describe('explicitEngineBlocker', () => {
  it('quotes the server reason for an unavailable engine', () => {
    const reason = 'Photogrammetry needs colmap in the image.';
    expect(explicitEngineBlocker(off(photogrammetry, reason), oneImage)).toBe(reason);
  });

  it('catches the input mismatch route() would raise after the upload', () => {
    expect(explicitEngineBlocker(triposplat, { type: 'video', count: 1 })).toBe(
      'triposplat does not take a video — it accepts image.',
    );
  });

  it('passes an engine that can actually run the input', () => {
    expect(explicitEngineBlocker(triposplat, oneImage)).toBeNull();
    expect(explicitEngineBlocker(preview, null)).toBeNull();
  });
});

describe('engineMetaLine', () => {
  it('leads with the facts that survive truncation in a 296px column', () => {
    expect(engineMetaLine(preview)).toBe(
      'Runs on CPU · splat (ply) · MIT (this project) · Commercial OK',
    );
    // SHARP's own capabilities row says requires_gpu=False (CPU/MPS/CUDA; only
    // the video render needs CUDA), so the badge follows the server, not the
    // reputation of the model.
    expect(engineMetaLine(sharp)).toBe(
      'Runs on CPU · splat (ply) · Apple ML Research Model License (non-commercial) · Non-commercial',
    );
    expect(engineMetaLine(triposplat)).toMatch(/^Needs a GPU · splat \(ply, splat\)/);
  });
});

/**
 * The depth engines wrap a family of checkpoints instead of registering one
 * engine per weight, so their own `license` and `requires_gpu` are placeholders
 * that defer to `models[]`. Shape from server/app/engines/depth_image.py and
 * depth_models.py.
 */
const depthImage = wire({
  name: 'depth-image',
  description: 'Single image -> monocular depth -> back-projected Gaussian cloud.',
  inputs: ['image'],
  intents: ['auto', 'scene'],
  output_kind: 'splat',
  output_formats: ['ply'],
  commercial: true,
  requires_gpu: false,
  license: 'Per-model — see models[].license (Apache-2.0 for the defaults)',
  available: true,
  default_model: 'depth-anything-v2-small',
  models: [
    {
      id: 'depth-anything-v2-small',
      label: 'Depth Anything V2 — Small',
      description: '24M-parameter ViT-S.',
      license: 'Apache-2.0',
      commercial: true,
      requires_gpu: false,
      temporal: false,
      approx_download_mb: 100,
      weights_cached: true,
      available: true,
      unavailable_reason: null,
    },
    {
      id: 'depth-anything-v2-large',
      label: 'Depth Anything V2 — Large',
      description: '335M-parameter ViT-L.',
      license: 'CC-BY-NC-4.0 (weights)',
      commercial: false,
      requires_gpu: true,
      temporal: false,
      approx_download_mb: 1340,
      weights_cached: false,
      available: false,
      unavailable_reason: 'Non-commercial weights are disabled. Set DEPTH_ALLOW_NONCOMMERCIAL=1.',
    },
  ],
});

describe('multi-model engines', () => {
  it('quotes the checkpoint that will actually run, not the engine placeholder', () => {
    // This panel sends no `model` field, so `default_model` is what runs, and
    // printing "Per-model — see models[].license" where a licence belongs is
    // just a pointer to a list the user cannot see from the collapsed summary.
    expect(activeModel(depthImage)?.id).toBe('depth-anything-v2-small');
    expect(engineMetaLine(depthImage)).toBe(
      'Runs on CPU · splat (ply) · Apache-2.0 · Commercial OK',
    );
    expect(engineRosterLine(depthImage)).toMatch(/· 2 checkpoints$/);
  });

  it('falls back to the first checkpoint when default_model names nothing', () => {
    const stale = { ...depthImage, default_model: 'removed-in-a-later-release' };
    expect(activeModel(stale)?.id).toBe('depth-anything-v2-small');
    expect(activeModel(preview)).toBeNull();
    expect(engineRosterLine(preview)).not.toMatch(/checkpoint/);
  });

  it('says what each checkpoint costs and whether it is downloaded', () => {
    const [small, large] = depthImage.models;
    expect(modelLine(depthImage, small)).toBe('default · Apache-2.0 · CPU · 100 MB · downloaded');
    expect(modelLine(depthImage, large)).toBe(
      'CC-BY-NC-4.0 (weights) · GPU · 1340 MB · not downloaded yet',
    );
  });

  it('routes to a depth engine on capabilities alone, hedged', () => {
    // The point is that an engine name this build has never heard of
    // participates purely on its advertised capabilities, and that the copy
    // does not promise a route (settings.depth_auto_route is off the wire).
    //
    // Paired with preview rather than triposplat, deliberately. Neither is a
    // dedicated "scene" specialist and neither wants a GPU, so this is the full
    // tie the ranking documents — stable sort keeps the server's own order, and
    // depth-image is first. Against triposplat it would lose on the GPU
    // tiebreak, which is the rule that stands in for `default_engine`; that
    // would test the tiebreak, not the thing this test is about. Two eligible
    // engines also keeps the copy in its hedged form.
    const route = chooseAutoEngine([depthImage, preview], oneImage, 'scene');
    expect(route.engine?.name).toBe('depth-image');
    expect(route.confident).toBe(false);
    expect(route.reason).toMatch(/final say/);
  });
});

describe('normalizeEngines', () => {
  it('survives an engine row that omits everything optional', () => {
    // The crash this prevents: `inputs.includes(...)` on undefined, thrown during
    // render, which unmounts the whole Create tab rather than one label.
    const [only] = normalizeEngines({ engines: [{ name: 'mystery' }] });
    expect(only).toMatchObject({
      name: 'mystery',
      description: '',
      inputs: [],
      intents: [],
      output_kind: 'splat',
      output_formats: [],
      commercial: false,
      requires_gpu: false,
      license: '',
      available: true, // models.py defaults available=True
      unavailable_reason: null,
      models: [],
      default_model: null,
    });
    expect(() => chooseAutoEngine([only], oneImage, 'auto')).not.toThrow();
    expect(chooseAutoEngine([only], oneImage, 'auto').engine).toBeNull();
  });

  it('drops rows that cannot be an <option> and keeps fields it does not know', () => {
    const engines = normalizeEngines({
      engines: [
        null,
        'preview',
        { description: 'nameless' },
        { name: '   ' },
        { name: ' spaced ', inputs: 'image', intents: null, tuning: { steps: 30 } },
      ],
    });
    expect(engines.map((e) => e.name)).toEqual(['spaced']);
    expect(engines[0].inputs).toEqual([]); // a string is not a list of inputs
    expect((engines[0] as unknown as { tuning: unknown }).tuning).toEqual({ steps: 30 });
  });

  it('treats a malformed payload as an empty roster instead of throwing', () => {
    expect(normalizeEngines(null)).toEqual([]);
    expect(normalizeEngines({})).toEqual([]);
    expect(normalizeEngines({ engines: 'none' })).toEqual([]);
    expect(normalizeEngine(undefined)).toBeNull();
  });

  it('only greys out an engine that is explicitly unavailable', () => {
    expect(wire({ name: 'a' }).available).toBe(true);
    expect(wire({ name: 'a', available: false }).available).toBe(false);
    expect(wire({ name: 'a', unavailable_reason: '  ' }).unavailable_reason).toBeNull();
  });
});

/**
 * The stock posture: SHARP_ENABLE_RESEARCH=0, so `sharp` reports available:false
 * and `route()` step 3 falls through to `settings.default_engine`. Preview also
 * lists "scene", so a naive "names the intent" rule promotes it and the panel
 * claims an engine the server will not choose.
 */
describe('chooseAutoEngine matches route() when SHARP is unavailable', () => {
  const withoutSharp = ALL.map((e) =>
    e.name === 'sharp' ? { ...e, available: false, unavailable_reason: 'SHARP is disabled.' } : e,
  );

  it('falls through to the GPU-provisioned default on intent=scene, not to preview', () => {
    // registry.py: sharp unavailable -> default_engine (triposplat) -> preview.
    expect(chooseAutoEngine(withoutSharp, oneImage, 'scene').engine?.name).toBe('triposplat');
  });

  it('still lands on the default for auto and object', () => {
    expect(chooseAutoEngine(withoutSharp, oneImage, 'auto').engine?.name).toBe('triposplat');
    expect(chooseAutoEngine(withoutSharp, oneImage, 'object').engine?.name).toBe('triposplat');
  });

  it('only falls back to preview when the default is gone too', () => {
    const cpuOnly = withoutSharp.map((e) =>
      e.name === 'triposplat' ? { ...e, available: false, unavailable_reason: 'no CLI' } : e,
    );
    expect(chooseAutoEngine(cpuOnly, oneImage, 'scene').engine?.name).toBe('preview');
  });
});

const depthVideo = wire({
  name: 'depth-video',
  description: "Video -> temporally consistent depth -> Gaussian cloud of the clip's sharpest frame.",
  inputs: ['video'],
  intents: ['auto', 'scene'],
  output_kind: 'splat',
  output_formats: ['ply'],
  commercial: true,
  requires_gpu: false,
  license: 'Per-model — see models[].license (Apache-2.0 for the defaults)',
  available: true,
  default_model: 'video-depth-anything-small',
  models: [
    {
      id: 'video-depth-anything-small',
      label: 'Video Depth Anything — Small',
      license: 'Apache-2.0',
      commercial: true,
      requires_gpu: false,
      temporal: true,
      approx_download_mb: 110,
      weights_cached: false,
      available: true,
    },
  ],
});

/**
 * The whole registry, in `EngineRegistry.__init__` insertion order.
 *
 * The order is load-bearing, not cosmetic. `rank()` ends in a stable sort, so
 * every full tie — and preview vs depth-image on a CPU box is a full tie:
 * both list ["auto", "scene"], neither wants a GPU, neither is a dedicated
 * specialist — resolves to whichever the server listed first. `/engines`
 * serialises `self._engines.values()`, i.e. this order, so a fixture in any
 * other order would test a roster the server cannot produce and would hide the
 * one thing that makes the tie come out the way `route()` does.
 */
const REGISTRY_ORDER = [preview, triposplat, sharp, photogrammetry, depthImage, depthVideo];

interface ServerSettings {
  /** config.py `default_engine`. */
  defaultEngine: string;
  /** config.py `depth_auto_route`. */
  depthAutoRoute: boolean;
}

const STOCK: ServerSettings = { defaultEngine: 'triposplat', depthAutoRoute: false };

/**
 * A transliteration of `EngineRegistry._route()` for the no-explicit-engine
 * path, used as the oracle for the sweep below. Returns the engine name the
 * server would run, or null where it would raise `EngineError`.
 *
 * `can_handle` is modelled as `inputs.includes(type)` because that is what
 * every engine's implementation reduces to — each one is
 * `source_type == X and len(files) >= 1`, and SHARP's extra
 * `sharp_enable_research` gate is the same flag that drives its `available`.
 * The part that is NOT a restatement of the client, and the part this oracle
 * exists to pin, is the ORDER: photogrammetry by name for anything multi-frame,
 * SHARP by name on the scene branch, then `default_engine`, then the
 * depth-engine gate, then preview.
 */
const serverRoute = (
  roster: readonly EngineCapabilities[],
  source: { type: SourceType },
  intent: Intent,
  settings: ServerSettings,
): string | null => {
  const find = (name: string) => roster.find((e) => e.name === name);
  const usable = (name: string) => {
    const engine = find(name);
    return !!engine && engine.available && engine.inputs.includes(source.type);
  };
  const depthFallback = (name: string) => {
    if (!settings.depthAutoRoute && settings.defaultEngine !== name) return null;
    return usable(name) ? name : null;
  };

  if (source.type === 'images' || source.type === 'video') {
    if (usable('photogrammetry')) return 'photogrammetry';
    return depthFallback('depth-video');
  }
  if (intent === 'scene' && usable('sharp')) return 'sharp';
  if (usable(settings.defaultEngine)) return settings.defaultEngine;
  const depth = depthFallback('depth-image');
  if (depth) return depth;
  // registry.py checks preview's can_handle only — it is never unavailable.
  return find('preview')?.inputs.includes(source.type) ? 'preview' : null;
};

const SOURCES = [
  { type: 'image' as const, count: 1 },
  { type: 'images' as const, count: 4 },
  { type: 'video' as const, count: 1 },
];
const INTENTS: Intent[] = ['auto', 'object', 'scene'];

/** Every combination of which engines a given box has actually provisioned. */
const rosters = (): EngineCapabilities[][] => {
  // preview is registered unconditionally and `is_available` is the base-class
  // default, so it is present on every real deployment; the other five each
  // depend on a binary, a wheel or a feature flag.
  const optional = REGISTRY_ORDER.filter((e) => e.name !== 'preview');
  const out: EngineCapabilities[][] = [];
  for (let mask = 0; mask < 1 << optional.length; mask += 1) {
    out.push(
      REGISTRY_ORDER.map((engine) => {
        const slot = optional.indexOf(engine);
        if (slot < 0) return engine;
        return (mask & (1 << slot)) !== 0
          ? engine
          : { ...engine, available: false, unavailable_reason: `${engine.name} is not installed.` };
      }),
    );
  }
  return out;
};

/**
 * The panel's prediction, checked against the router itself over every
 * deployment shape the registry can produce — 32 availability combinations x 3
 * source types x 3 intents. A single case where the panel names one engine and
 * `route()` runs another is a lie told before an upload the user then waits on,
 * and it is not the kind of thing spot-checks find: the tiebreaks only diverge
 * on rosters nobody thinks to write a fixture for.
 */
describe('chooseAutoEngine against a transliteration of route()', () => {
  const sweep = () => {
    const rows: { key: string; client: string | null; server: string | null }[] = [];
    for (const roster of rosters()) {
      for (const source of SOURCES) {
        for (const intent of INTENTS) {
          const installed = roster
            .filter((e) => e.available)
            .map((e) => e.name)
            .join('+');
          rows.push({
            key: `${source.type}/${intent} on [${installed}]`,
            client: chooseAutoEngine(roster, source, intent).engine?.name ?? null,
            server: serverRoute(roster, source, intent, STOCK),
          });
        }
      }
    }
    return rows;
  };

  /**
   * The one class of disagreement the capability data cannot resolve.
   *
   * `DEPTH_AUTO_ROUTE` is off by default and is not published on `/engines`, so
   * a depth engine that reports itself available looks routable to the panel
   * while `route()` skips it. Reachable today: a box with the torch wheel but
   * without COLMAP answers a video upload with "depth-video", and the server
   * fails the job with photogrammetry's unavailable reason. There is no honest
   * client-side fix — the flag simply is not on the wire — so it is quarantined
   * here by shape rather than left to hide inside a green sweep.
   */
  const isDepthAutoRouteGap = (row: { client: string | null; server: string | null }) =>
    !!row.client?.startsWith('depth-') && row.server !== row.client;

  it('agrees with the router on every roster the registry can produce', () => {
    const mismatches = sweep().filter((r) => r.client !== r.server);
    const unexpected = mismatches
      .filter((r) => !isDepthAutoRouteGap(r))
      .map((r) => `${r.key}: panel says ${r.client}, server runs ${r.server}`);
    expect(unexpected).toEqual([]);
  });

  it('agrees on every roster with no depth engine installed at all', () => {
    // The same sweep with the unresolvable class removed from the inputs rather
    // than from the results, so this one has no escape hatch in it.
    const noDepth = REGISTRY_ORDER.filter((e) => !e.name.startsWith('depth-'));
    for (const source of SOURCES) {
      for (const intent of INTENTS) {
        for (let mask = 0; mask < 1 << (noDepth.length - 1); mask += 1) {
          const roster = noDepth.map((engine, i) =>
            i === 0 || (mask & (1 << (i - 1))) !== 0
              ? engine
              : { ...engine, available: false, unavailable_reason: 'not installed' },
          );
          expect({
            case: `${source.type}/${intent}/${mask}`,
            engine: chooseAutoEngine(roster, source, intent).engine?.name ?? null,
          }).toEqual({
            case: `${source.type}/${intent}/${mask}`,
            engine: serverRoute(roster, source, intent, STOCK),
          });
        }
      }
    }
  });

  it('KNOWN GAP: over-promises a depth engine on a box without COLMAP', () => {
    // Pinned so that fixing it — should `depth_auto_route` ever reach the wire —
    // fails here and this comment gets deleted along with the workaround.
    const roster = REGISTRY_ORDER.map((e) =>
      e.name === 'photogrammetry'
        ? { ...e, available: false, unavailable_reason: 'Photogrammetry needs colmap.' }
        : e,
    );
    const video = { type: 'video' as const, count: 1 };
    const route = chooseAutoEngine(roster, video, 'auto');

    expect(route.engine?.name).toBe('depth-video');
    expect(serverRoute(roster, video, 'auto', STOCK)).toBeNull();
    // With DEPTH_AUTO_ROUTE=1 the panel is right, which is the whole reason the
    // client cannot decide this from `/engines` alone.
    expect(serverRoute(roster, video, 'auto', { ...STOCK, depthAutoRoute: true })).toBe(
      'depth-video',
    );
  });

  it('still prefers photogrammetry for a video when both engines are installed', () => {
    // route() step 2 reaches for photogrammetry by name. The client has to get
    // there from capabilities alone, and it does it on the GPU tiebreak —
    // photogrammetry declares requires_gpu, depth-video does not.
    const route = chooseAutoEngine(REGISTRY_ORDER, { type: 'video', count: 1 }, 'auto');
    expect(route.engine?.name).toBe('photogrammetry');
    expect(route.confident).toBe(false);
    expect(route.reason).toMatch(/final say/);
  });
});

describe('copy that has to fit the panel', () => {
  it('describes a mixed drop as the video the server will treat it as', () => {
    // Drop four photos and one clip and the server runs the video branch on the
    // clip alone. "5 images" would be the panel describing a job that does not
    // exist.
    expect(describeSource({ type: 'video', count: 5 })).toBe('5 files (routed as video)');
    expect(chooseAutoEngine(ALL, { type: 'video', count: 5 }, 'auto').reason).toMatch(
      /5 files \(routed as video\)/,
    );
  });

  it('keeps every intent hint to one line of a 296px column', () => {
    // These sit under the Intent select, which is 296px wide at the narrowest
    // supported layout; past roughly 40 characters they wrap and push the
    // engine summary below the fold on a 360x640 phone.
    const hints = (['auto', 'object', 'scene'] as Intent[]).map(describeIntent);
    for (const hint of hints) {
      expect(hint.length).toBeGreaterThan(0);
      expect(hint.length).toBeLessThanOrEqual(40);
    }
    expect(new Set(hints).size).toBe(3);
  });

  it('never leaves a blank where a blocking reason belongs', () => {
    // `unavailable_reason` is Optional in models.py, so an engine can report
    // available=false and say nothing. Passing that through gives the user a
    // greyed-out engine with no explanation and no next step.
    const silent = { ...triposplat, available: false, unavailable_reason: null };
    expect(explicitEngineBlocker(silent, oneImage)).toBe('triposplat reports itself unavailable.');
  });

  it('says something usable about an engine whose capability row is empty', () => {
    // The half-shipped row from normalizeEngines: it survives render, so the
    // strings it produces have to be readable rather than "it accepts ." and
    // "intent .".
    const mystery = wire({ name: 'mystery' });
    expect(explicitEngineBlocker(mystery, oneImage)).toBe(
      'mystery does not take 1 image — it accepts nothing this build recognises.',
    );
    expect(engineRosterLine(mystery)).toBe(
      'Takes no input this build recognises · intent no intent · Runs on CPU · splat · Non-commercial',
    );
  });

  it('flags a temporally consistent checkpoint, which is the reason to pick one', () => {
    // The only property that distinguishes the video depth checkpoints from
    // each other for a user: without it the roster lists two identical lines.
    const [temporal] = depthVideo.models;
    expect(modelLine(depthVideo, temporal)).toBe(
      'default · Apache-2.0 · CPU · temporally consistent · 110 MB · not downloaded yet',
    );
  });

  it('classifies a file the browser could not name', () => {
    // react-dropzone hands through whatever the drop event carried; a
    // File with an empty name must not throw on `.toLowerCase()`.
    expect(classifySource([{ name: '' }])).toEqual({ type: 'image', count: 1 });
    expect(classifySource([{} as { name: string }])).toEqual({ type: 'image', count: 1 });
  });
});
