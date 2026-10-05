import React from 'react';
// Imported here rather than from a `src/setupTests.ts`: CRA loads that file into
// every suite in the project, and this worktree has other people's tests in it.
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import Gallery from './Gallery';
import { getApiBase, Asset } from '../api';

/**
 * Driven through `global.fetch` rather than a mocked `api`, so the four states
 * this component can be in are reached the way the server puts it in them —
 * including the error state, whose message is produced by `api.ts`'s own
 * response handler and not by anything a mocked module would return.
 *
 * Responses are held open deliberately: the loading state is the one a user
 * sees on every cold start, and a mock that resolves before `render` returns
 * makes it untestable.
 */
let resolvers: Array<(r: Partial<Response>) => void>;

const okBody = (body: unknown): Partial<Response> => ({
  ok: true,
  statusText: 'OK',
  json: () => Promise.resolve(body),
  text: () => Promise.resolve(JSON.stringify(body)),
});

beforeEach(() => {
  resolvers = [];
  global.fetch = jest.fn(
    () => new Promise<Response>((resolve) => resolvers.push((r) => resolve(r as Response))),
  ) as unknown as typeof fetch;
});

afterEach(() => jest.restoreAllMocks());

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

/** Settle the newest outstanding request with a normal 200 and let React flush. */
const deliver = (assets: Partial<Asset>[]) =>
  act(async () => {
    resolvers[resolvers.length - 1](okBody({ assets: assets.map(asset) }));
  });

const breakRequest = (statusText: string, body: string) =>
  act(async () => {
    resolvers[resolvers.length - 1]({ ok: false, statusText, text: () => Promise.resolve(body) });
  });

