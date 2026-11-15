import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyLicenseText,
  linkedCrates,
  lockKeysForSource,
  normalizeRepository,
  parseGradleDependencies,
  pomLicenses,
  renderNotices,
  requiredNoticeLines,
  spdxForPomLicense,
  spdxIds,
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

test('rendering without the desktop part leaves out the Linux note', () => {
  const text = renderNotices([{ part: 'viewer', title: 'Viewer', packages: [] }]);
  assert.doesNotMatch(text, /AppImage/);
  assert.doesNotMatch(text, /MPL-2\.0 components/);
});
