import React from 'react';
// Imported here rather than from a `src/setupTests.ts`: CRA loads that file into
// every suite in the project, and this worktree has other people's tests in it.
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import CreatePanel from './CreatePanel';
import { api } from '../api';

/**
 * Half of this file is a regression test for the PRODUCT VIDEO, not for the UI.
 *
 * video/storyboard.json drives Playwright captures against the real app, and it
 * addresses this panel by DOM shape: `select:has(option[value="preview"])`,
 * `button:has-text("Create 3D")`, `text=Drop an image`, `text=file(s) selected`.
 * The engine-picked beat goes further and drives the controls the way no user
 * ever does — `sel.value = 'preview'; sel.dispatchEvent(new Event('change'))` —
 * which only works because both controls are native `<select>` elements. Swap
 * either for a listbox, or rename the Create button, and the failure surfaces as
 * a broken video build long after the change, in a different repo. Asserting it
 * here means it surfaces in this one.
 */
const WIRE_ENGINES = [
  {
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
  },
  {
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
  },
  {
    name: 'photogrammetry',
    description: 'Multiple images or a video -> reconstructed Gaussian scene.',
    inputs: ['images', 'video'],
    intents: ['auto', 'scene'],
    output_kind: 'splat',
    output_formats: ['ply'],
    commercial: true,
    requires_gpu: true,
    license: 'COLMAP BSD + Brush/gsplat Apache-2.0',
    available: false,
    unavailable_reason:
      'Photogrammetry needs colmap, brush/gsplat in the image. Install COLMAP + Brush.',
  },
];

/** `api.listEngines` normalizes, so the mock has to answer at the fetch layer. */
const respondWith = (body: unknown, ok = true) => {
  (global.fetch as jest.Mock).mockImplementation(() =>
    Promise.resolve({
      ok,
      statusText: 'Server Error',
      text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
      json: () => Promise.resolve(body),
    } as unknown as Response),
  );
};

const selects = () => Array.from(document.querySelectorAll('select'));
/** The storyboard's own probe: find the select that carries a given option value. */
const selectCarrying = (value: string) =>
  selects().find((s) => Array.from(s.options).some((o) => o.value === value));

beforeEach(() => {
  global.fetch = jest.fn() as unknown as typeof fetch;
  respondWith({ engines: WIRE_ENGINES });
});

afterEach(() => jest.restoreAllMocks());

let container: HTMLElement;

const renderPanel = async () => {
  container = render(<CreatePanel onCreated={jest.fn()} />).container;
  await screen.findByRole('option', { name: 'preview' });
};

/** Drive react-dropzone's hidden input the way capture.config.mjs does. */
const stage = async (name: string) => {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(['x'], name, { type: 'image/png' })] } });
  await screen.findByText(new RegExp(`file\\(s\\) selected`));
};

/** The always-visible part of the chooser: what the panel asserts without a click. */
const summaryText = () => (container.querySelector('summary')?.textContent || '').trim();

const pick = (probe: string, value: string) =>
  act(() => {
    const sel = selectCarrying(probe)!;
    sel.value = value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });

