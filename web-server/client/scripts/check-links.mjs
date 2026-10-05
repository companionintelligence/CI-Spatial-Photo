#!/usr/bin/env node
/**
 * Fetches every place this page sends people (home, Buy, Download, Docs) and fails on
 * anything that does not end in a 2xx.
 *
 * Why this exists, separately from check-build.mjs: that one proves the links are THERE and
 * agree with each other, and every gate in it checks against the same constant. When the
 * constant is wrong (docs.ci.computer/docs, which the docs site answers with its own 404),
 * all of them agree with it and pass. Only asking the destination can say it is dead.
 *
 * It needs the network, so it is NOT part of `npm run build` (the Docker build and a
 * laptop on a plane must still build). It runs before a deploy publishes — in
 * .github/workflows/deploy-cloudflare.yml and scripts/deploy-cloudflare.sh — and by hand:
 *
 *     npm run check:links
 *
 * Redirects are followed and the FINAL status is judged: ci.computer/core is meant to
 * redirect (to the store page), and a redirect that lands on a 200 is a working link.
 * Each URL gets a few tries, because a deploy should not be blocked by one dropped packet,
 * but a URL that answers 404 twice in a row is dead, not unlucky.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { REQUIRED_LINKS } from './check-build.mjs';

const TRIES = 3;
const TIMEOUT_MS = 15000;
const PAUSE_MS = 2000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One URL: `{ url, ok, status, finalUrl, error }`. `fetchImpl` is injectable so the tests
 * do not touch the network.
 */
export async function checkLink(url, { fetchImpl = fetch, tries = TRIES, pause = PAUSE_MS } = {}) {
  let last = { url, ok: false, status: 0, finalUrl: url, error: 'not attempted' };
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetchImpl(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        // Some hosts answer a bare client differently from a browser; say what this is.
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; photo-ci-link-check)', accept: 'text/html' },
      });
      // Only the status matters. Not reading the body would hold the connection open.
      await res.body?.cancel?.();
      last = { url, ok: res.status >= 200 && res.status < 300, status: res.status, finalUrl: res.url || url, error: '' };
      if (last.ok) return last;
    } catch (e) {
      last = { url, ok: false, status: 0, finalUrl: url, error: e && e.message ? e.message : String(e) };
    }
    if (attempt < tries) await sleep(pause);
  }
  return last;
}

/** Every URL, in parallel. Returns one result per URL, in order. */
export async function checkLinks(urls, options) {
  return Promise.all(urls.map((u) => checkLink(u, options)));
}

async function main() {
  const urls = [...new Set(Object.values(REQUIRED_LINKS))];
  const results = await checkLinks(urls);
  let failed = 0;
  for (const r of results) {
    const landed = r.finalUrl && r.finalUrl !== r.url ? ` -> ${r.finalUrl}` : '';
    if (r.ok) {
      console.log(`ok    ${r.status}  ${r.url}${landed}`);
    } else {
      failed++;
      console.error(`DEAD  ${r.status || 'no response'}  ${r.url}${landed}${r.error ? `  (${r.error})` : ''}`);
    }
  }
  if (failed) {
    console.error(
      `check-links: ${failed} of ${results.length} destinations did not answer 2xx. A link here is one a visitor ` +
        'is about to click; fix it in src/siteLinks.ts (and the places check-build.mjs lists) before deploying.',
    );
    process.exit(1);
  }
  console.log(`check-links: all ${results.length} destinations answer`);
}

// Only when run directly (the tests import the functions). Real-path compare: /tmp is a symlink on macOS.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
