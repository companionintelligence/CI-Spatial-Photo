import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyLicenseText,
  linkedCrates,
  lockKeysForSource,
  nonCrateCode,
  normalizeRepository,
  parseGradleDependencies,
  peFileVersion,
  pomLicenses,
  renderNotices,
  requiredNoticeLines,
  spdxForPomLicense,
  spdxIds,
  WEBVIEW2_SDK_LICENSE,
} from './third-party-notices.mjs';

test('repository fields become plain https URLs', () => {
  assert.equal(normalizeRepository('git+https://github.com/lit/lit.git'), 'https://github.com/lit/lit');
  assert.equal(normalizeRepository({ type: 'git', url: 'git://github.com/a/b.git' }), 'https://github.com/a/b');
  assert.equal(normalizeRepository('git@github.com:a/b.git'), 'https://github.com/a/b');
  assert.equal(normalizeRepository('github:a/b'), 'https://github.com/a/b');
  assert.equal(normalizeRepository('a/b'), 'https://github.com/a/b');
  assert.equal(normalizeRepository('https://github.com/soc/option-ext.git'), 'https://github.com/soc/option-ext');
  assert.equal(normalizeRepository(undefined), null);
  assert.equal(normalizeRepository('not a url'), null);
});

test('a bundled source belongs to the installed package that owns it', () => {
  const keys = new Set([
    'node_modules/react',
    'node_modules/react-dom',
    'node_modules/@sparkjsdev/spark',
    'node_modules/fflate',
    'node_modules/a',
    'node_modules/a/node_modules/b',
  ]);
  assert.deepEqual(lockKeysForSource('../node_modules/react/cjs/react.production.min.js', keys), ['node_modules/react']);
  // The longest key wins, so react-dom is not mistaken for react.
  assert.deepEqual(lockKeysForSource('../node_modules/react-dom/index.js', keys), ['node_modules/react-dom']);
  // A nested install is its own package and version.
  assert.deepEqual(lockKeysForSource('../node_modules/a/node_modules/b/x.js', keys), ['node_modules/a/node_modules/b']);
  // A published build that embeds another package (Spark ships fflate in its own bundle) names
  // both, the embedded one by its top-level lockfile entry.
  assert.deepEqual(
    lockKeysForSource('../node_modules/@sparkjsdev/spark/node_modules/fflate/esm/browser.js', keys),
    ['node_modules/@sparkjsdev/spark', 'node_modules/fflate'],
  );
  // webpack's annotated module ids are cut at the first `|`.
  assert.deepEqual(lockKeysForSource('../node_modules/react|lazy|strict namespace object', keys), ['node_modules/react']);
  // The app's own sources, and paths no installed package owns, belong to nothing.
  assert.deepEqual(lockKeysForSource('utils/plyCamera.js', keys), []);
  assert.deepEqual(lockKeysForSource('../node_modules/shared/src/utils.ts', keys), []);
});

test('the release runtime classpath is read from the Gradle report', () => {
  const report = [
    'releaseRuntimeClasspath - Runtime classpath of /release.',
    '+--- androidx.appcompat:appcompat:1.7.1',
    '|    +--- androidx.activity:activity:1.8.0 -> 1.11.0',
    '|    |    \\--- androidx.annotation:annotation:1.8.1 (*)',
    '|    \\--- org.jetbrains.kotlin:kotlin-stdlib:1.8.22 -> 2.0.21 (c)',
    '+--- project :capacitor-android',
    '|    \\--- org.jetbrains.kotlinx:kotlinx-coroutines-bom:1.8.1',
    '\\--- org.jetbrains.kotlin:kotlin-stdlib -> 2.0.21',
    '     \\--- androidx.webkit:webkit:{strictly 1.14.0} -> 1.14.0 (n)',
  ].join('\n');
  assert.deepEqual(parseGradleDependencies(report), [
    { group: 'androidx.activity', artifact: 'activity', version: '1.11.0' },
    { group: 'androidx.annotation', artifact: 'annotation', version: '1.8.1' },
    { group: 'androidx.appcompat', artifact: 'appcompat', version: '1.7.1' },
    { group: 'org.jetbrains.kotlin', artifact: 'kotlin-stdlib', version: '2.0.21' },
    { group: 'org.jetbrains.kotlinx', artifact: 'kotlinx-coroutines-bom', version: '1.8.1' },
  ]);
});

