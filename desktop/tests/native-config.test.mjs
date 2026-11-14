// The desktop app's native configuration, pinned. Reads only committed files, so the root
// `npm test` (and CI) runs it without Rust, the Tauri CLI or a viewer build.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.join(here, '..');
const tauriDir = path.join(desktop, 'src-tauri');
const repo = path.join(desktop, '..');

const read = (p) => readFileSync(p, 'utf8');
const config = JSON.parse(read(path.join(tauriDir, 'tauri.conf.json')));
const pkg = JSON.parse(read(path.join(desktop, 'package.json')));
const cargoToml = read(path.join(tauriDir, 'Cargo.toml'));
const cargoLock = read(path.join(tauriDir, 'Cargo.lock'));
const mainRs = read(path.join(tauriDir, 'src', 'main.rs'));

/** `version = "x"` from a Cargo.toml dependency line, plain or inline-table form. */
function cargoRequirement(name) {
  const m = cargoToml.match(new RegExp(`^${name}\\s*=\\s*(?:"([^"]+)"|\\{[^}]*version\\s*=\\s*"([^"]+)")`, 'm'));
  return m ? m[1] ?? m[2] : null;
}

/** Every version Cargo.lock resolved for a crate. */
function lockedVersions(name) {
  return [...cargoLock.matchAll(/\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]+)"/g)]
    .filter((m) => m[1] === name)
    .map((m) => m[2]);
}

test('the app is Photo Time Machine 2.1.0 under its provisional identifier', () => {
  assert.equal(config.productName, 'Photo Time Machine');
  // Provisional: desktop/README.md says so. Changing it later orphans installed copies' data.
  assert.equal(config.identifier, 'computer.ci.photo');
  assert.equal(config.version, '2.1.0');
  assert.equal(pkg.version, config.version);
  assert.match(cargoToml, /^version = "2\.1\.0"$/m);
});

test('it bundles the viewer that the root `npm run build` makes, not a remote page', () => {
  assert.equal(
    path.resolve(tauriDir, config.build.frontendDist),
    path.join(repo, 'web-server', 'client', 'build'),
  );
  // The viewer is built by the root script (which unsets REACT_APP_API_BASE) and then checked
  // for a server address or an analytics tag before it is bundled.
  assert.match(pkg.scripts['build:web'], /^cd \.\. && npm run build && node scripts\/check-app-viewer\.mjs$/);
  assert.match(pkg.scripts.build, /^npm run build:web && npm run icons && tauri build$/);
  // Tauri itself never rebuilds it: the release workflow builds the viewer once and hands the
  // same files to every job.
  assert.equal(config.build.beforeBuildCommand, undefined);
  for (const window of config.app.windows) assert.equal(window.url, undefined, window.label);
});

test('no server address and no analytics ID reach the native build', () => {
  const nativeText = [JSON.stringify(config), JSON.stringify(pkg), cargoToml, mainRs].join('\n');
  for (const name of ['REACT_APP_API_BASE', 'GA_MEASUREMENT_ID']) {
    assert.doesNotMatch(nativeText, new RegExp(`${name}\\s*=`), name);
  }
});

test('the content security policy is deliberately left unset', () => {
  // Not an oversight. The only policy written for this viewer is the Worker's report-only one
  // (worker/index.js), which has never been enforced anywhere: blob: workers, WASM compilation
  // and the MediaPipe CDN would all have to be measured in WebView2, WKWebView and WebKitGTK
  // first, and getting any of them wrong breaks splats or head tracking. The app loads only its
  // own bundled files, so the policy would guard the same code the website runs without one.
  // desktop/README.md ("Content security policy") is where this changes.
  assert.equal(config.app.security.csp, null);
  assert.deepEqual(config.app.security.capabilities, ['default']);
  const capability = JSON.parse(read(path.join(tauriDir, 'capabilities', 'default.json')));
  assert.deepEqual(capability.windows, ['main']);
  assert.deepEqual(capability.permissions, ['core:default']);
});

