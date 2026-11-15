#!/usr/bin/env node
/**
 * Third-party notices for the desktop and Android apps, generated from the lockfiles.
 *
 * What goes into each app is read, not listed by hand:
 *
 *   viewer   The npm packages in the web bundle. The build's own source maps say which
 *            modules webpack put in it; web-server/client/package-lock.json says which
 *            package and version each one is; node_modules has their licence files. Plus
 *            the self-hosted Manrope font and Tailwind's generated CSS.
 *   desktop  The Rust crates in the Tauri binary: `cargo metadata --locked` on
 *            desktop/src-tauri (so Cargo.lock), for every desktop target, following normal
 *            dependencies from the app (build and dev dependencies are not in the binary).
 *            Licence files come from each crate's source in the cargo registry. MPL-2.0
 *            crates get a pointer to their source, as MPL-2.0 section 3.2 asks. Plus what
 *            the binary links besides the crates' own code: the Rust standard library, and
 *            on Windows the WebView2 loader that webview2-com-sys links statically.
 *   android  The libraries in the APK: Capacitor (mobile/package-lock.json) and the Maven
 *            artifacts on the release runtime classpath, as Gradle resolves them, with each
 *            artifact's licence read from its POM in the Gradle cache.
 *
 * Each part is collected where its inputs exist and saved as JSON, then any set of parts is
 * rendered into one text file:
 *
 *   node scripts/third-party-notices.mjs collect viewer  --out notices/viewer.json
 *   node scripts/third-party-notices.mjs collect desktop --out notices/desktop.json
 *   node scripts/third-party-notices.mjs collect android --out notices/android.json [--gradle-deps FILE]
 *   node scripts/third-party-notices.mjs render --out FILE notices/viewer.json notices/desktop.json ...
 *
 *   node scripts/third-party-notices.mjs build desktop|android --out FILE   (collect + render)
 *
 * Output never contains a local path: packages are named by name, version and repository.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT = join(ROOT, 'web-server', 'client');
const TAURI = join(ROOT, 'desktop', 'src-tauri');
const MOBILE = join(ROOT, 'mobile');

/** The desktop targets the release builds; the notices cover the union of their crates. */
export const DESKTOP_TARGETS = [
  'x86_64-pc-windows-msvc',
  'aarch64-apple-darwin',
  'x86_64-apple-darwin',
  'x86_64-unknown-linux-gnu',
];

const LICENSE_FILE = /^(licen[cs]e|copying|notice|copyright|unlicense)([-_.][\w.-]*)?$/i;

// ── Small pure helpers (tested in third-party-notices.test.mjs) ─────────────────

/** "git+https://github.com/a/b.git" and friends, as a plain https URL, or null. */
export function normalizeRepository(repo) {
  const raw = typeof repo === 'string' ? repo : repo?.url;
  if (!raw) return null;
  let url = raw.trim().replace(/^git\+/, '').replace(/\.git$/, '');
  if (url.startsWith('git://')) url = `https://${url.slice(6)}`;
  if (url.startsWith('git@github.com:')) url = `https://github.com/${url.slice(15)}`;
  if (/^github:/.test(url)) url = `https://github.com/${url.slice(7)}`;
  if (/^[\w.-]+\/[\w.-]+$/.test(url)) url = `https://github.com/${url}`;
  return /^https?:\/\//.test(url) ? url : null;
}

/**
 * The lockfile keys (`node_modules/a`, `node_modules/a/node_modules/b`) a bundled source path
 * belongs to. First the installed package that owns the file: the longest key the path starts
 * with, after its first `node_modules/`. Then any package that one's published build embeds:
 * a dist file built from another package keeps that package's node_modules path in its source
 * map (Spark ships fflate inside its own bundle), and the lockfile names it at the top level.
 * Empty for the app's own sources and for paths no installed package owns.
 */
export function lockKeysForSource(source, lockKeys) {
  const i = source.indexOf('node_modules/');
  if (i < 0) return [];
  const path = source.slice(i).split('|')[0];
  let best = null;
  for (const key of lockKeys) {
    if ((path === key || path.startsWith(`${key}/`)) && (!best || key.length > best.length)) best = key;
  }
  if (!best) return [];
  const keys = [best];
  for (const m of path.slice(best.length).matchAll(/node_modules\/((?:@[^/]+\/)?[^/]+)/g)) {
    const hoisted = `node_modules/${m[1]}`;
    if (lockKeys.has(hoisted) && !keys.includes(hoisted)) keys.push(hoisted);
  }
  return keys;
}

