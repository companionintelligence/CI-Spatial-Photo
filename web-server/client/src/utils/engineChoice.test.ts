import { EngineCapabilities, normalizeEngine, normalizeEngines } from '../api';
import {
  activeModel,
  chooseAutoEngine,
  classifySource,
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
