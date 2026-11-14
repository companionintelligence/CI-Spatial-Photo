// The Android app's native configuration, pinned. Reads only committed files, so the root
// `npm test` (and CI) runs it without Capacitor, Gradle or a viewer build.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mobile = path.join(here, '..');
const android = path.join(mobile, 'android');
const app = path.join(android, 'app');
const res = path.join(app, 'src', 'main', 'res');

const read = (...p) => readFileSync(path.join(...p), 'utf8');
const config = read(mobile, 'capacitor.config.ts');
const pkg = JSON.parse(read(mobile, 'package.json'));
const gradle = read(app, 'build.gradle');
const manifest = read(app, 'src', 'main', 'AndroidManifest.xml');
const variables = read(android, 'variables.gradle');

/** Width and height of a PNG, from its IHDR chunk. */
function pngSize(file) {
  const b = readFileSync(file);
  assert.equal(b.toString('ascii', 1, 4), 'PNG', `${file} is a PNG`);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

/** The `<uses-permission>` names in the manifest. */
const permissions = [...manifest.matchAll(/<uses-permission\s+android:name="([^"]+)"/g)].map((m) => m[1]);

test('the app is Photo Time Machine 2.1.0, com.companionintelligence.photo', () => {
  assert.match(config, /appId:\s*'com\.companionintelligence\.photo'/);
  assert.match(config, /appName:\s*'Photo Time Machine'/);
  assert.match(gradle, /namespace = "com\.companionintelligence\.photo"/);
  assert.match(gradle, /applicationId "com\.companionintelligence\.photo"/);
  assert.match(gradle, /versionCode 210\b/);
  assert.match(gradle, /versionName "2\.1\.0"/);
  assert.equal(pkg.version, '2.1.0');
  assert.match(read(res, 'values', 'strings.xml'), /<string name="app_name">Photo Time Machine<\/string>/);
  // The Java package follows the app id.
  assert.ok(existsSync(path.join(app, 'src', 'main', 'java', 'com', 'companionintelligence', 'photo', 'MainActivity.java')));
});

test('it ships a copy of the viewer build and no remote page', () => {
  assert.match(config, /webDir:\s*'www'/);
  assert.doesNotMatch(config, /\burl:/);
  assert.doesNotMatch(config, /allowNavigation/);
  assert.equal(pkg.scripts['build:web'], 'cd .. && npm run build');
  assert.equal(pkg.scripts['copy:web'], 'node scripts/copy-web.mjs');
  // The copy is checked for a server address and the analytics tag before it is made.
  assert.match(read(mobile, 'scripts', 'copy-web.mjs'), /appViewerProblems/);
});

test('scheme and cleartext: an http://localhost page that can reach a plain-HTTP server', () => {
  // mobile/README.md, "Scheme and cleartext", has the reasoning.
  assert.match(config, /androidScheme:\s*'http'/);
  assert.match(config, /cleartext:\s*true/);
  assert.match(manifest, /android:usesCleartextTraffic="true"/);
  // No mixed-content override: there is nothing to mix on an http:// page, and the setting
  // would matter if the scheme ever went back to https.
  assert.match(config, /allowMixedContent:\s*false/);
  // fetch stays the WebView's own, so the server's CORS allowlist means what it does on the web.
  assert.match(config, /CapacitorHttp:\s*\{\s*enabled:\s*false\s*\}/);
  assert.match(config, /zoomEnabled:\s*true/);
});

test('permissions: the network, and the camera for head tracking', () => {
  assert.deepEqual(permissions.sort(), ['android.permission.CAMERA', 'android.permission.INTERNET']);
  assert.match(manifest, /<uses-feature android:name="android\.hardware\.camera" android:required="false" \/>/);
  assert.match(manifest, /android:allowBackup="false"/);
  assert.doesNotMatch(manifest, /android:debuggable/);
});

test('release builds are not debuggable and are signed only from the environment', () => {
  assert.match(gradle, /release \{\s*debuggable false/);
  for (const name of ['ANDROID_KEYSTORE_FILE', 'ANDROID_KEYSTORE_PASSWORD', 'ANDROID_KEY_ALIAS', 'ANDROID_KEY_PASSWORD']) {
    assert.match(gradle, new RegExp(`System\\.getenv\\('${name}'\\)`), name);
  }
  assert.match(gradle, /if \(releaseSigningSet\) \{\s*signingConfig signingConfigs\.release/);
  // No key material, password or keystore path in the project.
  assert.doesNotMatch(gradle, /storePassword\s+['"]/);
  assert.doesNotMatch(gradle, /keystore\.properties/);
  const keyFiles = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (['node_modules', 'build', '.gradle', 'www'].includes(entry)) continue;
      const p = path.join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(jks|keystore|p12)$/i.test(entry)) keyFiles.push(p);
    }
  };
  walk(mobile);
  assert.deepEqual(keyFiles, []);
});

test('targets Android 16 (API 36) and runs from Android 7 (API 24)', () => {
  assert.match(variables, /minSdkVersion = 24\b/);
  assert.match(variables, /compileSdkVersion = 36\b/);
  assert.match(variables, /targetSdkVersion = 36\b/);
});

test('Capacitor 8, Android only', () => {
  for (const name of ['@capacitor/android', '@capacitor/core']) assert.match(pkg.dependencies[name], /^\^8\./, name);
  assert.match(pkg.devDependencies['@capacitor/cli'], /^\^8\./);
  assert.equal(pkg.dependencies['@capacitor/ios'], undefined);
  assert.ok(!existsSync(path.join(mobile, 'ios')), 'iOS is out of scope');
});

/*
  The PNGs Capacitor 8.6's Android template ships (its logo on white, and a blank launch
  screen), by the first 16 hex digits of their SHA-256. None of them may survive: the launcher
  icons and launch screens are drawn from assets/icon.svg by scripts/native-art.mjs.
*/
const CAPACITOR_PLACEHOLDERS = new Set(
  ('0166fc333074c373 07fa579e1c83e04b 08cc34ad7713fe7e 0c7f1212f25b7b90 1ee4cd9ff371dcb2 22f87e1e3bc89aa0 ' +
    '27ed3603010ebc27 32baa10d2632a441 3db071a03b2f8ffe 40911a0092286868 42aa26392546fcde 4a82bc1e99235762 ' +
    '58e78a618778926b 5cf98b4451bd99b2 60393ce8636fd263 6f88083b8166cc55 72b71c3581ca3b5a 87cb2f2ffe992652 ' +
    'ab93096331e7cd8e b73049cb37fe76d6 bd24fd383253bf8d bfcc1b0fa931b14b c5015f4ba3628392 d35dbfff175b83c1 ' +
    'ed346eb1e3f0280f').split(' '),
);

const DENSITY = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };

test('launcher icons are drawn from the app icon, at every density', () => {
  for (const [density, factor] of Object.entries(DENSITY)) {
    const dir = path.join(res, `mipmap-${density}`);
    for (const [name, dp] of [
      ['ic_launcher', 48],
      ['ic_launcher_round', 48],
      ['ic_launcher_foreground', 108],
      ['ic_launcher_background', 108],
    ]) {
      const file = path.join(dir, `${name}.png`);
      const px = Math.round(dp * factor);
      assert.deepEqual(pngSize(file), [px, px], `${density}/${name}`);
    }
  }
  for (const name of ['ic_launcher', 'ic_launcher_round']) {
    const xml = read(res, 'mipmap-anydpi-v26', `${name}.xml`);
    assert.match(xml, /<background android:drawable="@mipmap\/ic_launcher_background"\/>/);
    assert.match(xml, /<foreground android:drawable="@mipmap\/ic_launcher_foreground"\/>/);
  }
  // The template's vector placeholders are gone, not just unreferenced.
  assert.ok(!existsSync(path.join(res, 'drawable', 'ic_launcher_background.xml')));
  assert.ok(!existsSync(path.join(res, 'drawable-v24', 'ic_launcher_foreground.xml')));
});

test('launch screens are the app icon on the viewer ground colour', () => {
  const sizes = {
    drawable: [480, 320],
    'drawable-port-mdpi': [320, 480],
    'drawable-port-hdpi': [480, 800],
    'drawable-port-xhdpi': [720, 1280],
    'drawable-port-xxhdpi': [960, 1600],
    'drawable-port-xxxhdpi': [1280, 1920],
    'drawable-land-mdpi': [480, 320],
    'drawable-land-hdpi': [800, 480],
    'drawable-land-xhdpi': [1280, 720],
    'drawable-land-xxhdpi': [1600, 960],
    'drawable-land-xxxhdpi': [1920, 1280],
  };
  for (const [dir, size] of Object.entries(sizes)) {
    assert.deepEqual(pngSize(path.join(res, dir, 'splash.png')), size, dir);
  }
  assert.match(read(res, 'values', 'styles.xml'), /<item name="windowSplashScreenBackground">#041620<\/item>/);
  assert.match(config, /backgroundColor:\s*'#041620'/);
});

test("no PNG in the Android project is one of Capacitor's placeholders", () => {
  const pngs = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const p = path.join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (entry.endsWith('.png')) pngs.push(p);
    }
  };
  walk(res);
  assert.ok(pngs.length >= 31, `${pngs.length} PNGs`);
  for (const file of pngs) {
    const digest = createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16);
    assert.ok(!CAPACITOR_PLACEHOLDERS.has(digest), `${path.relative(res, file)} is a Capacitor placeholder`);
  }
});

test('build outputs and generated files stay out of git', () => {
  const ignore = read(android, '.gitignore');
  for (const entry of ['build/', 'app/src/main/assets/public', 'capacitor-cordova-android-plugins', 'local.properties']) {
    assert.ok(ignore.includes(entry), entry);
  }
  const mobileIgnore = read(mobile, '.gitignore');
  for (const entry of ['node_modules/', 'www/', '*.jks', '*.keystore']) assert.ok(mobileIgnore.includes(entry), entry);
});