/** The package name at the end of a lockfile key. */
export function packageNameFromKey(key) {
  const tail = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
  return tail;
}

/** Resolved `group:artifact:version` coordinates from `gradle :app:dependencies` output. */
export function parseGradleDependencies(text) {
  const found = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^[\s|+\\-]*[+\\]--- (.+)$/);
    if (!m) continue;
    let entry = m[1].trim();
    if (entry.startsWith('project ')) continue;
    if (/\((c|n)\)\s*$/.test(entry)) continue; // constraints and unresolved entries
    entry = entry.replace(/\s*\(\*\)\s*$/, '');
    const coord = entry.match(/^([^:\s]+):([^:\s]+):(\S+?)(?:\s*->\s*(\S+))?(?:\s.*)?$/);
    let group;
    let artifact;
    let version;
    if (coord) {
      [, group, artifact, version] = coord;
      if (coord[4]) version = coord[4];
    } else {
      // `group:artifact -> version` when the declared version is implicit (a BOM, a platform).
      const implicit = entry.match(/^([^:\s]+):([^:\s]+)\s*->\s*(\S+)/);
      if (!implicit) continue;
      [, group, artifact, version] = implicit;
    }
    found.set(`${group}:${artifact}`, { group, artifact, version });
  }
  return [...found.values()].sort((a, b) => `${a.group}:${a.artifact}`.localeCompare(`${b.group}:${b.artifact}`));
}

/** Licence names from a POM's <licenses> block. */
export function pomLicenses(pom) {
  const block = pom.match(/<licenses>([\s\S]*?)<\/licenses>/);
  if (!block) return [];
  return [...block[1].matchAll(/<license>([\s\S]*?)<\/license>/g)].map((m) => {
    const name = m[1].match(/<name>([\s\S]*?)<\/name>/)?.[1]?.trim() ?? '';
    const url = m[1].match(/<url>([\s\S]*?)<\/url>/)?.[1]?.trim() ?? '';
    return { name, url };
  });
}

/** An SPDX id for the licence names Maven POMs use, or the name itself. */
export function spdxForPomLicense({ name, url }) {
  const n = `${name} ${url}`.toLowerCase();
  if (/apache/.test(n) && /2\.0/.test(n)) return 'Apache-2.0';
  if (/\bmit\b/.test(n)) return 'MIT';
  if (/bsd/.test(n) && /3/.test(n)) return 'BSD-3-Clause';
  if (/bsd/.test(n) && /2/.test(n)) return 'BSD-2-Clause';
  if (/eclipse public license/.test(n) && /2\.0/.test(n)) return 'EPL-2.0';
  return name || url || 'unknown';
}

/** Which well-known licence a full text is, when it can be borrowed for a package that ships none. */
export function classifyLicenseText(text) {
  const t = text.replace(/\s+/g, ' ').toLowerCase();
  if (t.includes('apache license') && t.includes('version 2.0, january 2004') && t.includes('terms and conditions for use, reproduction, and distribution')) {
    return 'Apache-2.0';
  }
  if (t.includes('mozilla public license version 2.0') || t.includes('mozilla public license, version 2.0')) {
    if (t.includes('1. definitions')) return 'MPL-2.0';
  }
  return null;
}

