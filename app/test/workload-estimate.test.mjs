import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateWorkload, MEMORY_WARNING_BYTES } from '../public/workload-estimate.mjs';

test('estimates exact pair and Float32 matrix sizes', () => {
  const estimate = estimateWorkload({
    n: 6,
    maxVectorLength: 10,
    metric: 'hausdorff_1d',
    workers: 1,
  });

  assert.equal(estimate.pairs, 15);
  assert.equal(estimate.matrixBytes, 6 * 6 * Float32Array.BYTES_PER_ELEMENT);
  assert.equal(estimate.warning, false);
});

test('accounts for extra profile buffers and per-worker input copies', () => {
  const base = estimateWorkload({
    n: 100,
    maxVectorLength: 40,
    metric: 'hausdorff_1d',
    workers: 1,
  });
  const profile = estimateWorkload({
    n: 100,
    maxVectorLength: 40,
    metric: 'hausdorff_profile_wmhd',
    workers: 2,
  });

  assert.equal(profile.workerInputBytes, base.workerInputBytes * 6);
  assert.ok(profile.knownBufferBytes > base.knownBufferBytes);
});

test('accounts for additional MDS dimensions and rejects unsupported dimensionality', () => {
  const two = estimateWorkload({ n: 100, maxVectorLength: 40, metric: 'dtw', workers: 1, mdsDimensions: 2 });
  const eight = estimateWorkload({ n: 100, maxVectorLength: 40, metric: 'dtw', workers: 1, mdsDimensions: 8 });
  assert.ok(eight.mdsBytes > two.mdsBytes);
  assert.throws(
    () => estimateWorkload({ n: 100, maxVectorLength: 40, metric: 'dtw', workers: 1, mdsDimensions: 11 }),
    /mdsDimensions must not exceed 10/
  );
});

test('flags jobs that use at least half of the baseline tab-memory target', () => {
  const estimate = estimateWorkload({
    n: 20_000,
    maxVectorLength: 160,
    metric: 'hausdorff_profile_wmhd',
    workers: 2,
  });

  assert.ok(estimate.knownBufferBytes >= MEMORY_WARNING_BYTES);
  assert.equal(estimate.warning, true);
});

test('rejects invalid sizes instead of returning a misleading estimate', () => {
  assert.throws(() => estimateWorkload({
    n: -1,
    maxVectorLength: 10,
    metric: 'dtw',
    workers: 1,
  }), /n must be/);
  assert.throws(() => estimateWorkload({
    n: 1,
    maxVectorLength: 10,
    metric: 'dtw',
    workers: 0,
  }), /workers must be/);
});
