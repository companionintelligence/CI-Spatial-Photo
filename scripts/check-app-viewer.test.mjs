import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { appViewerProblems } from './check-app-viewer.mjs';

/** A throwaway viewer package: web-server/client with a build/ inside. */
function fixture({ html = '<html><head></head><body></body></html>', version = true, files = {} } = {}) {
  const client = mkdtempSync(join(tmpdir(), 'app-viewer-'));
  const build = join(client, 'build');
  mkdirSync(build);
  writeFileSync(join(build, 'index.html'), html);
  if (version) writeFileSync(join(build, 'version.txt'), 'abc123\n');
  for (const [name, text] of Object.entries(files)) writeFileSync(join(client, name), text);
  return { client, build, done: () => rmSync(client, { recursive: true, force: true }) };
}

test('a clean build in a clean environment is fit for the apps', () => {
  const f = fixture({ files: { '.env.development': 'BROWSER=none\n' } });
  try {
    assert.deepEqual(appViewerProblems({ build: f.build, client: f.client, env: { PATH: '/bin' } }), []);
  } finally {
    f.done();
  }
});

test('a server address or analytics ID in the environment is refused, even empty', () => {
  // Empty REACT_APP_API_BASE is not "no server": the viewer reads it as same-origin, which in
  // an app window is the app's own origin, where no server answers.
  const f = fixture();
  try {
    const problems = appViewerProblems({
      build: f.build,
      client: f.client,
      env: { REACT_APP_API_BASE: '', GA_MEASUREMENT_ID: 'G-ABC123' },
    });
    assert.equal(problems.length, 2);
    assert.match(problems.join('\n'), /REACT_APP_API_BASE/);
    assert.match(problems.join('\n'), /GA_MEASUREMENT_ID/);
  } finally {
    f.done();
  }
});

test('a .env file that feeds either variable to the build is refused', () => {
  const f = fixture({ files: { '.env.local': 'REACT_APP_API_BASE=http://localhost:8000\n' } });
  try {
    const problems = appViewerProblems({ build: f.build, client: f.client, env: {} });
    assert.deepEqual(problems, ['web-server/client/.env.local sets REACT_APP_API_BASE, which CRA reads at build time']);
  } finally {
    f.done();
  }
});

test('a build that carries the Google Analytics tag is refused', () => {
  const html = '<head><!-- ga4:start --><script async src="https://www.googletagmanager.com/gtag/js?id=G-X"></script><!-- ga4:end --></head>';
  const f = fixture({ html });
  try {
    const problems = appViewerProblems({ build: f.build, client: f.client, env: {} });
    assert.deepEqual(problems, ['index.html carries the Google Analytics tag']);
  } finally {
    f.done();
  }
});

test('a missing or unfinished build is reported, not shipped', () => {
  const f = fixture({ version: false });
  try {
    assert.match(appViewerProblems({ build: f.build, client: f.client, env: {} }).join('\n'), /version\.txt/);
    assert.match(
      appViewerProblems({ build: join(f.client, 'nope'), client: f.client, env: {} }).join('\n'),
      /index\.html is missing/,
    );
  } finally {
    f.done();
  }
});
