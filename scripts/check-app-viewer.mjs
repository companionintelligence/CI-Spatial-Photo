#!/usr/bin/env node
/**
 * Checks that web-server/client/build is fit to go inside the desktop or Android app.
 *
 * The apps ship the viewer exactly as the root `npm run build` makes it, and that build is
 * also what photo.ci.computer serves, so two of its build-time inputs have to be absent:
 *
 *   - REACT_APP_API_BASE. Unset, the bundle has no server address and asks for one on
 *     first start (web-server/client/src/utils/apiTarget.ts). Set to anything, including
 *     empty, it bakes an address into a public binary. The root build unsets it with
 *     `env -u`, but a `.env*` file next to the viewer would still feed it in.
 *   - GA_MEASUREMENT_ID. The apps send nothing to Google Analytics; postbuild.mjs only adds
 *     the tag when the ID is set.
 *
 * The built JavaScript cannot be checked for a baked-in address (the "This machine" preset
 * already contains http://localhost:8000), so the environment and the `.env*` files are.
 *
 *   node scripts/check-app-viewer.mjs [build-dir]
 *
 * Exit code 1 and the reasons when it is not fit; 0 and one line otherwise.
 */
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT = join(ROOT, 'web-server', 'client');

/** Build-time variables an app build must not carry. */
export const FORBIDDEN_ENV = ['REACT_APP_API_BASE', 'GA_MEASUREMENT_ID', 'REACT_APP_GA_MEASUREMENT_ID'];

/** Problems with a built viewer, as human-readable strings. Empty when it is fit. */
export function appViewerProblems({ build, client = CLIENT, env = process.env }) {
  const problems = [];
  for (const name of FORBIDDEN_ENV) {
    if (env[name] !== undefined) problems.push(`${name} is set in this environment; unset it and rebuild`);
  }

  if (existsSync(client)) {
    for (const file of readdirSync(client).filter((f) => f.startsWith('.env'))) {
      const text = readFileSync(join(client, file), 'utf8');
      for (const name of FORBIDDEN_ENV) {
        if (new RegExp(`^\\s*(export\\s+)?${name}\\s*=`, 'm').test(text)) {
          problems.push(`web-server/client/${file} sets ${name}, which CRA reads at build time`);
        }
      }
    }
  }

  const index = join(build, 'index.html');
  if (!existsSync(index)) {
    problems.push(`${index} is missing; run the root \`npm run build\` first`);
    return problems;
  }
  const html = readFileSync(index, 'utf8');
  if (html.includes('googletagmanager.com') || html.includes('<!-- ga4:start -->')) {
    problems.push('index.html carries the Google Analytics tag');
  }
  if (existsSync(join(build, 'ga-init.js'))) problems.push('ga-init.js is in the build');
  if (!existsSync(join(build, 'version.txt'))) {
    problems.push('version.txt is missing; the build did not finish its postbuild step');
  }
  return problems;
}

function main() {
  const build = resolve(process.argv[2] ?? join(CLIENT, 'build'));
  const problems = appViewerProblems({ build });
  if (problems.length) {
    console.error(`check-app-viewer: ${build} is not fit for the apps:`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  const version = readFileSync(join(build, 'version.txt'), 'utf8').trim();
  console.log(`check-app-viewer: ok (${version}; no server address, no analytics)`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