test('POM licence names map to SPDX ids', () => {
  const pom = `<project><licenses><license><name>The Apache Software License, Version 2.0</name>
    <url>http://www.apache.org/licenses/LICENSE-2.0.txt</url></license></licenses></project>`;
  const licenses = pomLicenses(pom);
  assert.deepEqual(licenses, [{ name: 'The Apache Software License, Version 2.0', url: 'http://www.apache.org/licenses/LICENSE-2.0.txt' }]);
  assert.equal(spdxForPomLicense(licenses[0]), 'Apache-2.0');
  assert.equal(spdxForPomLicense({ name: 'MIT License', url: '' }), 'MIT');
  assert.equal(spdxForPomLicense({ name: 'Something Else', url: '' }), 'Something Else');
  assert.deepEqual(pomLicenses('<project/>'), []);
});

test('SPDX expressions split into their ids', () => {
  assert.deepEqual(spdxIds('MIT OR Apache-2.0'), ['MIT', 'Apache-2.0']);
  assert.deepEqual(spdxIds('(MIT OR Apache-2.0) AND Unicode-3.0'), ['MIT', 'Apache-2.0', 'Unicode-3.0']);
  assert.deepEqual(spdxIds('MIT/Apache-2.0'), ['MIT', 'Apache-2.0']);
  assert.deepEqual(spdxIds('Apache-2.0 WITH LLVM-exception'), ['Apache-2.0', 'LLVM-exception']);
});

const APACHE = `Apache License
Version 2.0, January 2004
http://www.apache.org/licenses/

TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION
1. Definitions.`;
const MPL = `Mozilla Public License Version 2.0
==================================
1. Definitions
--------------`;

test('full Apache-2.0 and MPL-2.0 texts are recognised, short notices are not', () => {
  assert.equal(classifyLicenseText(APACHE), 'Apache-2.0');
  assert.equal(classifyLicenseText(MPL), 'MPL-2.0');
  assert.equal(classifyLicenseText('Licensed under the Apache License, Version 2.0'), null);
  assert.equal(classifyLicenseText('MIT License\n\nCopyright (c) someone'), null);
});

test("only the licence preamble's Required Notice lines are carried", () => {
  const license = [
    '> Photo Time Machine uses the PolyForm Noncommercial License 1.0.0.',
    '>',
    '> Required Notice: Copyright Example Org (https://example.org)',
    '',
    '# PolyForm Noncommercial License 1.0.0',
    '',
    '> Required Notice: Copyright Yoyodyne, Inc. (http://example.com)',
  ].join('\n');
  assert.deepEqual(requiredNoticeLines(license), ['Required Notice: Copyright Example Org (https://example.org)']);
});

test('the linked crates are the normal-dependency closure of the app', () => {
  const metadata = {
    packages: ['app', 'tauri', 'serde', 'tauri-build', 'cc', 'proptest'].map((n) => ({ id: n, name: n })),
    resolve: {
      root: 'app',
      nodes: [
        {
          id: 'app',
          deps: [
            { pkg: 'tauri', dep_kinds: [{ kind: null }] },
            { pkg: 'tauri-build', dep_kinds: [{ kind: 'build' }] },
            { pkg: 'proptest', dep_kinds: [{ kind: 'dev' }] },
          ],
        },
        { id: 'tauri', deps: [{ pkg: 'serde', dep_kinds: [{ kind: null }] }] },
        { id: 'tauri-build', deps: [{ pkg: 'cc', dep_kinds: [{ kind: null }] }] },
      ],
    },
  };
  // Build and dev dependencies, and what only they pull in, are not in the binary.
  assert.deepEqual(linkedCrates(metadata).map((p) => p.name).sort(), ['serde', 'tauri']);
});

