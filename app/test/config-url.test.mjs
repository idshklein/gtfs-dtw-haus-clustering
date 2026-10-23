import test from 'node:test';
import assert from 'node:assert/strict';
import { createShareUrl, MAX_SHARE_URL_LENGTH, parseShareConfig } from '../public/config-url.mjs';

const defaults = {
  unit: 'route',
  feature: 'seg',
  metric: 'hausdorff_profile_wmhd',
  posWeight: 0.25,
  quantilePct: 90,
  normalize: 'none',
  agencyIds: [],
  routeTypes: [],
  minLen: 0,
  windowPct: 10,
  workers: 4,
  computeBackend: 'cpu',
  lenNorm: true,
  search: '',
  algo: 'hierarchical',
  linkage: 'complete',
  cutMode: 'info-k',
  cutH: 0,
  cutTau: 0.01,
  cutFrac: 0.9,
  mdsDims: 6,
  auto: false,
  k: 20,
  kMin: 3,
  kMax: 15,
  eps: '',
  minPts: 4,
};

const options = {
  defaults,
  agencyIds: ['22', '25'],
  routeTypes: ['2', '3'],
  maxWorkers: 8,
};

test('default share config selects hierarchical information cut with k=20', () => {
  const parsed = parseShareConfig('', options);

  assert.equal(parsed.hasConfig, false);
  assert.equal(parsed.config.algo, 'hierarchical');
  assert.equal(parsed.config.linkage, 'complete');
  assert.equal(parsed.config.cutMode, 'info-k');
  assert.equal(parsed.config.k, 20);
});

test('share URL round-trips supported filters, calculation, and clustering settings', () => {
  const config = {
    ...defaults,
    unit: 'pattern',
    feature: 'cum',
    metric: 'hausdorff_profile_quantile',
    posWeight: 0.75,
    quantilePct: 95,
    normalize: 'log',
    agencyIds: ['22', '25'],
    routeTypes: ['2'],
    minLen: 12,
    windowPct: 20,
    workers: 6,
    computeBackend: 'webgpu',
    lenNorm: false,
    search: 'פתח תקווה & מרכז',
    algo: 'hierarchical',
    linkage: 'complete',
    cutMode: 'info-frac',
    cutH: 3.25,
    cutTau: 0.05,
    cutFrac: 0.75,
    mdsDims: 8,
    auto: true,
    k: 9,
    kMin: 4,
    kMax: 12,
    eps: 0.75,
    minPts: 5,
  };
  const url = createShareUrl('https://example.test/app?old=secret#result', config);
  const parsed = parseShareConfig(new URL(url).search, options);

  assert.equal(parsed.hasConfig, true);
  assert.deepEqual(parsed.warnings, []);
  assert.deepEqual(parsed.config, config);
  assert.equal(url.includes('secret'), false);
  assert.equal(url.includes('#'), false);
  assert.ok(url.length <= MAX_SHARE_URL_LENGTH);
});

test('share links validate new MDS and hierarchical cut settings', () => {
  const parsed = parseShareConfig(
    '?v=1&mdsDims=10&cutMode=h&cutH=2.5&cutTau=0.04&cutFrac=0.8',
    options
  );
  assert.equal(parsed.config.mdsDims, 10);
  assert.equal(parsed.config.cutMode, 'h');
  assert.equal(parsed.config.cutH, 2.5);
  assert.equal(parsed.config.cutTau, 0.04);
  assert.equal(parsed.config.cutFrac, 0.8);
  assert.deepEqual(parsed.warnings, []);

  const invalid = parseShareConfig('?v=1&mdsDims=11&cutMode=unknown&cutFrac=1.1', options);
  assert.equal(invalid.config.mdsDims, defaults.mdsDims);
  assert.equal(invalid.config.cutMode, defaults.cutMode);
  assert.equal(invalid.config.cutFrac, defaults.cutFrac);
  assert.equal(invalid.warnings.length, 3);
});

test('invalid fields and unknown parameters are reported and never activated', () => {
  const parsed = parseShareConfig(
    '?v=1&metric=unknown&workers=999&agency=not-real&routeType=999&extra=value',
    options
  );

  assert.equal(parsed.config.metric, defaults.metric);
  assert.equal(parsed.config.workers, defaults.workers);
  assert.deepEqual(parsed.config.agencyIds, defaults.agencyIds);
  assert.deepEqual(parsed.config.routeTypes, defaults.routeTypes);
  assert.equal(parsed.warnings.length, 5);
});

test('valid zero-valued parameters are preserved', () => {
  const parsed = parseShareConfig('?v=1&lambda=0&windowPct=0&minLen=0', options);
  assert.equal(parsed.config.posWeight, 0);
  assert.equal(parsed.config.windowPct, 0);
  assert.equal(parsed.config.minLen, 0);
  assert.deepEqual(parsed.warnings, []);
});

test('share links round-trip and validate the optional compute backend', () => {
  const shared = parseShareConfig('?v=1&backend=webgpu', options);
  assert.equal(shared.config.computeBackend, 'webgpu');
  assert.deepEqual(shared.warnings, []);

  const invalid = parseShareConfig('?v=1&backend=unknown', options);
  assert.equal(invalid.config.computeBackend, 'cpu');
  assert.equal(invalid.warnings.length, 1);
});

test('unsupported version and duplicate singleton parameters use defaults with warnings', () => {
  const unsupported = parseShareConfig('?v=2&unit=pattern', options);
  assert.equal(unsupported.config.unit, defaults.unit);
  assert.ok(unsupported.warnings.some((warning) => warning.includes('גרסת קישור')));

  const duplicate = parseShareConfig('?v=1&unit=route&unit=pattern', options);
  assert.equal(duplicate.config.unit, defaults.unit);
  assert.ok(duplicate.warnings.some((warning) => warning.includes('יותר מפעם אחת')));
});

test('oversized query strings are rejected without partially applying settings', () => {
  const oversized = `?${'x'.repeat(MAX_SHARE_URL_LENGTH + 1)}`;
  const parsed = parseShareConfig(oversized, options);
  assert.equal(parsed.config.unit, defaults.unit);
  assert.ok(parsed.warnings.some((warning) => warning.includes('ארוך מהמותר')));

  const longUrl = parseShareConfig('?v=1&unit=pattern', options, MAX_SHARE_URL_LENGTH + 1);
  assert.equal(longUrl.config.unit, defaults.unit);
  assert.ok(longUrl.warnings.some((warning) => warning.includes('ארוך מהמותר')));
});

test('share links reject invalid values and excessive URL length', () => {
  assert.throws(
    () => createShareUrl('https://example.test/app', { ...defaults, workers: Number.NaN }),
    /ערך מספרי לא תקין/
  );
  assert.throws(
    () => createShareUrl('https://example.test/app', { ...defaults, agencyIds: Array(300).fill('1234567890') }),
    /ארוך מדי/
  );
});
