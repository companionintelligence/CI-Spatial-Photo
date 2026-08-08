import React from 'react';
// Imported here rather than from a `src/setupTests.ts`: CRA loads that file into
// every suite in the project, and this worktree has other people's tests in it.
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import MemoryPicker from './MemoryPicker';
import { Job, MemoryMedia } from '../api';

/**
 * This panel is the only path in the app that creates a job from media the user
 * never uploaded, and it is the only consumer of `waitForJob`'s progress
 * callback. Both halves are exercised through `global.fetch` so the polling loop
 * in api.ts runs for real — a mocked `waitForJob` would make the progress line
 * untestable and the "done but no asset_id" case invisible.
 */
interface Route {
  media?: MemoryMedia[];
  mediaFails?: boolean;
  createFails?: boolean;
  /** Polled in order; the last entry repeats. */
  jobStates?: Job[];
}

let route: Route;
let mediaRequests: string[];
let polls: number;

const okBody = (body: unknown): Partial<Response> => ({
  ok: true,
  statusText: 'OK',
  json: () => Promise.resolve(body),
  text: () => Promise.resolve(JSON.stringify(body)),
});

const job = (over: Partial<Job>): Job => ({
  job_id: 'j1',
  owner: 'liam',
  status: 'running',
  message: '',
  ...over,
});

beforeEach(() => {
  mediaRequests = [];
  polls = 0;
  route = { media: [] };
  global.fetch = jest.fn((url: unknown, init: unknown) => {
    const href = String(url);
    const method = ((init || {}) as RequestInit).method || 'GET';

    if (href.includes('/memory/media')) {
      mediaRequests.push(href);
      return route.mediaFails
        ? Promise.resolve({
            ok: false,
            statusText: 'Bad Gateway',
            text: () => Promise.resolve('companion unreachable'),
          } as Response)
        : Promise.resolve(okBody({ media: route.media || [] }) as Response);
    }
    if (href.endsWith('/jobs') && method === 'POST') {
      return route.createFails
        ? Promise.resolve({
            ok: false,
            statusText: 'Bad Request',
            text: () => Promise.resolve('memory ref not found'),
          } as Response)
        : Promise.resolve(okBody(job({ status: 'queued' })) as Response);
    }
    const states = route.jobStates || [job({ status: 'done', asset_id: 'a1', message: 'done' })];
    const state = states[Math.min(polls, states.length - 1)];
    polls += 1;
    return Promise.resolve(okBody(state) as Response);
  }) as unknown as typeof fetch;
});

afterEach(() => jest.restoreAllMocks());

const media = (over: Partial<MemoryMedia> = {}): MemoryMedia => ({
  ref: 'mem:0001',
  kind: 'image',
  title: 'Porch, summer 1998',
  thumbnail_url: 'https://companion.test/t/0001.webp',
  ...over,
});

const mount = async (r: Route) => {
  route = { ...route, ...r };
  const view = render(<MemoryPicker onCreated={jest.fn()} />);
  await waitFor(() => expect(mediaRequests.length).toBeGreaterThan(0));
  // Let the response settle before any assertion — the whole panel is driven
  // off that one request.
  await act(async () => {});
  return view;
};

