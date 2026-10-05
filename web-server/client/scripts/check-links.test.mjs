import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { REQUIRED_LINKS } from './check-build.mjs';
import { checkLink, checkLinks } from './check-links.mjs';

/** A fetch that answers from a table of url -> status (or a thrown error), counting calls. */
function fakeFetch(table) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const answer = table[url];
    if (answer instanceof Error) throw answer;
    return { status: answer ?? 404, url: typeof answer === 'object' ? answer.url : url, body: null };
  };
  impl.calls = calls;
  return impl;
}
const quick = { pause: 0 };

describe('checkLink', () => {
  it('passes a 2xx on the first try', async () => {
    const fetchImpl = fakeFetch({ 'https://ok.test/': 200 });
    const r = await checkLink('https://ok.test/', { fetchImpl, ...quick });
    assert.equal(r.ok, true);
    assert.equal(fetchImpl.calls.length, 1);
  });

  it('fails the docs page that 404s, after retrying it, because a 404 is not a dropped packet', async () => {
    const fetchImpl = fakeFetch({ 'https://docs.ci.computer/docs': 404 });
    const r = await checkLink('https://docs.ci.computer/docs', { fetchImpl, tries: 3, ...quick });
    assert.equal(r.ok, false);
    assert.equal(r.status, 404);
    assert.equal(fetchImpl.calls.length, 3);
  });

  it('recovers from a transient error', async () => {
    let n = 0;
    const fetchImpl = async () => {
      if (++n === 1) throw new TypeError('fetch failed');
      return { status: 200, url: 'https://flaky.test/', body: null };
    };
    const r = await checkLink('https://flaky.test/', { fetchImpl, ...quick });
    assert.equal(r.ok, true);
    assert.equal(n, 2);
  });

  it('reports the error when it never answers', async () => {
    const fetchImpl = fakeFetch({ 'https://down.test/': new TypeError('fetch failed') });
    const r = await checkLink('https://down.test/', { fetchImpl, tries: 2, ...quick });
    assert.equal(r.ok, false);
    assert.equal(r.status, 0);
    assert.match(r.error, /fetch failed/);
  });

  it('judges the final status after redirects, and says where it landed', async () => {
    // ci.computer/core redirects to the store page; the answer that counts is the 200 there.
    const fetchImpl = async () => ({ status: 200, url: 'https://ci.computer/store/p/core', body: null });
    const r = await checkLink('https://ci.computer/core', { fetchImpl, ...quick });
    assert.equal(r.ok, true);
    assert.equal(r.finalUrl, 'https://ci.computer/store/p/core');
  });
});

describe('checkLinks', () => {
  it('returns one result per URL, in order', async () => {
    const fetchImpl = fakeFetch({ 'https://a.test/': 200, 'https://b.test/': 404 });
    const rs = await checkLinks(['https://a.test/', 'https://b.test/'], { fetchImpl, tries: 1, ...quick });
    assert.deepEqual(rs.map((r) => r.ok), [true, false]);
  });

  it('checks exactly the four destinations the page links to', () => {
    assert.deepEqual(Object.keys(REQUIRED_LINKS).sort(), ['buy', 'docs', 'download', 'home']);
  });
});