/** The SPDX ids an expression names: "MIT OR Apache-2.0" -> ["MIT", "Apache-2.0"]. */
export function spdxIds(expression) {
  return (expression ?? '')
    .replace(/[()]/g, ' ')
    .split(/\s+(?:OR|AND|WITH)\s+|\s*\/\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

const BSD3_TEXT = (holder) => `BSD 3-Clause License

Copyright (c) ${holder}

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
`;

const MIT_TEXT = (holder) => `MIT License

Copyright (c) ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

/**
 * LICENSE.txt of the Microsoft.Web.WebView2 NuGet package, as nuget.org publishes it for
 * 1.0.3800.47, the SDK that webview2-com-sys 0.39.1 ships (line endings normalised, one trailing
 * space dropped). WEBVIEW2_SDK_CHECKED is the SDK it was checked against: a collect that finds
 * another SDK says so, and this text should then be compared with that package's LICENSE.txt.
 */
export const WEBVIEW2_SDK_CHECKED = '1.0.3800.47';
export const WEBVIEW2_SDK_LICENSE = `Copyright (C) Microsoft Corporation. All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

   * Redistributions of source code must retain the above copyright
notice, this list of conditions and the following disclaimer.
   * Redistributions in binary form must reproduce the above
copyright notice, this list of conditions and the following disclaimer
in the documentation and/or other materials provided with the
distribution.
   * The name of Microsoft Corporation, or the names of its contributors
may not be used to endorse or promote products derived from this
software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
`;

/** The FileVersion in a Windows PE file's VS_FIXEDFILEINFO ("1.0.3800.47"), or null. */
export function peFileVersion(buffer) {
  const i = buffer.indexOf(Buffer.from([0xbd, 0x04, 0xef, 0xfe])); // dwSignature 0xFEEF04BD
  if (i < 0 || i + 16 > buffer.length) return null;
  const ms = buffer.readUInt32LE(i + 8); // dwFileVersionMS
  const ls = buffer.readUInt32LE(i + 12); // dwFileVersionLS
  return `${ms >>> 16}.${ms & 0xffff}.${ls >>> 16}.${ls & 0xffff}`;
}

/** Licence files in a package directory, as {label, text}. */
function licenseFilesIn(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => LICENSE_FILE.test(f) && statSync(join(dir, f)).isFile())
    .sort()
    .map((f) => ({ label: f, text: readFileSync(join(dir, f), 'utf8') }));
}

// ── Collectors ────────────────────────────────────────────────────────────────

/** The viewer bundle's npm packages, from the build's source maps and the lockfile. */
export function collectViewer({ client = CLIENT } = {}) {
  const build = join(client, 'build');
  const lock = JSON.parse(readFileSync(join(client, 'package-lock.json'), 'utf8'));
  const lockKeys = new Set(Object.keys(lock.packages).filter((k) => k.startsWith('node_modules/')));

  const maps = [];
  for (const sub of ['static/js', 'static/css']) {
    const dir = join(build, sub);
    if (existsSync(dir)) maps.push(...readdirSync(dir).filter((f) => f.endsWith('.map')).map((f) => join(dir, f)));
  }
  if (!maps.length) {
    throw new Error(`no source maps under ${build}: build the viewer with the root \`npm run build\` first`);
  }

  const keys = new Set();
  for (const file of maps) {
    for (const source of JSON.parse(readFileSync(file, 'utf8')).sources ?? []) {
      for (const key of lockKeysForSource(source, lockKeys)) keys.add(key);
    }
  }
  // Tailwind writes the stylesheet itself (its preflight and utilities), so its code is in the
  // CSS without being a module webpack can see.
  if (lock.packages['node_modules/tailwindcss']) keys.add('node_modules/tailwindcss');

  const packages = [...keys].sort().map((key) => {
    const entry = lock.packages[key];
    const dir = join(client, key);
    const pkg = existsSync(join(dir, 'package.json')) ? JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) : {};
    const name = pkg.name ?? packageNameFromKey(key);
    const author = typeof pkg.author === 'string' ? pkg.author : pkg.author?.name;
    return {
      ecosystem: 'npm',
      name,
      version: entry.version ?? pkg.version,
      license: entry.license ?? pkg.license ?? 'unknown',
      repository: normalizeRepository(pkg.repository) ?? pkg.homepage ?? `https://www.npmjs.com/package/${name}`,
      holder: author ?? `the ${name} authors`,
      texts: licenseFilesIn(dir),
      note: key === 'node_modules/tailwindcss' ? 'Generates the stylesheet at build time.' : undefined,
    };
  });

  const fontLicense = join(client, 'src', 'fonts', 'LICENSE-Manrope.txt');
  if (existsSync(fontLicense)) {
    packages.push({
      ecosystem: 'font',
      name: 'Manrope (variable font)',
      version: 'self-hosted woff2',
      license: 'OFL-1.1',
      repository: 'https://github.com/sharanda/manrope',
      texts: [{ label: 'LICENSE-Manrope.txt', text: readFileSync(fontLicense, 'utf8') }],
    });
  }
  return {
    part: 'viewer',
    title: 'The viewer: JavaScript and fonts in the web bundle (desktop and Android)',
    packages,
  };
}