describe('browsing Companion memory', () => {
  it('asks for photos first and switches the query when Videos is picked', async () => {
    await mount({ media: [media()] });
    expect(mediaRequests[0]).toMatch(/\?type=image$/);

    fireEvent.click(screen.getByText('Videos'));
    await waitFor(() => expect(mediaRequests).toHaveLength(2));
    expect(mediaRequests[1]).toMatch(/\?type=video$/);

    // Re-clicking the tab you are already on must not re-request: `type` is the
    // effect's only dependency, so this is what keeps a double click from
    // firing a second round trip to CI-Server.
    fireEvent.click(screen.getByText('Videos'));
    expect(mediaRequests).toHaveLength(2);
  });

  it('distinguishes "memory is empty" from "memory is not connected"', async () => {
    // Both used to look the same to a user, and they need opposite actions:
    // import some photos, versus go and configure the Companion connection.
    await mount({ media: [] });
    expect(screen.getByText(/No media in Companion memory/)).toBeInTheDocument();

    route.mediaFails = true;
    fireEvent.click(screen.getByText('Videos'));
    await screen.findByText('Companion memory is not connected.');
    expect(screen.queryByText(/No media in Companion memory/)).not.toBeInTheDocument();
  });

  it('clears the empty-memory note once media actually arrives', async () => {
    await mount({ media: [] });
    expect(screen.getByText(/No media in Companion memory/)).toBeInTheDocument();

    route.media = [media({ ref: 'mem:9', title: 'Kitchen' })];
    fireEvent.click(screen.getByText('Videos'));
    await screen.findByText('Kitchen');
    expect(screen.queryByText(/No media in Companion memory/)).not.toBeInTheDocument();
  });

  it('captions each tile with the memory title, falling back to the ref', async () => {
    // Without the caption the user's own photo library renders as anonymous
    // squares — indistinguishable from a placeholder grid, and impossible to
    // pick from without hovering every one of them.
    await mount({
      media: [
        media({ ref: 'mem:1', title: 'Porch, summer 1998' }),
        media({ ref: 'mem:2', title: null, thumbnail_url: null, kind: 'video' }),
      ],
    });

    expect(screen.getByText('Porch, summer 1998')).toBeInTheDocument();
    expect(screen.getByText('mem:2')).toBeInTheDocument();
    expect(screen.getByAltText('Porch, summer 1998')).toHaveAttribute(
      'src',
      'https://companion.test/t/0001.webp',
    );
    // No thumbnail: the tile still has to say what it is rather than be blank.
    expect(screen.getByText('video')).toBeInTheDocument();
  });
});

describe('creating from a memory item', () => {
  it('sends the ref and nothing else, then hands the finished asset up', async () => {
    const onCreated = jest.fn();
    route = { ...route, media: [media({ ref: 'mem:0042' })] };
    render(<MemoryPicker onCreated={onCreated} />);
    await screen.findByText('Porch, summer 1998');

    fireEvent.click(screen.getByText('Porch, summer 1998').closest('button')!);
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('a1'));

    const post = (global.fetch as jest.Mock).mock.calls.find(
      ([, init]) => (init || {}).method === 'POST',
    )!;
    const body = post[1].body as FormData;
    // No `files`: a memory job is media the server fetches for itself, and an
    // empty file part is what makes FastAPI classify it as an upload with zero
    // images instead of a memory job.
    expect(body.getAll('files')).toEqual([]);
    expect(body.get('memory_refs')).toBe('["mem:0042"]');
  });

  it('shows the phase the server reports while the job runs', async () => {
    // `waitForJob`'s onUpdate is the only progress this panel has; the polling
    // loop delivering the non-terminal states is the thing under test.
    route = {
      ...route,
      media: [media()],
      jobStates: [
        job({ status: 'running', message: 'reconstructing with preview' }),
        job({ status: 'done', message: 'done', asset_id: 'a7' }),
      ],
    };
    const onCreated = jest.fn();
    render(<MemoryPicker onCreated={onCreated} />);
    await screen.findByText('Porch, summer 1998');

    fireEvent.click(screen.getByText('Porch, summer 1998').closest('button')!);
    // jobStatus.ts collapses the duplicate word; what must never appear is
    // "Status: running — running …".
    await screen.findByText('Status: running — reconstructing with preview');
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('a7'), { timeout: 4000 });
  });

  it('does not open a viewer for a job that failed', async () => {
    // `done.status === "done" && done.asset_id` — an errored job has no asset,
    // and calling onCreated with undefined navigates App to a viewer with
    // nothing in it.
    route = {
      ...route,
      media: [media()],
      jobStates: [job({ status: 'error', message: 'failed', error: 'colmap missing' })],
    };
    const onCreated = jest.fn();
    render(<MemoryPicker onCreated={onCreated} />);
    await screen.findByText('Porch, summer 1998');

    fireEvent.click(screen.getByText('Porch, summer 1998').closest('button')!);
    await screen.findByText('Status: error — failed');
    expect(onCreated).not.toHaveBeenCalled();
  });

  it('reports a rejected job request instead of failing silently', async () => {
    route = { ...route, media: [media()], createFails: true };
    const onCreated = jest.fn();
    render(<MemoryPicker onCreated={onCreated} />);
    await screen.findByText('Porch, summer 1998');

    fireEvent.click(screen.getByText('Porch, summer 1998').closest('button')!);
    await screen.findByText('Failed to create from memory item.');
    expect(onCreated).not.toHaveBeenCalled();
    // The tiles stay clickable: this is a retryable failure, not a dead panel.
    expect(screen.getByText('Porch, summer 1998').closest('button')).toBeEnabled();
  });
});