describe('CreatePanel capture contract', () => {
  it('keeps every selector video/storyboard.json addresses', async () => {
    await renderPanel();

    // text=Drop an image / text=file(s) selected
    expect(screen.getByText(/Drop an image/)).toBeInTheDocument();

    // button:has-text("Create 3D") — one match, so Playwright's strict mode holds.
    const buttons = Array.from(document.querySelectorAll('button')).filter((b) =>
      (b.textContent || '').includes('Create 3D'),
    );
    expect(buttons).toHaveLength(1);

    // select:has(option[value="preview"]) and the Auto sentinels.
    const engine = selectCarrying('preview');
    const intent = selectCarrying('object');
    expect(engine).toBeInstanceOf(HTMLSelectElement);
    expect(intent).toBeInstanceOf(HTMLSelectElement);
    expect(engine).not.toBe(intent);
    expect(engine!.value).toBe('');
    expect(intent!.value).toBe('auto');
    expect(Array.from(engine!.options).map((o) => o.value)).toEqual([
      '',
      'preview',
      'triposplat',
      'photogrammetry',
    ]);
    expect(Array.from(intent!.options).map((o) => o.value)).toEqual(['auto', 'object', 'scene']);
  });

  it('responds to a programmatic value set plus a change event', async () => {
    await renderPanel();
    const engine = selectCarrying('preview')!;
    const intent = selectCarrying('object')!;

    // Exactly what capture.config.mjs does, verbatim.
    act(() => {
      engine.value = 'preview';
      engine.dispatchEvent(new Event('change', { bubbles: true }));
      intent.value = 'scene';
      intent.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // React state took the values, so `option[value="preview"]:checked` matches.
    expect(engine.value).toBe('preview');
    expect(intent.value).toBe('scene');
    expect(engine.selectedOptions[0].selected).toBe(true);
    expect(screen.getByText('A room-scale portal you look into.')).toBeInTheDocument();
  });
});

describe('CreatePanel engine chooser', () => {
  it('names the engine Auto would route to, with its licence and hardware', async () => {
    await renderPanel();
    // Nothing is staged yet, so there is nothing to route and the panel says so
    // instead of naming a winner it cannot know.
    expect(screen.getByText('Add a file to see the engine Auto picks.')).toBeInTheDocument();
  });

  it('shows the description, licence and GPU need of the engine you pick', async () => {
    await renderPanel();
    pick('preview', 'triposplat');

    expect(screen.getAllByText(/object-centric 3D Gaussians/).length).toBeGreaterThan(0);
    expect(
      screen.getAllByText(/Needs a GPU · splat \(ply, splat\) · MIT \(code \+ weights\)/).length,
    ).toBeGreaterThan(0);
  });

  it('names the engine Auto routes a staged image to, and why', async () => {
    await renderPanel();
    await stage('porch-1998.png');

    // config.py's default_engine, reached from the capability data alone.
    expect(summaryText()).toContain('triposplat');
    expect(summaryText()).toContain("Auto's pick");
    expect(summaryText()).toContain('The most capable of 2 engines that take 1 image');
  });

  it('never attributes Auto\'s rationale to an engine the user picked instead', async () => {
    await renderPanel();
    await stage('porch-1998.png');
    // With SHARP absent from this fixture, route()'s scene branch falls through
    // to `default_engine`, so Auto's candidate is triposplat — the GPU engine
    // the operator provisioned, not preview, which merely lists "scene".
    pick('object', 'scene');
    pick('preview', 'preview'); // ...and the user overrides it with the CPU one

    expect(summaryText()).toContain('preview');
    expect(summaryText()).toContain('Your pick. Auto would route to triposplat.');
    // The old shape printed `auto.reason` — preview's rationale — under triposplat.
    expect(summaryText()).not.toContain('specialty');
    expect(summaryText()).not.toContain("Auto's pick");
  });

  it('shows the unavailable engine and the server reason instead of hiding both', async () => {
    await renderPanel();

    // Not disabled: an option that cannot be reached cannot explain itself, and
    // `unavailable_reason` is written as an instruction the operator can act on.
    const option = screen.getByRole('option', { name: /photogrammetry/ }) as HTMLOptionElement;
    expect(option.disabled).toBe(false);
    expect(option.value).toBe('photogrammetry');

    act(() => {
      const engine = selectCarrying('preview')!;
      engine.value = 'photogrammetry';
      engine.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // Picking it surfaces the server's own words next to a Create button that
    // is now honestly disabled, rather than uploading and failing a minute later.
    expect(screen.getByRole('alert').textContent).toContain('Install COLMAP + Brush');
    expect(screen.getByRole('button', { name: 'Create 3D' })).toBeDisabled();
  });

  it('explains a failed engine list instead of showing an empty dropdown', async () => {
    respondWith('engines unavailable: worker crashed', false);
    render(<CreatePanel onCreated={jest.fn()} />);

    await screen.findByText(/Could not load the engine list/);
    expect(screen.getByText(/worker crashed/)).toBeInTheDocument();
    // Auto is still a working path server-side, so the button must stay.
    expect(screen.getByRole('button', { name: 'Create 3D' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();

    respondWith({ engines: WIRE_ENGINES });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByRole('option', { name: 'preview' });
  });

  it('says so when the server has no engines at all', async () => {
    respondWith({ engines: [] });
    render(<CreatePanel onCreated={jest.fn()} />);
    await screen.findByText(/lists no engines/);
  });

  it('does not crash on an engine row missing every optional field', async () => {
    respondWith({ engines: [{ name: 'mystery' }, ...WIRE_ENGINES] });
    render(<CreatePanel onCreated={jest.fn()} />);
    await waitFor(() => expect(screen.getByRole('option', { name: 'mystery' })).toBeDefined());
    expect(screen.getByRole('button', { name: 'Create 3D' })).toBeInTheDocument();
  });
});

/**
 * The model picker. A multi-model engine advertises `models` / `default_model`
 * (depth_image.py), and until the panel sends the `model` form field back, the
 * roster is decorative — `default_model` runs no matter which checkpoint the
 * user reads about.
 */
const DEPTH_IMAGE = {
  name: 'depth-image',
  description: 'One photo -> monocular depth -> back-projected Gaussians.',
  inputs: ['image'],
  intents: ['auto', 'scene'],
  output_kind: 'splat',
  output_formats: ['ply'],
  commercial: true,
  requires_gpu: false,
  license: 'Per-model — see models[].license',
  available: true,
  unavailable_reason: null,
  default_model: 'depth-anything-v2-small',
  models: [
    {
      id: 'depth-anything-v2-small',
      label: 'Depth Anything V2 Small',
      description: 'Fastest, CPU-viable.',
      license: 'Apache-2.0',
      commercial: true,
      requires_gpu: false,
      temporal: false,
      approx_download_mb: 99,
      weights_cached: true,
      available: true,
      unavailable_reason: null,
    },
    {
      id: 'depth-anything-v2-large',
      label: 'Depth Anything V2 Large',
      description: 'Best quality.',
      license: 'CC-BY-NC-4.0',
      commercial: false,
      requires_gpu: true,
      temporal: false,
      approx_download_mb: 1340,
      weights_cached: false,
      available: false,
      unavailable_reason: 'Non-commercial weights are disabled. Set DEPTH_ALLOW_NONCOMMERCIAL=1.',
    },
  ],
};

/** The Model select is the one carrying a checkpoint id, never `preview`/`object`. */
const modelSelect = () => selectCarrying('depth-anything-v2-small');

/**
 * A URL-aware fetch mock. The flat `respondWith` above answers every request
 * with one body, which is fine until a test submits: `waitForJob` then polls
 * `GET /jobs/:id`, gets the engine list back, never sees a terminal status, and
 * the panel sits on "Processing…" forever — which reads as a missing Create
 * button rather than as a stuck poll.
 */
const respondByRoute = (engines: unknown[]) => {
  (global.fetch as jest.Mock).mockImplementation((url: string) => {
    const body = String(url).includes('/engines')
      ? { engines }
      : { job_id: 'j1', status: 'done', asset_id: 'a1', engine: 'depth-image' };
    return Promise.resolve({
      ok: true,
      statusText: 'OK',
      text: () => Promise.resolve(JSON.stringify(body)),
      json: () => Promise.resolve(body),
    } as unknown as Response);
  });
};

describe('CreatePanel model picker', () => {
  it('offers no model control under Auto or for a single-model engine', async () => {
    await renderPanel();
    // Auto: the engine is not settled, so there is no roster to choose from.
    expect(modelSelect()).toBeUndefined();
    expect(selects()).toHaveLength(2);

    // preview has one implementation; a select with one option is not a control.
    pick('preview', 'preview');
    expect(modelSelect()).toBeUndefined();
    expect(selects()).toHaveLength(2);
  });

  it('offers the checkpoints once a multi-model engine is picked', async () => {
    respondWith({ engines: [...WIRE_ENGINES, DEPTH_IMAGE] });
    await renderPanel();
    pick('preview', 'depth-image');

    const models = modelSelect();
    expect(models).toBeInstanceOf(HTMLSelectElement);
    // "" is the default sentinel, and it names the default so it is not a mystery.
    expect(Array.from(models!.options).map((o) => o.value)).toEqual([
      '',
      'depth-anything-v2-small',
      'depth-anything-v2-large',
    ]);
    expect(models!.options[0].textContent).toMatch(/Depth Anything V2 Small/);
    // An uncached checkpoint says what it will cost before it is chosen.
    expect(models!.options[2].textContent).toMatch(/1340 MB download/);
  });

  it('omits the model field while the default checkpoint is selected', async () => {
    respondByRoute([...WIRE_ENGINES, DEPTH_IMAGE]);
    await renderPanel();
    pick('preview', 'depth-image');
    await stage('porch.png');

    const createJob = jest.spyOn(api, 'createJob');
    fireEvent.click(screen.getByRole('button', { name: 'Create 3D' }));
    await waitFor(() => expect(createJob).toHaveBeenCalled());

    expect(createJob.mock.calls[0][0]).toMatchObject({ engine: 'depth-image' });
    // Absent, not "" — the server reads absent as default_model, and "" as a
    // request for a checkpoint literally named "".
    expect(createJob.mock.calls[0][0].model).toBeUndefined();
  });

  it('sends the chosen checkpoint as the model field', async () => {
    respondByRoute([...WIRE_ENGINES, DEPTH_IMAGE]);
    await renderPanel();
    pick('preview', 'depth-image');
    pick('depth-anything-v2-small', 'depth-anything-v2-small');
    await stage('porch.png');

    const createJob = jest.spyOn(api, 'createJob');
    fireEvent.click(screen.getByRole('button', { name: 'Create 3D' }));
    await waitFor(() => expect(createJob).toHaveBeenCalled());

    expect(createJob.mock.calls[0][0]).toMatchObject({
      engine: 'depth-image',
      model: 'depth-anything-v2-small',
    });
  });

  it('blocks the submit on an unavailable checkpoint inside an available engine', async () => {
    respondWith({ engines: [...WIRE_ENGINES, DEPTH_IMAGE] });
    await renderPanel();
    pick('preview', 'depth-image');
    await stage('porch.png');

    // The engine rolls up to available because Small is usable; Large is not.
    expect(screen.getByRole('button', { name: 'Create 3D' })).toBeEnabled();

    pick('depth-anything-v2-small', 'depth-anything-v2-large');

    /*
      Scoped to the alert. The same sentence is also printed in the roster
      inside <details>, by design — that is where you read about a checkpoint
      before choosing it. An unscoped text query matches both and fails on
      ambiguity, which would be a test asserting the reason appears exactly
      once when the product deliberately says it twice.
    */
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/DEPTH_ALLOW_NONCOMMERCIAL=1/),
    );
    expect(screen.getByRole('button', { name: 'Create 3D' })).toBeDisabled();
  });

  it('drops a checkpoint id when the engine changes under it', async () => {
    respondWith({ engines: [...WIRE_ENGINES, DEPTH_IMAGE] });
    await renderPanel();
    pick('preview', 'depth-image');
    pick('depth-anything-v2-small', 'depth-anything-v2-small');
    expect(modelSelect()!.value).toBe('depth-anything-v2-small');

    // Away and back: a checkpoint id is scoped to its engine, so it must not survive.
    pick('preview', 'preview');
    pick('preview', 'depth-image');
    expect(modelSelect()!.value).toBe('');
  });
});