function cargoMetadata(manifest, target) {
  const out = execFileSync(
    'cargo',
    ['metadata', '--format-version', '1', '--locked', '--manifest-path', manifest, '--filter-platform', target],
    { maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  return JSON.parse(out.toString('utf8'));
}

/** Normal-dependency closure of the root package in one `cargo metadata` graph. */
export function linkedCrates(metadata) {
  const nodes = new Map(metadata.resolve.nodes.map((n) => [n.id, n]));
  const seen = new Set();
  const stack = [metadata.resolve.root];
  while (stack.length) {
    const id = stack.pop();
    for (const dep of nodes.get(id)?.deps ?? []) {
      const normal = (dep.dep_kinds ?? []).some((k) => k.kind === null);
      if (normal && !seen.has(dep.pkg)) {
        seen.add(dep.pkg);
        stack.push(dep.pkg);
      }
    }
  }
  return metadata.packages.filter((p) => seen.has(p.id));
}

/** The version of the rustc that cargo uses in `dir` ("1.96.0"), or null. */
function rustcVersion(dir) {
  try {
    const out = execFileSync('rustc', ['--version'], { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    return out.match(/^rustc (\S+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** The WebView2 SDK version of the loader in a webview2-com-sys source directory, or null. */
function webview2SdkVersion(crateDir) {
  // The crate ships the SDK's loader as a static library and as a DLL; only the DLL has a version.
  for (const arch of ['x64', 'arm64', 'x86']) {
    const dll = join(crateDir, arch, 'WebView2Loader.dll');
    if (existsSync(dll)) return peFileVersion(readFileSync(dll));
  }
  return null;
}

/**
 * What the desktop binary links besides the crates' own code:
 *
 * - The Rust standard library, on every target.
 * - Microsoft's WebView2 loader, wherever webview2-com-sys is linked for an MSVC target. The
 *   crate links WebView2LoaderStatic.lib, from the WebView2 SDK it ships, statically into the
 *   binary. The crate's MIT licence covers only its Rust bindings; the loader's own licence asks
 *   binary redistributions to reproduce Microsoft's notice. (A -gnu target would load
 *   WebView2Loader.dll instead; the release builds none.)
 *
 * `crates` are the collected crate entries, each with every target it is linked for.
 * `webview2Sdk` maps a webview2-com-sys version to the SDK version of the loader it ships.
 */
export function nonCrateCode(crates, { targets, rustVersion = null, webview2Sdk = new Map() }) {
  const entries = [
    {
      ecosystem: 'rust-toolchain',
      name: 'Rust standard library (core, alloc, std)',
      version: rustVersion ?? 'unknown',
      license: 'MIT OR Apache-2.0',
      repository: 'https://github.com/rust-lang/rust',
      holder: 'The Rust Project Developers',
      platforms: [...targets],
      note:
        'Statically linked into the binary. A few of its files are under other permissive licences ' +
        '(Unicode-3.0 for its Unicode tables, for one); COPYRIGHT-library.html, which every Rust ' +
        'toolchain installs, lists them all.',
      texts: [],
    },
  ];
  for (const crate of crates.filter((c) => c.name === 'webview2-com-sys')) {
    const msvc = crate.platforms.filter((target) => target.endsWith('-windows-msvc'));
    if (!msvc.length) continue;
    const sdk = webview2Sdk.get(crate.version) ?? null;
    entries.push({
      ecosystem: 'vendored',
      name: 'Microsoft WebView2 SDK loader (WebView2LoaderStatic.lib)',
      version: sdk ?? `from webview2-com-sys ${crate.version}`,
      license: 'WebView2 SDK licence (BSD-style)',
      repository: `https://www.nuget.org/packages/Microsoft.Web.WebView2${sdk ? `/${sdk}` : ''}`,
      holder: 'Microsoft Corporation',
      platforms: msvc,
      note:
        `Statically linked into the Windows binary. It comes inside webview2-com-sys ${crate.version}, ` +
        'whose MIT licence covers only the Rust bindings.',
      texts: [{ label: 'LICENSE.txt (Microsoft.Web.WebView2 NuGet package)', text: WEBVIEW2_SDK_LICENSE }],
    });
  }
  return entries;
}

/** The Rust crates linked into the desktop binary, and the code linked with them, for every desktop target. */
export function collectDesktop({ manifest = join(TAURI, 'Cargo.toml'), targets = DESKTOP_TARGETS } = {}) {
  const crates = new Map();
  const webview2Sdk = new Map();
  for (const target of targets) {
    for (const p of linkedCrates(cargoMetadata(manifest, target))) {
      const key = `${p.name}@${p.version}`;
      if (!crates.has(key)) {
        const dir = dirname(p.manifest_path);
        if (p.name === 'webview2-com-sys') {
          const sdk = webview2SdkVersion(dir);
          webview2Sdk.set(p.version, sdk);
          if (sdk !== WEBVIEW2_SDK_CHECKED) {
            const message =
              `webview2-com-sys ${p.version} ships WebView2 SDK ${sdk ?? '(version unreadable)'}, not ` +
              `${WEBVIEW2_SDK_CHECKED}: compare WEBVIEW2_SDK_LICENSE with that package's LICENSE.txt`;
            // An annotation on the workflow run, where it would otherwise scroll by unread.
            if (process.env.GITHUB_ACTIONS) console.log(`::warning::${message}`);
            else console.warn(`third-party-notices: ${message}`);
          }
        }
        const texts = licenseFilesIn(dir);
        if (!p.license && p.license_file && existsSync(join(dir, p.license_file)) && !texts.some((t) => t.label === p.license_file)) {
          texts.push({ label: p.license_file, text: readFileSync(join(dir, p.license_file), 'utf8') });
        }
        const fromRegistry = (p.source ?? '').startsWith('registry+');
        crates.set(key, {
          ecosystem: 'crates.io',
          name: p.name,
          version: p.version,
          license: p.license ?? (p.license_file ? `see ${p.license_file}` : 'unknown'),
          repository: normalizeRepository(p.repository) ?? p.homepage ?? null,
          holder: (p.authors ?? []).map((a) => a.replace(/\s*<[^>]*>/, '')).join(', ') || `the ${p.name} authors`,
          source: fromRegistry
            ? `https://crates.io/crates/${p.name}/${p.version} (source archive: https://static.crates.io/crates/${p.name}/${p.name}-${p.version}.crate)`
            : null,
          platforms: [],
          texts,
        });
      }
      crates.get(key).platforms.push(target);
    }
  }
  const sorted = [...crates.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  const packages = [...nonCrateCode(sorted, { targets, rustVersion: rustcVersion(dirname(manifest)), webview2Sdk }), ...sorted];
  for (const p of packages) {
    if (p.platforms.length === targets.length) p.platforms = ['all'];
  }
  return {
    part: 'desktop',
    title: 'The desktop app: Rust crates and other code linked into the Tauri binary',
    packages,
  };
}

function gradleUserHome() {
  return process.env.GRADLE_USER_HOME || join(homedir(), '.gradle');
}

/** The repositories mobile/android/build.gradle resolves from, in its order. */
const MAVEN_REPOSITORIES = ['https://dl.google.com/dl/android/maven2', 'https://repo.maven.apache.org/maven2'];

const pomCache = new Map();

/**
 * The POM for a Maven coordinate: from the Gradle cache when Gradle kept it, otherwise from
 * the repository that publishes it. Gradle keeps only its own module metadata for many
 * artifacts (every recent AndroidX and Kotlin one), and the licence is in the POM.
 */
async function readPom({ group, artifact, version }) {
  if (!group || !artifact || !version) return null;
  const key = `${group}:${artifact}:${version}`;
  if (pomCache.has(key)) return pomCache.get(key);
  let pom = null;
  const dir = join(gradleUserHome(), 'caches', 'modules-2', 'files-2.1', group, artifact, version);
  if (existsSync(dir)) {
    for (const hash of readdirSync(dir)) {
      const file = join(dir, hash, `${artifact}-${version}.pom`);
      if (existsSync(file)) pom = readFileSync(file, 'utf8');
    }
  }
  for (const repo of pom ? [] : MAVEN_REPOSITORIES) {
    const url = `${repo}/${group.replace(/\./g, '/')}/${artifact}/${version}/${artifact}-${version}.pom`;
    try {
      const response = await fetch(url);
      if (response.ok) {
        pom = await response.text();
        break;
      }
    } catch {
      // Try the next repository; an artifact found in neither is reported as unknown.
    }
  }
  pomCache.set(key, pom);
  return pom;
}

/** Licences from a POM, following <parent> POMs that hold them. */
async function pomLicensesWithParents(coord, depth = 0) {
  const pom = await readPom(coord);
  if (!pom) return { licenses: [], url: null };
  const licenses = pomLicenses(pom);
  const url = pom.match(/<scm>[\s\S]*?<url>([\s\S]*?)<\/url>/)?.[1]?.trim() ?? pom.match(/<url>([\s\S]*?)<\/url>/)?.[1]?.trim() ?? null;
  if (licenses.length || depth > 3) return { licenses, url };
  const parent = pom.match(/<parent>([\s\S]*?)<\/parent>/)?.[1];
  if (!parent) return { licenses, url };
  const get = (tag) => parent.match(new RegExp(String.raw`<${tag}>([\s\S]*?)</${tag}>`))?.[1]?.trim();
  const fromParent = await pomLicensesWithParents({ group: get('groupId'), artifact: get('artifactId'), version: get('version') }, depth + 1);
  return { licenses: fromParent.licenses, url: url ?? fromParent.url };
}

/** `gradlew -q :app:dependencies` for the release runtime classpath. */
function gradleDependencyReport() {
  const android = join(MOBILE, 'android');
  const windows = process.platform === 'win32';
  const gradlew = join(android, windows ? 'gradlew.bat' : 'gradlew');
  const result = spawnSync(windows ? `"${gradlew}"` : gradlew, ['-q', ':app:dependencies', '--configuration', 'releaseRuntimeClasspath'], {
    cwd: android,
    shell: windows,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`gradle dependencies failed:\n${result.stderr || result.stdout}`);
  return result.stdout;
}

/** The libraries in the APK: Capacitor, and the Maven artifacts Gradle resolves. */
export async function collectAndroid({ gradleDeps } = {}) {
  const packages = [];
  const lock = JSON.parse(readFileSync(join(MOBILE, 'package-lock.json'), 'utf8'));
  for (const name of ['@capacitor/android', '@capacitor/core']) {
    const entry = lock.packages[`node_modules/${name}`];
    if (!entry) continue;
    const dir = join(MOBILE, 'node_modules', name);
    const pkg = existsSync(join(dir, 'package.json')) ? JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) : {};
    packages.push({
      ecosystem: 'npm',
      name,
      version: entry.version,
      license: entry.license ?? pkg.license ?? 'unknown',
      repository: normalizeRepository(pkg.repository) ?? 'https://github.com/ionic-team/capacitor',
      holder: 'Drifty Co. (the Capacitor authors)',
      texts: licenseFilesIn(dir),
      note: name === '@capacitor/android' ? 'The native bridge and its injected JavaScript.' : 'Its runtime ships inside @capacitor/android.',
    });
  }

  const report = gradleDeps ? readFileSync(gradleDeps, 'utf8') : gradleDependencyReport();
  // A BOM only pins versions; nothing of it is in the APK.
  const coords = parseGradleDependencies(report).filter((c) => !c.artifact.endsWith('-bom'));
  const found = await Promise.all(coords.map((coord) => pomLicensesWithParents(coord)));
  coords.forEach((coord, i) => {
    const { licenses, url } = found[i];
    const ids = licenses.map(spdxForPomLicense);
    packages.push({
      ecosystem: 'maven',
      name: `${coord.group}:${coord.artifact}`,
      version: coord.version,
      license: ids.length ? [...new Set(ids)].join(' OR ') : 'unknown (no licence in its POM)',
      repository: url,
      holder: `the ${coord.artifact} authors`,
      texts: [],
    });
  });
  return {
    part: 'android',
    title: 'The Android app: libraries in the APK',
    packages,
  };
}

// ── Rendering ─────────────────────────────────────────────────────────────────

const normalize = (t) => t.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').trim();

/**
 * Render collected parts as one text file. Licence texts are written once each and referred
 * to by number; a package that ships no licence file gets the canonical text of its licence
 * (Apache-2.0 and MPL-2.0 borrowed verbatim from a package that does ship it, MIT filled in
 * with its authors), or, failing that, a pointer to the SPDX text.
 */
export function renderNotices(parts, { version = 'unknown', commit = null, requiredNotice = [] } = {}) {
  const canonical = new Map();
  for (const part of parts) {
    for (const p of part.packages) {
      for (const t of p.texts) {
        const kind = classifyLicenseText(t.text);
        if (kind && !canonical.has(kind)) canonical.set(kind, normalize(t.text));
      }
    }
  }

  const texts = new Map(); // normalized text -> { id, users: [] }
  const textId = (text, user) => {
    const key = normalize(text);
    if (!texts.has(key)) texts.set(key, { id: `T${texts.size + 1}`, users: [] });
    const entry = texts.get(key);
    if (!entry.users.includes(user)) entry.users.push(user);
    return entry.id;
  };

  const lines = [];
  const out = (s = '') => lines.push(s);
  const title = `Photo Time Machine ${version}: third-party notices`;
  out(title);
  out('='.repeat(title.length));
  out();
  out('Photo Time Machine is licensed under the PolyForm Noncommercial License 1.0.0 (LICENSE,');
  out('shipped with the app). It contains the third-party software listed below, each under its');
  out("own licence. This file was generated from the project's lockfiles by");
  out(`scripts/third-party-notices.mjs${commit ? ` at commit ${commit}` : ''}.`);
  out();
  for (const line of requiredNotice) out(line);
  if (requiredNotice.length) out();

  const all = parts.flatMap((part) => part.packages);
  const mpl = all.filter((p) => /\bMPL-2\.0\b/.test(p.license));
  if (mpl.length) {
    out('Source code for MPL-2.0 components');
    out('-----------------------------------');
    out('These components are under the Mozilla Public License 2.0 and are included unmodified.');
    out('Their source code is available from the addresses below.');
    out();
    for (const p of mpl) {
      out(`  ${p.name} ${p.version}`);
      if (p.source) out(`    ${p.source}`);
      if (p.repository) out(`    repository: ${p.repository}`);
    }
    out();
  }
  if (parts.some((part) => part.part === 'desktop')) {
    out('Linux system libraries');
    out('----------------------');
    out('On Linux the desktop app uses the WebKitGTK, GTK and related libraries (LGPL) that the');
    out('distribution installs as dependencies of the .deb or .rpm package. They are not part of');
    out('this distribution, which is why no AppImage (which would bundle them) is published.');
    out();
  }
  out('Fetched at runtime, not included');
  out('--------------------------------');
  out('Webcam head tracking downloads the MediaPipe vision runtime (WebAssembly, Apache-2.0) from');
  out('cdn.jsdelivr.net and the face landmarker model from storage.googleapis.com when it is first');
  out('switched on. The mesh viewer may fetch its Draco and KTX2 decoders from www.gstatic.com.');
  out('The processing server is a separate program; its notices are in NOTICE.md and');
  out('THIRD_PARTY.md in the source repository.');
  out();

  parts.forEach((part, i) => {
    const heading = `${i + 1}. ${part.title} (${part.packages.length})`;
    out(heading);
    out('-'.repeat(heading.length));
    out();
    for (const p of part.packages) {
      const user = `${p.name} ${p.version}`;
      const refs = [];
      if (p.texts.length) {
        for (const t of p.texts) refs.push(textId(t.text, user));
      } else {
        // No licence file in the published package. One licence is enough where the package
        // offers a choice; MIT is the shortest to reproduce, so it is taken when offered.
        const ids = spdxIds(p.license);
        const holder = p.holder ?? `the ${p.name} authors`;
        if (ids.includes('MIT')) refs.push(textId(MIT_TEXT(holder), user));
        else if (ids.some((id) => canonical.has(id))) refs.push(textId(canonical.get(ids.find((id) => canonical.has(id))), user));
        else if (ids.includes('BSD-3-Clause')) refs.push(textId(BSD3_TEXT(holder), user));
        if (ids.includes('MPL-2.0') && canonical.has('MPL-2.0') && !refs.length) refs.push(textId(canonical.get('MPL-2.0'), user));
      }
      out(`* ${p.name} ${p.version}`);
      out(`  Licence: ${p.license}`);
      if (p.repository) out(`  Source: ${p.repository}`);
      if (p.platforms && p.platforms[0] !== 'all') out(`  Platforms: ${p.platforms.join(', ')}`);
      if (p.note) out(`  ${p.note}`);
      out(
        refs.length
          ? `  Licence text: ${[...new Set(refs)].join(', ')}`
          : `  Licence text: https://spdx.org/licenses/${spdxIds(p.license)[0] ?? 'unknown'}.html`,
      );
      out();
    }
  });

  const heading = `${parts.length + 1}. Licence texts`;
  out(heading);
  out('-'.repeat(heading.length));
  for (const [text, { id, users }] of texts) {
    out();
    out(`[${id}] used by: ${users.join(', ')}`);
    out('~'.repeat(Math.min(78, 6 + id.length)));
    out(text);
  }
  out();
  return lines.join('\n');
}

/**
 * The `Required Notice:` lines from LICENSE, which PolyForm requires every copy to carry. Only
 * the preamble's: the licence text itself quotes an example notice ("Yoyodyne, Inc.").
 */
export function requiredNoticeLines(license = readFileSync(join(ROOT, 'LICENSE'), 'utf8')) {
  const lines = license.split(/\r?\n/);
  const end = lines.findIndex((l) => /^#\s/.test(l));
  return lines
    .slice(0, end < 0 ? lines.length : end)
    .map((l) => l.replace(/^>\s*/, '').trim())
    .filter((l) => l.startsWith('Required Notice:'));
}

function appVersion() {
  return JSON.parse(readFileSync(join(TAURI, 'tauri.conf.json'), 'utf8')).version;
}

function headCommit() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return null;
  }
}

function writeOut(file, text) {
  mkdirSync(dirname(resolve(file)), { recursive: true });
  writeFileSync(file, text);
}

function arg(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(argv) {
  const [command, ...args] = argv;
  const outFile = arg(args, '--out');
  const collectors = {
    viewer: () => collectViewer(),
    desktop: () => collectDesktop(),
    android: () => collectAndroid({ gradleDeps: arg(args, '--gradle-deps') }),
  };
  const render = (parts) =>
    renderNotices(parts, { version: appVersion(), commit: headCommit(), requiredNotice: requiredNoticeLines() });
  const summary = (parts) => parts.map((p) => `${p.part} ${p.packages.length}`).join(', ');

  if (command === 'collect' && collectors[args[0]] && outFile) {
    const part = await collectors[args[0]]();
    writeOut(outFile, JSON.stringify(part));
    console.log(`third-party-notices: ${args[0]}: ${part.packages.length} packages -> ${outFile}`);
  } else if (command === 'render' && outFile) {
    const files = args.filter((a, i) => a !== '--out' && args[i - 1] !== '--out');
    const parts = files.map((f) => JSON.parse(readFileSync(f, 'utf8')));
    writeOut(outFile, render(parts));
    console.log(`third-party-notices: ${summary(parts)} -> ${outFile}`);
  } else if (command === 'build' && ['desktop', 'android', 'all'].includes(args[0]) && outFile) {
    const names = { desktop: ['viewer', 'desktop'], android: ['viewer', 'android'], all: ['viewer', 'desktop', 'android'] }[args[0]];
    const parts = [];
    for (const n of names) parts.push(await collectors[n]());
    writeOut(outFile, render(parts));
    console.log(`third-party-notices: ${summary(parts)} -> ${outFile}`);
  } else {
    console.error('usage: third-party-notices.mjs collect viewer|desktop|android --out FILE [--gradle-deps FILE]');
    console.error('       third-party-notices.mjs render --out FILE PART.json...');
    console.error('       third-party-notices.mjs build desktop|android|all --out FILE');
    process.exit(2);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`third-party-notices: ${err.message}`);
    process.exit(1);
  });
}