test('links out of the app open in the system browser', () => {
  const [main] = config.app.windows;
  // Built in Rust (src/main.rs) so the link handlers can be attached to it.
  assert.equal(main.label, 'main');
  assert.equal(main.create, false);
  assert.match(mainRs, /WebviewWindowBuilder::from_config/);
  assert.match(mainRs, /\.on_navigation\(/);
  assert.match(mainRs, /\.on_new_window\(/);
  assert.match(mainRs, /\.opener\(\)\.open_url\(/);
  assert.ok(cargoRequirement('tauri-plugin-opener'), 'tauri-plugin-opener is a dependency');
});

test('the Create panel can take dropped files', () => {
  // Tauri's own drag-and-drop handler swallows file drops on Windows, and the Create panel's
  // dropzone is HTML5 drag and drop.
  assert.equal(config.app.windows[0].dragDropEnabled, false);
});

test('installers: NSIS, MSI, DMG, deb and rpm, and never an AppImage', () => {
  // An AppImage bundles WebKitGTK and GTK, which are LGPL; deb and rpm depend on the
  // distribution's copies instead.
  assert.deepEqual([...config.bundle.targets].sort(), ['app', 'deb', 'dmg', 'msi', 'nsis', 'rpm']);
  assert.ok(!JSON.stringify(config.bundle).toLowerCase().includes('appimage'));
});

test('macOS: ad hoc signed, with the camera allowed for head tracking', () => {
  // "-" is an ad hoc signature: Apple Silicon then offers "Open Anyway" rather than calling
  // the unsigned download damaged.
  assert.equal(config.bundle.macOS.signingIdentity, '-');
  const entitlements = read(path.join(tauriDir, config.bundle.macOS.entitlements));
  assert.match(entitlements, /<key>com\.apple\.security\.device\.camera<\/key>\s*<true\/>/);
  const plist = read(path.join(tauriDir, 'Info.plist'));
  assert.match(plist, /<key>NSCameraUsageDescription<\/key>/);
  assert.match(plist, /<key>NSAllowsLocalNetworking<\/key>\s*<true\/>/);
  assert.doesNotMatch(plist, /NSAllowsArbitraryLoads/);
});

test('icons are generated from the app icon with tauri icon', () => {
  assert.equal(pkg.scripts.icons, 'tauri icon ../assets/icon.svg --output src-tauri/icons');
  assert.ok(existsSync(path.join(repo, 'assets', 'icon.svg')));
  assert.deepEqual(config.bundle.icon, [
    'icons/32x32.png',
    'icons/128x128.png',
    'icons/128x128@2x.png',
    'icons/icon.icns',
    'icons/icon.ico',
  ]);
});

test('Cargo.lock is committed and resolves the versions Cargo.toml asks for', () => {
  for (const crate of ['tauri', 'tauri-build', 'tauri-plugin-opener']) {
    const wanted = cargoRequirement(crate);
    assert.ok(wanted, `${crate} is declared`);
    const locked = lockedVersions(crate);
    assert.equal(locked.length, 1, `${crate} resolves once: ${locked}`);
    // A caret requirement: same major, and at least the stated version.
    const [w, l] = [wanted, locked[0]].map((v) => v.split('.').map(Number));
    assert.equal(l[0], w[0], `${crate} ${locked[0]} vs ${wanted}`);
    assert.ok(l[1] > w[1] || (l[1] === w[1] && l[2] >= w[2]), `${crate} ${locked[0]} vs ${wanted}`);
  }
});

test('the Tauri CLI is pinned to the same minor version as the tauri crate', () => {
  const cli = pkg.devDependencies['@tauri-apps/cli'];
  assert.match(cli, /^\d+\.\d+\.\d+$/, 'an exact version');
  const [crate] = lockedVersions('tauri');
  assert.equal(cli.split('.').slice(0, 2).join('.'), crate.split('.').slice(0, 2).join('.'));
});
