#!/usr/bin/env node
/**
 * Fills mobile/www, the Capacitor webDir, with a copy of the viewer build and the project's
 * licence (www/LICENSE.txt, which PolyForm requires every copy to carry).
 *
 * The app ships the viewer exactly as the root `npm run build` makes it in
 * web-server/client/build: no rebuild and no second set of build flags. The build is checked
 * first (scripts/check-app-viewer.mjs) because the same directory is what photo.ci.computer
 * serves, and the app must not carry a server address or the analytics tag.
 *
 *   node scripts/copy-web.mjs [viewer-build-dir]
 *
 * `cap sync android` then copies www/ into the Android project's assets. The third-party
 * notices join them there (`npm run notices`, which needs the synced Gradle project).
 */
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appViewerProblems } from '../../scripts/check-app-viewer.mjs';

const mobile = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(mobile, '..');
const build = resolve(process.argv[2] ?? join(repo, 'web-server', 'client', 'build'));
const www = join(mobile, 'www');

const problems = appViewerProblems({ build });
if (problems.length) {
  console.error(`copy-web: ${build} is not fit for the app:`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

if (existsSync(www)) rmSync(www, { recursive: true, force: true });
cpSync(build, www, { recursive: true });
cpSync(join(repo, 'LICENSE'), join(www, 'LICENSE.txt'));
console.log(`copy-web: ${build} and LICENSE -> ${www}`);
