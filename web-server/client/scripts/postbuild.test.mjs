// `npm test` from the repo root runs these (node's built-in runner).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import vm from 'node:vm';
import { gaBlock, gaInitSource, injectGa, readMeasurementId, stripGa, versionLine } from './postbuild.mjs';

const PAGE = '<!doctype html><html><head><title>t</title></head><body><div id="root"></div></body></html>';
const ID = 'G-TEST123456';

describe('readMeasurementId', () => {
  it('accepts a G- ID from either variable, and nothing else', () => {
    assert.equal(readMeasurementId({ GA_MEASUREMENT_ID: ID }), ID);
    assert.equal(readMeasurementId({ REACT_APP_GA_MEASUREMENT_ID: ID }), ID);
    assert.equal(readMeasurementId({ GA_MEASUREMENT_ID: `  ${ID}\n` }), ID);
    for (const bad of ['', 'UA-12345-1', 'g-lowercase', 'G-', 'G-ab cd', '<script>', 'G-ABC"><script>']) {
      assert.equal(readMeasurementId({ GA_MEASUREMENT_ID: bad }), '', JSON.stringify(bad));
    }
    assert.equal(readMeasurementId({}), '');
  });
});

describe('injectGa', () => {
  it('adds the loader and the init once, just before </head>', () => {
    const out = injectGa(PAGE, ID);
    assert.equal(out.split('googletagmanager.com/gtag/js').length - 1, 1);
    assert.ok(out.includes(`gtag/js?id=${ID}`));
    assert.ok(out.includes('<script src="/ga-init.js"></script>'));
    assert.ok(out.indexOf('ga4:start') < out.indexOf('</head>'));
  });

  it('is idempotent: injecting twice, or over an old tag, leaves one tag', () => {
    const once = injectGa(PAGE, ID);
    assert.equal(injectGa(once, ID), once);
    const swapped = injectGa(once, 'G-OTHER99999');
    assert.equal(swapped.split('googletagmanager.com/gtag/js').length - 1, 1);
    assert.ok(swapped.includes('G-OTHER99999'));
    assert.ok(!swapped.includes(ID));
  });

  it('removes a previous tag when the ID goes away, and leaves a clean page alone', () => {
    assert.equal(injectGa(injectGa(PAGE, ID), ''), PAGE);
    assert.equal(injectGa(PAGE, ''), PAGE);
  });

  it('refuses a page it cannot place the tag in', () => {
    assert.throws(() => injectGa('<html></html>', ID), /no <\/head>/);
  });

  it('stripGa tolerates an unterminated block rather than eating the page', () => {
    const broken = PAGE.replace('</head>', '<!-- ga4:start --></head>');
    assert.equal(stripGa(broken), broken);
  });

  it('keeps the block out of inline-script territory: both scripts are external', () => {
    const block = gaBlock(ID);
    assert.equal((block.match(/<script/g) || []).length, 2);
    assert.equal((block.match(/<script[^>]*src=/g) || []).length, 2);
  });
});

/** Run ga-init.js the way a browser does: `window` is the global, so a bare `dataLayer` works. */
function runInit(src, location) {
  const sandbox = { location };
  sandbox.window = sandbox;
  vm.runInNewContext(src, sandbox);
  return [...sandbox.dataLayer].map((entry) => [...entry]);
}

describe('gaInitSource', () => {
  it('configures the ID and redacts the asset id from the reported path', () => {
    const src = gaInitSource(ID);
    assert.ok(src.includes(`'${ID}'`));
    const layer = runInit(src, { pathname: '/view/a_7989c36d0900288d', origin: 'https://photo.ci.computer' });
    const config = layer.find((entry) => entry[0] === 'config');
    assert.equal(config[1], ID);
    // Through JSON: the object comes from another realm (the vm context), and strict deep
    // equality compares prototypes.
    assert.deepEqual(JSON.parse(JSON.stringify(config[2])), {
      page_path: '/view/:id',
      page_location: 'https://photo.ci.computer/view/:id',
    });
    // The id must not appear anywhere in what would be sent.
    assert.ok(!JSON.stringify(layer).includes('7989c36d'));
  });

  it('leaves the home page path alone', () => {
    const layer = runInit(gaInitSource(ID), { pathname: '/', origin: 'https://photo.ci.computer' });
    const config = layer.find((entry) => entry[0] === 'config');
    assert.equal(config[2].page_path, '/');
    assert.equal(config[2].page_location, 'https://photo.ci.computer/');
  });
});

describe('versionLine', () => {
  it('uses GITHUB_SHA when CI provides it, and never calls a CI build dirty', () => {
    assert.equal(versionLine({ GITHUB_SHA: 'abc123' }, '/'), 'abc123\n');
  });

  it('degrades to "unknown" outside a git checkout instead of failing the build', () => {
    assert.equal(versionLine({}, '/'), 'unknown\n');
  });
});
