import {
  getApiBase,
  Asset,
  Job,
  api,
  bestFormat,
  fetchAssetAsFile,
  normalizeEngine,
  normalizeEngines,
  viewerSplatFormat,
  waitForJob,
} from './api';

/**
 * Everything here drives the real `api` object through a faked `global.fetch`
 * rather than mocking `api` itself, for the same reason CreatePanel.test.tsx
 * does: the interesting behaviour lives in the seam between the wire and the
 * caller — normalization, auth headers, multipart assembly, the polling loop —
 * and a mocked `api` is precisely the layer that deletes all of it.
 */

interface Recorded {
  url: string;
  init: RequestInit;
}

let calls: Recorded[];
let respond: (url: string, init: RequestInit) => Partial<Response>;

const ok = (body: unknown): Partial<Response> => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  json: () => Promise.resolve(body),
  text: () => Promise.resolve(JSON.stringify(body)),
});

const failure = (status: number, statusText: string, body = ''): Partial<Response> => ({
  ok: false,
  status,
  statusText,
  text: () => Promise.resolve(body),
  json: () => Promise.reject(new SyntaxError('not json')),
});

beforeEach(() => {
  calls = [];
  respond = () => ok({});
  localStorage.clear();
  global.fetch = jest.fn((url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: (init || {}) as RequestInit });
    return Promise.resolve(respond(String(url), (init || {}) as RequestInit) as Response);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  jest.restoreAllMocks();
  localStorage.clear();
});

const headersOf = (call: Recorded): Record<string, string> =>
  (call.init.headers || {}) as Record<string, string>;

const asset = (over: Partial<Asset> = {}): Asset => ({
  asset_id: 'a1',
  owner: 'liam',
  kind: 'splat',
  engine: 'triposplat',
  source_type: 'image',
  source_origin: 'upload',
  source_filenames: ['porch-1998.png'],
  temporal: false,
  formats: { ply: 'master.ply' },
  thumbnail: 'thumb.webp',
  share_url: 'https://example.test/v/a1',
  created_at: '2026-06-15T14:58:12Z',
  tags: [],
  ...over,
});

describe('authentication headers', () => {
  it('omits Authorization entirely when there is no token', async () => {
    // `Bearer null` is a header an anonymous single-user deployment would
    // reject, and the token is absent on every first visit. The absence has to
    // be an absent header, not a header containing the word "null".
    respond = () => ok({ assets: [] });
    await api.listAssets();
    expect(headersOf(calls[0])).toEqual({});
    expect(JSON.stringify(headersOf(calls[0]))).not.toMatch(/null|undefined/);
  });

  it('sends the stored token on every authenticated call, including downloads', async () => {
    localStorage.setItem('ci_token', 'tok-123');
    respond = (url) =>
      url.includes('/file')
        ? ({ ok: true, blob: () => Promise.resolve(new Blob(['xyz'])) } as Partial<Response>)
        : ok({ assets: [] });

    await api.listAssets();
    await fetchAssetAsFile(asset({ formats: { ply: 'm.ply' } }), 'ply');

    // fetchAssetAsFile builds its own request instead of going through `api`,
    // so it is the one that silently loses the header when authHeaders moves.
    expect(calls.map((c) => headersOf(c).Authorization)).toEqual([
      'Bearer tok-123',
      'Bearer tok-123',
    ]);
  });
});

describe('createJob multipart assembly', () => {
  const fields = (call: Recorded) => {
    const fd = call.init.body as FormData;
    const out: Record<string, string[]> = {};
    fd.forEach((value, key) => {
      out[key] = out[key] || [];
      out[key].push(value instanceof File ? value.name : String(value));
    });
    return out;
  };

  it('never sets Content-Type, so the browser can supply the multipart boundary', async () => {
    // Setting "multipart/form-data" by hand omits the boundary parameter and
    // FastAPI answers 422 for every upload. The only header this request may
    // carry is Authorization.
    localStorage.setItem('ci_token', 'tok');
    respond = () => ok({ job_id: 'j1', status: 'queued' });
    await api.createJob({ files: [new File(['x'], 'a.png')] });

    expect(Object.keys(headersOf(calls[0]))).toEqual(['Authorization']);
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.body).toBeInstanceOf(FormData);
  });

  it('sends every staged file under the field name the server reads', async () => {
    respond = () => ok({ job_id: 'j1', status: 'queued' });
    await api.createJob({
      files: [new File(['x'], 'a.png'), new File(['y'], 'b.png')],
      engine: 'preview',
      intent: 'scene',
      model: 'depth-anything-v2-small',
      memoryRefs: ['mem:1', 'mem:2'],
    });
    expect(fields(calls[0])).toEqual({
      files: ['a.png', 'b.png'],
      engine: ['preview'],
      intent: ['scene'],
      model: ['depth-anything-v2-small'],
      memory_refs: ['["mem:1","mem:2"]'],
    });
  });

  it('omits an empty model rather than asking for a checkpoint named ""', async () => {
    // The server reads an absent `model` as "use this engine's default_model"
    // and an empty one as a request for a checkpoint that does not exist — a
    // 4xx on a job that would otherwise have run the default. Same for an empty
    // memory_refs list, which would make an upload look like a memory job.
    respond = () => ok({ job_id: 'j1', status: 'queued' });
    await api.createJob({ files: [new File(['x'], 'a.png')], model: '', engine: '', memoryRefs: [] });
    expect(fields(calls[0])).toEqual({ files: ['a.png'] });
  });
});