test('rendering: one copy of each text, MPL sources up front, and a text for every package', () => {
  const parts = [
    {
      part: 'viewer',
      title: 'Viewer',
      packages: [
        { ecosystem: 'npm', name: 'model-viewer', version: '4.3.1', license: 'Apache-2.0', repository: 'https://example.org/mv', texts: [{ label: 'LICENSE', text: APACHE }] },
        // Ships no licence file: the Apache text above is borrowed rather than a URL.
        { ecosystem: 'npm', name: 'tasks-vision', version: '0.10.35', license: 'Apache-2.0', repository: null, texts: [] },
      ],
    },
    {
      part: 'desktop',
      title: 'Desktop',
      packages: [
        { ecosystem: 'crates.io', name: 'cssparser', version: '0.37.0', license: 'MPL-2.0', repository: 'https://example.org/css', source: 'https://crates.io/crates/cssparser/0.37.0', platforms: ['all'], texts: [{ label: 'LICENSE', text: MPL }] },
        // MIT with no file: the MIT text is written out with its authors.
        { ecosystem: 'crates.io', name: 'objc2', version: '0.6.5', license: 'MIT', holder: 'Mads Marquart', repository: null, platforms: ['aarch64-apple-darwin'], texts: [] },
      ],
    },
  ];
  const text = renderNotices(parts, { version: '9.9.9', commit: 'abc123', requiredNotice: ['Required Notice: Copyright Example Org'] });

  assert.match(text, /^Photo Time Machine 9\.9\.9: third-party notices$/m);
  assert.match(text, /at commit abc123\./);
  assert.match(text, /^Required Notice: Copyright Example Org$/m);
  // The MPL-2.0 source pointer comes before the package lists.
  assert.ok(text.indexOf('Source code for MPL-2.0 components') < text.indexOf('1. Viewer'));
  assert.match(text, /cssparser 0\.37\.0\n {4}https:\/\/crates\.io\/crates\/cssparser\/0\.37\.0/);
  assert.match(text, /no AppImage/);
  // The Apache text appears once and serves both packages.
  assert.equal(text.split('Version 2.0, January 2004').length - 1, 1);
  assert.match(text, /\[T1\] used by: model-viewer 4\.3\.1, tasks-vision 0\.10\.35/);
  assert.match(text, /Copyright \(c\) Mads Marquart/);
  assert.match(text, /Platforms: aarch64-apple-darwin/);
  assert.doesNotMatch(text, /spdx\.org/);
});

test("a Windows DLL's file version is read from its VS_FIXEDFILEINFO", () => {
  // dwSignature, dwStrucVersion, dwFileVersionMS, dwFileVersionLS, little-endian.
  const info = Buffer.alloc(16);
  info.writeUInt32LE(0xfeef04bd, 0);
  info.writeUInt32LE(0x00010000, 4);
  info.writeUInt32LE((1 << 16) | 0, 8);
  info.writeUInt32LE((3800 << 16) | 47, 12);
  assert.equal(peFileVersion(Buffer.concat([Buffer.from('MZ and the rest of the file'), info])), '1.0.3800.47');
  assert.equal(peFileVersion(Buffer.from('MZ with no version resource')), null);
});

const DESKTOP = ['x86_64-pc-windows-msvc', 'aarch64-apple-darwin', 'x86_64-unknown-linux-gnu'];
const WEBVIEW2_COM_SYS = { name: 'webview2-com-sys', version: '0.39.1', platforms: ['x86_64-pc-windows-msvc'] };
const SDK = new Map([['0.39.1', '1.0.3800.47']]);

