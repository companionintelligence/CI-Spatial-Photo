#!/usr/bin/env node
/**
 * Runs after `react-scripts build` (see the `build` script in package.json) and does the
 * two things CRA cannot do from a template:
 *
 *   1. Injects Google Analytics 4 into build/index.html — and only when a measurement ID
 *      was supplied. `public/index.html` is a static template, so it cannot say "emit this
 *      tag if a variable is set"; this can.
 *   2. Writes build/version.txt, so "which commit is live?" has an answer that is not a
 *      guess. The live bundle once differed from a clean build of origin/main by a few
 *      bytes and nothing recorded why.
 *
 * GA4 rules, each of which exists because the alternative is a known failure:
 *   - The ID comes from the environment (GA_MEASUREMENT_ID, from the repo variable of the
 *     same name in the deploy workflow) and is NEVER committed. Unset or malformed means
 *     no tag at all, not a broken one.
 *   - The init code is an external file (build/ga-init.js), not an inline <script>, so the
 *     page's CSP never needs 'unsafe-inline' for scripts.
 *   - It is idempotent. The block is fenced by markers and removed before it is written
 *     again, so running this twice — or on a build that already has the tag — leaves one
 *     tag, not two.
 *   - The page view it sends never carries the asset id. A share link is /view/:assetId,
 *     and the page's own promise is that nothing about your memories leaves for a third
 *     party; the init reports the path as /view/:id. That covers the load-time page view
 *     only. The app later rewrites the address bar to /view/<assetId> with replaceState
 *     (App.tsx loadAsset), and a GA4 property with Enhanced measurement's "Page changes
 *     based on browser history events" on may report that change with the real URL — a
 *     property setting, not something the tag can switch off. docs/DEPLOY-CLOUDFLARE.md
 *     says to turn it off; it is the one part of this promise that lives outside the repo.
 *   - The tag is `async` and the init only pushes onto window.dataLayer, so a blocked or
 *     unreachable googletagmanager.com costs the page nothing.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GA_START = '<!-- ga4:start -->';
const GA_END = '<!-- ga4:end -->';
const GA_INIT_FILE = 'ga-init.js';
const GA_ID_PATTERN = /^G-[A-Z0-9]+$/;

/** A measurement ID from the environment, or '' when absent or not shaped like one. */
export function readMeasurementId(env = process.env) {
  const raw = (env.GA_MEASUREMENT_ID || env.REACT_APP_GA_MEASUREMENT_ID || '').trim();
  return GA_ID_PATTERN.test(raw) ? raw : '';
}

/** Remove a previously injected GA block, if there is one. */
export function stripGa(html) {
  const start = html.indexOf(GA_START);
  if (start === -1) return html;
  const end = html.indexOf(GA_END, start);
  if (end === -1) return html;
  return html.slice(0, start) + html.slice(end + GA_END.length);
}

/** The block that goes in <head>: Google's loader, then our init. */
export function gaBlock(id) {
  return (
    `${GA_START}` +
    `<script async src="https://www.googletagmanager.com/gtag/js?id=${id}"></script>` +
    `<script src="/${GA_INIT_FILE}"></script>` +
    `${GA_END}`
  );
}

/** Put the GA block just before </head>, after stripping any earlier one. */
export function injectGa(html, id) {
  const clean = stripGa(html);
  if (!id) return clean;
  if (!clean.includes('</head>')) throw new Error('index.html has no </head> to inject into');
  return clean.replace('</head>', `${gaBlock(id)}</head>`);
}

/** The contents of ga-init.js for an ID. */
export function gaInitSource(id) {
  return (
    `window.dataLayer=window.dataLayer||[];\n` +
    `function gtag(){dataLayer.push(arguments);}\n` +
    `gtag('js',new Date());\n` +
    `// A share link carries an asset id in its path; that is not Google's to have.\n` +
    `var p=location.pathname.replace(/^\\/view\\/[^/]+/,'/view/:id');\n` +
    `gtag('config','${id}',{page_path:p,page_location:location.origin+p});\n`
  );
}

/** What is live, in one line: a commit, and whether the tree it was built from was clean. */
export function versionLine(env = process.env, cwd = process.cwd()) {
  const git = (...args) => {
    try {
      return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    } catch {
      return '';
    }
  };
  const sha = env.GITHUB_SHA || git('rev-parse', 'HEAD') || 'unknown';
  // `build/` is gitignored, so the build itself never makes the tree look dirty.
  const dirty = sha !== 'unknown' && !env.GITHUB_SHA && git('status', '--porcelain') !== '';
  return `${sha}${dirty ? '-dirty' : ''}\n`;
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const build = join(root, 'build');
  const indexPath = join(build, 'index.html');
  if (!existsSync(indexPath)) {
    console.error(`postbuild: ${indexPath} not found — run react-scripts build first`);
    process.exit(1);
  }

  const id = readMeasurementId();
  const html = readFileSync(indexPath, 'utf8');
  writeFileSync(indexPath, injectGa(html, id));
  const initPath = join(build, GA_INIT_FILE);
  if (id) {
    writeFileSync(initPath, gaInitSource(id));
    console.log(`postbuild: GA4 injected (${id})`);
  } else {
    rmSync(initPath, { force: true });
    if (process.env.GA_MEASUREMENT_ID || process.env.REACT_APP_GA_MEASUREMENT_ID) {
      console.warn('postbuild: GA_MEASUREMENT_ID is set but is not a G-… ID; GA4 not injected');
    } else {
      console.log('postbuild: no GA_MEASUREMENT_ID; GA4 not injected');
    }
  }

  writeFileSync(join(build, 'version.txt'), versionLine(process.env, root));
}

// Only when run directly, so the tests can import the pure functions above. Compared by
// real path: /tmp is a symlink on macOS, and argv[1] is not resolved the way import.meta.url is.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