describe('Gallery states', () => {
  it('says it is loading rather than claiming the library is empty', async () => {
    // These two states render near-identical grey text, and swapping them tells
    // a user with two hundred memories that they have none for as long as the
    // request takes.
    render(<Gallery onSelect={jest.fn()} />);
    expect(screen.getByText(/Loading your memories/)).toBeInTheDocument();
    expect(screen.queryByText(/No 3D memories yet/)).not.toBeInTheDocument();

    await deliver([]);
    expect(screen.getByText(/No 3D memories yet/)).toBeInTheDocument();
    expect(screen.queryByText(/Loading your memories/)).not.toBeInTheDocument();
  });

  it('surfaces the server text on failure, and says which failure it was', async () => {
    render(<Gallery onSelect={jest.fn()} />);
    await breakRequest('Internal Server Error', 'database is locked');

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Could not load your memories.');
    // Without the second half the user cannot tell "the server is down" from
    // "you are logged out" — the two things they can actually act on.
    expect(alert).toHaveTextContent('database is locked');
  });

  it('recovers when a later refresh succeeds', async () => {
    // `refreshKey` exists so a mounted Gallery can be refetched. The error
    // branch is checked before the loading and list branches, so an error that
    // is never cleared pins the panel to "Could not load your memories" for the
    // rest of the session however many successful refreshes follow.
    const onSelect = jest.fn();
    const { rerender } = render(<Gallery onSelect={onSelect} refreshKey={0} />);
    await breakRequest('Bad Gateway', 'upstream unavailable');
    expect(screen.getByRole('alert')).toBeInTheDocument();

    rerender(<Gallery onSelect={onSelect} refreshKey={1} />);
    await deliver([{ asset_id: 'a2', source_filenames: ['kitchen.png'] }]);

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('kitchen')).toBeInTheDocument();
  });

  it('refetches only when refreshKey actually changes', async () => {
    const { rerender } = render(<Gallery onSelect={jest.fn()} refreshKey={3} />);
    await deliver([{ asset_id: 'a1' }]);
    expect(global.fetch).toHaveBeenCalledTimes(1);

    // App.tsx passes `onSelect={(a) => loadAsset(a.asset_id)}` — a fresh closure
    // on every parent render. An effect keyed on it would refetch the entire
    // library every time anything in App re-rendered.
    rerender(<Gallery onSelect={jest.fn()} refreshKey={3} />);
    expect(global.fetch).toHaveBeenCalledTimes(1);

    rerender(<Gallery onSelect={jest.fn()} refreshKey={4} />);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});

describe('Gallery cards', () => {
  it('leads with what the memory is of, not with the machinery that made it', async () => {
    render(<Gallery onSelect={jest.fn()} />);
    await deliver([
      { asset_id: 'a1', source_filenames: ['porch-1998.png'] },
      { asset_id: 'a2', source_filenames: ['holiday.2019.jpg', 'b.jpg', 'c.jpg'] },
      { asset_id: 'a3', source_filenames: [], source_origin: 'memory' },
      { asset_id: 'a4', source_filenames: [], engine: 'preview' },
    ]);

    expect(screen.getByText('porch-1998')).toBeInTheDocument();
    // Only the final suffix is a suffix: "holiday.2019" is a date, not an
    // extension, and stripping greedily would title the card "holiday".
    expect(screen.getByText('holiday.2019 +2')).toBeInTheDocument();
    expect(screen.getByText('From Companion memory')).toBeInTheDocument();
    // Last resort only, and only for an upload with no filenames at all.
    expect(screen.getByText('splat · preview')).toBeInTheDocument();
  });

  it('does not render an empty title for a file that is all suffix', async () => {
    // ".DS_Store" strips to "", and an empty <div> in the title slot is a card
    // with a blank first line, indistinguishable from a broken one.
    render(<Gallery onSelect={jest.fn()} />);
    await deliver([{ asset_id: 'a1', source_filenames: ['.DS_Store'], engine: 'preview' }]);
    expect(screen.getByText('splat · preview')).toBeInTheDocument();
  });

  it('shows the thumbnail when there is one and names the kind when there is not', async () => {
    render(<Gallery onSelect={jest.fn()} />);
    await deliver([
      { asset_id: 'withthumb', thumbnail: 'thumb.webp', engine: 'sharp' },
      { asset_id: 'nothumb', thumbnail: null, kind: 'mesh', engine: 'preview' },
    ]);

    // The image comes from the API endpoint, not from the value of the
    // `thumbnail` field — that field is a server-side path, and using it as a
    // src is a broken image on every card.
    //
    // The alt text says what the memory is of ("Preview of porch-1998"), not which
    // reconstruction engine made it: "sharp" read aloud is a model name, not a picture.
    expect(screen.getByAltText('Preview of porch-1998')).toHaveAttribute(
      'src',
      `${getApiBase()}/api/v1/assets/withthumb/thumbnail`,
    );
    // The card without a thumbnail renders no <img> at all, so nothing is announced twice.
    expect(screen.getAllByRole('img')).toHaveLength(1);
    expect(screen.getByText('mesh')).toBeInTheDocument();
  });

  it('dates the card to the day, without the seconds', async () => {
    // `toLocaleString()` printed "6/15/2026, 2:58:12 PM", and the seconds
    // competed with the title for the width of a two-column card. Asserted as
    // "has the year, has no clock" rather than as a literal, because the format
    // is the runner's locale and the literal would only pin en-US.
    render(<Gallery onSelect={jest.fn()} />);
    await deliver([{ asset_id: 'a1', created_at: '2026-06-15T14:58:12Z' }]);

    const subtitle = screen.getByText(/triposplat/).textContent || '';
    expect(subtitle).toMatch(/2026/);
    expect(subtitle).not.toMatch(/\d{1,2}:\d{2}/);
  });

  it('hands the whole asset to onSelect, not just the one that was rendered first', async () => {
    const onSelect = jest.fn();
    render(<Gallery onSelect={onSelect} />);
    await deliver([{ asset_id: 'first' }, { asset_id: 'second', source_filenames: ['kitchen.png'] }]);

    fireEvent.click(screen.getByText('kitchen').closest('button')!);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0]).toMatchObject({ asset_id: 'second' });
  });
});