test('the desktop part also names the standard library and the WebView2 loader the binary links', () => {
  const crates = [WEBVIEW2_COM_SYS, { name: 'serde', version: '1.0.228', platforms: DESKTOP }];
  const [std, loader, ...more] = nonCrateCode(crates, { targets: DESKTOP, rustVersion: '1.96.0', webview2Sdk: SDK });
  assert.deepEqual(more, []);

  assert.equal(std.name, 'Rust standard library (core, alloc, std)');
  assert.equal(std.version, '1.96.0');
  assert.equal(std.license, 'MIT OR Apache-2.0');
  assert.deepEqual(std.platforms, DESKTOP);

  // webview2-com-sys links Microsoft's loader statically on MSVC; its own MIT licence covers
  // only the bindings, so the loader is credited separately with Microsoft's licence.
  assert.equal(loader.name, 'Microsoft WebView2 SDK loader (WebView2LoaderStatic.lib)');
  assert.equal(loader.version, '1.0.3800.47');
  assert.deepEqual(loader.platforms, ['x86_64-pc-windows-msvc']);
  assert.equal(loader.repository, 'https://www.nuget.org/packages/Microsoft.Web.WebView2/1.0.3800.47');
  assert.match(loader.note, /inside webview2-com-sys 0\.39\.1/);
  assert.deepEqual(loader.texts.map((t) => t.text), [WEBVIEW2_SDK_LICENSE]);
  assert.match(WEBVIEW2_SDK_LICENSE, /^Copyright \(C\) Microsoft Corporation\. All rights reserved\.\n/);
  assert.match(WEBVIEW2_SDK_LICENSE, /Redistributions in binary form must reproduce the above\ncopyright notice/);

  // With no webview2-com-sys on an MSVC target, no loader is linked and none is listed.
  const withoutIt = nonCrateCode([{ name: 'serde', version: '1.0.228', platforms: DESKTOP }], { targets: DESKTOP });
  assert.deepEqual(withoutIt.map((p) => p.name), ['Rust standard library (core, alloc, std)']);
  const gnuOnly = nonCrateCode([{ ...WEBVIEW2_COM_SYS, platforms: ['x86_64-pc-windows-gnu'] }], { targets: DESKTOP });
  assert.equal(gnuOnly.length, 1);

  // An SDK version that cannot be read still credits the loader, by the crate it comes in.
  const [, unread] = nonCrateCode([WEBVIEW2_COM_SYS], { targets: DESKTOP });
  assert.equal(unread.version, 'from webview2-com-sys 0.39.1');
  assert.equal(unread.repository, 'https://www.nuget.org/packages/Microsoft.Web.WebView2');
  assert.equal(nonCrateCode([], { targets: DESKTOP })[0].version, 'unknown');
});

test("rendering carries Microsoft's notice for the WebView2 loader and the standard library's MIT text", () => {
  const packages = nonCrateCode([WEBVIEW2_COM_SYS], { targets: DESKTOP, rustVersion: '1.96.0', webview2Sdk: SDK });
  const text = renderNotices([{ part: 'desktop', title: 'Desktop', packages }]);

  const entry = text.match(
    new RegExp(
      [
        String.raw`^\* Microsoft WebView2 SDK loader \(WebView2LoaderStatic\.lib\) 1\.0\.3800\.47`,
        String.raw`  Licence: WebView2 SDK licence \(BSD-style\)`,
        String.raw`  Source: https://www\.nuget\.org/packages/Microsoft\.Web\.WebView2/1\.0\.3800\.47`,
        String.raw`  Platforms: x86_64-pc-windows-msvc`,
        String.raw`  Statically linked into the Windows binary\. .*`,
        String.raw`  Licence text: (T\d+)$`,
      ].join('\n'),
      'm',
    ),
  );
  assert.ok(entry, 'the loader is listed with its version, licence, source, platform and a licence text');
  // Microsoft's notice, conditions and disclaimer, in full, under that number.
  const used = `[${entry[1]}] used by: Microsoft WebView2 SDK loader (WebView2LoaderStatic.lib) 1.0.3800.47\n`;
  assert.ok(text.includes(used));
  assert.ok(text.slice(text.indexOf(used)).includes(WEBVIEW2_SDK_LICENSE.trim()));

  assert.match(text, /^\* Rust standard library \(core, alloc, std\) 1\.96\.0\n  Licence: MIT OR Apache-2\.0$/m);
  assert.match(text, /^Copyright \(c\) The Rust Project Developers$/m);
});

test('rendering without the desktop part leaves out the Linux note', () => {
  const text = renderNotices([{ part: 'viewer', title: 'Viewer', packages: [] }]);
  assert.doesNotMatch(text, /AppImage/);
  assert.doesNotMatch(text, /MPL-2\.0 components/);
});