describe('error surfacing', () => {
  it('rejects with the server body, which is what the Create panel prints', async () => {
    respond = () => failure(400, 'Bad Request', "Engine 'sharp' is unavailable.");
    await expect(api.createJob({ files: [] })).rejects.toThrow("Engine 'sharp' is unavailable.");
  });

  it('falls back to the status text when the body is empty', async () => {
    // A 502 from a reverse proxy has no body. Throwing `new Error("")` gives
    // Gallery "Could not load your memories." with nothing after it.
    respond = () => failure(502, 'Bad Gateway');
    await expect(api.listAssets()).rejects.toThrow('Bad Gateway');
  });
});

/**
 * The seam these guard is `api.listEngines` itself, not `normalizeEngines`.
 * engineChoice.test.ts calls the normalizer directly, so it would still pass in
 * full if `listEngines` were simplified to `.then(r => r.json())` — and every
 * "the panel cannot be blanked by a bad engine row" guarantee would be gone
 * with no test failing.
 */
describe('listEngines normalizes at the boundary', () => {
  it('repairs partial rows and drops unusable ones without throwing', async () => {
    respond = () =>
      ok({
        engines: [
          { name: 'preview', inputs: ['image'], intents: ['auto'] },
          { name: 'half-shipped' }, // no inputs, no intents, no output_formats
          { description: 'no name at all' },
          42,
        ],
      });

    const { engines } = await api.listEngines();
    expect(engines.map((e) => e.name)).toEqual(['preview', 'half-shipped']);
    // The arithmetic the panel does on every render, on the row that arrived
    // with nothing: an absent array here is a TypeError thrown during render,
    // which unmounts the whole Create tab.
    expect(() =>
      engines.map((e) => `${e.inputs.includes('image')}${e.output_formats.join(',')}`),
    ).not.toThrow();
  });

  it('yields an empty roster, not a rejection, for a payload of the wrong shape', async () => {
    // A reverse proxy that answers 200 with its own JSON is the realistic case.
    respond = () => ok({ detail: 'Not Found' });
    await expect(api.listEngines()).resolves.toEqual({ engines: [] });
  });
});

describe('normalizeEngine checkpoint rows', () => {
  it('defaults a checkpoint the way models.py does and keeps fields it cannot name', () => {
    const engine = normalizeEngine({
      name: 'depth-image',
      models: [{ id: 'depth-anything-v2-small', quantization: 'fp16' }],
    })!;
    expect(engine.models).toHaveLength(1);
    expect(engine.models[0]).toMatchObject({
      id: 'depth-anything-v2-small',
      // No label on the wire: the id is a worse label than a real one but an
      // infinitely better one than "undefined" in a dropdown.
      label: 'depth-anything-v2-small',
      license: '',
      commercial: false,
      requires_gpu: false,
      temporal: false,
      approx_download_mb: null,
      weights_cached: false,
      available: true, // models.py defaults available=True
      unavailable_reason: null,
    });
    expect((engine.models[0] as unknown as { quantization: string }).quantization).toBe('fp16');
  });

  it('drops checkpoint rows that cannot be selected and refuses a non-numeric size', () => {
    // `approx_download_mb` is printed as "{n} MB". A string "1340" would render
    // as "1340 MB" by luck; an object would render "[object Object] MB".
    const engine = normalizeEngine({
      name: 'depth-image',
      models: [null, 'small', { label: 'no id' }, { id: '  ' }, { id: 'ok', approx_download_mb: '1340' }],
    })!;
    expect(engine.models.map((m) => m.id)).toEqual(['ok']);
    expect(engine.models[0].approx_download_mb).toBeNull();
  });

  it('treats a non-array models field as no checkpoints at all', () => {
    expect(normalizeEngine({ name: 'x', models: { a: 1 } })!.models).toEqual([]);
    expect(normalizeEngine({ name: 'x', default_model: 7 })!.default_model).toBeNull();
  });

  it('keeps an unknown output_kind out of the mesh branch', () => {
    // App.tsx switches viewers on output_kind. Only "mesh" may select the
    // model-viewer path; anything this build does not recognise has to fall to
    // the splat viewer, which is the only one every engine actually feeds.
    expect(normalizeEngine({ name: 'x', output_kind: 'pointcloud' })!.output_kind).toBe('splat');
    expect(normalizeEngine({ name: 'x', output_kind: 'mesh' })!.output_kind).toBe('mesh');
  });

  it('does not accept a scalar or an array as the engines list', () => {
    expect(normalizeEngines({ engines: 42 })).toEqual([]);
    expect(normalizeEngines([{ name: 'preview' }])).toEqual([]);
  });
});

describe('format preference', () => {
  it('downloads the smallest wire format a splat asset offers', () => {
    // spz is roughly an order of magnitude smaller than the ply for the same
    // splat. Reordering this list is invisible in the UI and expensive on the
    // wire, so the order is the assertion.
    const all = asset({ formats: { ply: 'a', splat: 'b', sog: 'c', spz: 'd' } });
    expect(bestFormat(all).format).toBe('spz');
    expect(bestFormat(all).url).toBe(`${getApiBase()}/api/v1/assets/a1/file?format=spz`);
    expect(bestFormat(asset({ formats: { ply: 'a', splat: 'b' } })).format).toBe('ply');
  });

  it('prefers glb for a mesh and still answers for a format it has never heard of', () => {
    expect(bestFormat(asset({ kind: 'mesh', formats: { gltf: 'a', glb: 'b' } })).format).toBe('glb');
    expect(bestFormat(asset({ kind: 'mesh', formats: { usdz: 'a' } })).format).toBe('usdz');
  });

  it('hands the viewer only a format its own parser registry can read', () => {
    // src/formats registers ply, sog and spz — not `.splat`. Preferring spz
    // here and falling back through sog to ply keeps the viewer inside that
    // set for every asset any engine currently produces.
    expect(viewerSplatFormat(asset({ formats: { ply: 'a', splat: 'b', spz: 'c' } }))).toBe('spz');
    expect(viewerSplatFormat(asset({ formats: { ply: 'a', splat: 'b' } }))).toBe('ply');
    expect(viewerSplatFormat(asset({ formats: { sog: 'a', ply: 'b' } }))).toBe('sog');
  });
});

describe('fetchAssetAsFile', () => {
  it('names the file by format so extension-based parser lookup still works', async () => {
    // The download URL carries the format in a query string, and
    // getFormatHandler() keys on the filename extension. A File called
    // "file?format=spz" resolves to no handler and the viewer shows nothing.
    respond = () => ({ ok: true, blob: () => Promise.resolve(new Blob(['0123'])) });
    const file = await fetchAssetAsFile(asset(), 'spz');
    expect(file.name).toBe('model.spz');
    expect(file.size).toBe(4);
    expect(calls[0].url).toBe(`${getApiBase()}/api/v1/assets/a1/file?format=spz`);
  });

  it('rejects with the server text rather than handing back an empty File', async () => {
    // A truncated/absent artifact must not reach the viewer as a zero-byte
    // model that fails deep inside the parser with no attributable message.
    respond = () => failure(404, 'Not Found', 'No such format for this asset.');
    await expect(fetchAssetAsFile(asset(), 'spz')).rejects.toThrow('No such format for this asset.');
  });
});

describe('waitForJob', () => {
  const job = (over: Partial<Job>): Job => ({
    job_id: 'j1',
    owner: 'liam',
    status: 'running',
    message: '',
    ...over,
  });

  it('reports every intermediate poll and stops on the terminal one', async () => {
    const states: Job[] = [
      job({ status: 'queued' }),
      job({ status: 'running', message: 'reconstructing with preview' }),
      job({ status: 'done', message: 'done', asset_id: 'a1' }),
    ];
    let i = 0;
    respond = () => ok(states[Math.min(i++, states.length - 1)]);

    const seen: string[] = [];
    const final = await waitForJob('j1', (j) => seen.push(j.status), 0);

    // The terminal state has to be delivered to onUpdate as well as returned:
    // MemoryPicker renders its progress line from onUpdate alone, so a loop
    // that returned early would leave "Status: running" on screen forever.
    expect(seen).toEqual(['queued', 'running', 'done']);
    expect(final.asset_id).toBe('a1');
    expect(calls).toHaveLength(3);
  });

  it('stops on error, so a failed job is not polled for twenty minutes', async () => {
    respond = () => ok(job({ status: 'error', message: 'failed', error: 'colmap missing' }));
    const final = await waitForJob('j1', undefined, 0);
    expect(final.status).toBe('error');
    expect(calls).toHaveLength(1);
  });

  it('gives up instead of polling forever when the job never terminates', async () => {
    // A worker that dies mid-job leaves the row at "running" for good. Without
    // the deadline this loop is an unbounded request every 1.5s for the life of
    // the tab.
    let clock = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => (clock += 60_000));
    respond = () => ok(job({ status: 'running' }));

    const seen: Job[] = [];
    await expect(waitForJob('j1', (j) => seen.push(j), 0, 30_000)).rejects.toThrow(/Timed out/);
    // The caller still saw the last known state before the throw.
    expect(seen).toHaveLength(1);
  });
});
