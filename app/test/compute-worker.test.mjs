import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import * as core from '../public/core.mjs';

const fixtureUrl = new URL('../../gate0-reference.json', import.meta.url);
const fixture = JSON.parse(await readFile(fixtureUrl, 'utf8'));
const emitted = [];
let workerHandler;

globalThis.self = {
  addEventListener(type, handler) {
    assert.equal(type, 'message');
    workerHandler = handler;
  },
  postMessage(message) {
    emitted.push(message);
  },
};

await import('../public/compute-worker.mjs');

function runWorker(message) {
  emitted.length = 0;
  workerHandler({ data: { taskId: 'test-task', ...message } });
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      const terminal = emitted.find((entry) => entry.taskId === 'test-task' && ['result', 'error'].includes(entry.type));
      if (terminal?.type === 'error') {
        reject(new Error(terminal.error.message));
        return;
      }
      if (terminal) {
        resolve({ terminal, messages: [...emitted] });
        return;
      }
      if (Date.now() - started > 5000) {
        reject(new Error(`Timed out waiting for ${message.task} worker result`));
        return;
      }
      setTimeout(poll, 5);
    };
    poll();
  });
}

function runNodeWorkerTask(payload) {
  const matrix = new SharedArrayBuffer(payload.n * payload.n * Float32Array.BYTES_PER_ELEMENT);
  if (payload.matrix) new Float32Array(matrix).set(payload.matrix);
  const worker = new Worker(new URL('../lib/worker.mjs', import.meta.url), {
    workerData: {
      ...payload,
      matrix,
      ...(payload.task === 'dtw' ? {
        counter: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
        progress: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
      } : {}),
    },
  });
  return new Promise((resolve, reject) => {
    worker.once('message', (message) => {
      if (payload.task === 'dtw') {
        if (message.done) resolve({ message, matrix: new Float32Array(matrix) });
        else reject(new Error(`Unexpected Node worker response: ${JSON.stringify(message)}`));
      } else {
        resolve({ message, matrix: new Float32Array(matrix) });
      }
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`Node worker exited with code ${code}`));
    });
  });
}

function pairPayload(metric) {
  const inputs = fixture.selectedPairInputs;
  const n = inputs.length;
  const offsets = new Uint32Array(n + 1);
  let flat;
  let flatMid = null;
  let flatWeight = null;
  let totalLens = null;
  let aggMode = 'max';

  if (metric.startsWith('hausdorff_profile_')) {
    const segments = [];
    const mids = [];
    const weights = [];
    totalLens = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const row = inputs[i];
      const order = row.mid.map((_, index) => index).sort((a, b) => row.mid[a] - row.mid[b]);
      const total = row.seg.reduce((sum, value) => sum + value, 0);
      for (const index of order) {
        segments.push(row.seg[index]);
        mids.push(row.mid[index]);
        weights.push(total > 0 ? row.seg[index] / total : 1 / row.seg.length);
      }
      totalLens[i] = Math.max(...row.mid.map((mid, index) => mid + row.seg[index] / 2));
      offsets[i + 1] = offsets[i] + order.length;
    }
    flat = new Float64Array(segments);
    flatMid = new Float64Array(mids);
    flatWeight = new Float64Array(weights);
    aggMode = metric === 'hausdorff_profile_wmhd'
      ? 'wmhd'
      : metric === 'hausdorff_profile_quantile'
        ? 'quantile'
        : 'max';
  } else if (metric === 'hausdorff_1d') {
    const values = inputs.flatMap((row) => [...row.cum].sort((a, b) => a - b));
    inputs.forEach((row, i) => { offsets[i + 1] = offsets[i] + row.cum.length; });
    flat = new Float64Array(values);
    aggMode = 'quantile';
  } else if (metric === 'hausdorff_norm2d') {
    const xs = [];
    const ys = [];
    for (let i = 0; i < n; i++) {
      const row = inputs[i];
      const points = row.cum.map((distance, index) => ({
        x: Math.max(0, Math.min(1, distance / Math.max(row.cum.at(-1), 1e-9))),
        y: index / Math.max(1, row.cum.length - 1),
      })).sort((a, b) => a.x - b.x || a.y - b.y);
      xs.push(...points.map((point) => point.x));
      ys.push(...points.map((point) => point.y));
      offsets[i + 1] = offsets[i] + points.length;
    }
    flat = new Float64Array(ys);
    flatMid = new Float64Array(xs);
    aggMode = 'quantile';
  } else {
    inputs.forEach((row, i) => { offsets[i + 1] = offsets[i] + row.seg.length; });
    flat = new Float64Array(inputs.flatMap((row) => row.seg));
  }

  return {
    task: 'dtw',
    n,
    flat,
    flatMid,
    flatWeight,
    totalLens,
    offsets,
    metric,
    aggMode,
    posWeight: 0.25,
    quantile: 0.9,
    windowPct: 10,
    lenNorm: true,
  };
}

const closeTo = (actual, expected, tolerance = fixture.selectedPairDistances.comparisonTolerance) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);
};

test('browser worker computes all seven Gate 0 reference distances', async (t) => {
  for (const [metric, expected] of Object.entries(fixture.selectedPairDistances.values)) {
    await t.test(metric, async () => {
      const { messages } = await runWorker(pairPayload(metric));
      const row = messages.find((entry) => entry.type === 'row' && entry.row === 0);
      assert.ok(row, 'worker emits the first distance row');
      closeTo(new Float32Array(row.distances)[1], expected);
      assert.ok(messages.some((entry) => entry.type === 'progress'), 'worker emits progress');
      assert.ok(messages.some((entry) => entry.type === 'started'), 'worker announces task start');
      const node = await runNodeWorkerTask(pairPayload(metric));
      closeTo(new Float32Array(row.distances)[1], node.matrix[1]);
    });
  }
});

test('browser worker batches distance rows without changing matrix values', async () => {
  const payload = pairPayload('hausdorff_profile_wmhd');
  const { messages: singleMessages } = await runWorker(payload);
  const { terminal, messages: batchMessages } = await runWorker({ ...pairPayload('hausdorff_profile_wmhd'), rowBatchSize: 3 });
  const n = payload.n;
  const decodeMatrix = (messages) => {
    const matrix = new Float32Array(n * n);
    for (const message of messages) {
      if (message.type === 'row') {
        const values = new Float32Array(message.distances);
        for (let offset = 1; offset < values.length; offset++) {
          const column = message.row + offset;
          matrix[message.row * n + column] = values[offset];
          matrix[column * n + message.row] = values[offset];
        }
      } else if (message.type === 'rows') {
        const values = new Float32Array(message.distances);
        let offset = 0;
        for (let row = message.rowStart; row < message.rowEnd; row++) {
          for (let column = row + 1; column < n; column++) {
            const value = values[offset++];
            matrix[row * n + column] = value;
            matrix[column * n + row] = value;
          }
        }
        assert.equal(offset, values.length);
      }
    }
    return matrix;
  };

  assert.deepEqual(Array.from(decodeMatrix(batchMessages)), Array.from(decodeMatrix(singleMessages)));
  assert.equal(terminal.result.completedPairs, (n * (n - 1)) / 2);
  assert.equal(batchMessages.filter((message) => message.type === 'rows').length, Math.ceil(n / 3));
  assert.equal(batchMessages.filter((message) => message.type === 'progress').length, Math.ceil(n / 3));
});

test('browser and Node workers preserve empty-vector edge behavior', async () => {
  const payload = {
    task: 'dtw',
    n: 2,
    flat: new Float64Array([12]),
    offsets: new Uint32Array([0, 0, 1]),
    metric: 'hausdorff_1d',
    aggMode: 'max',
  };
  const { messages } = await runWorker(payload);
  const row = messages.find((entry) => entry.type === 'row' && entry.row === 0);
  const node = await runNodeWorkerTask(payload);
  assert.equal(new Float32Array(row.distances)[1], Infinity);
  assert.equal(node.matrix[1], Infinity);
});

test('browser worker MDS output matches the shared core implementation', async () => {
  const distances = new Float32Array([0, 2, 2, 0]);
  const expected = core.mds2d(distances, 2);
  const { terminal } = await runWorker({ task: 'mds', n: 2, matrix: distances });
  const node = await runNodeWorkerTask({ task: 'mds', n: 2, matrix: distances });
  assert.deepEqual(Array.from(terminal.result.xy), Array.from(expected.xy));
  assert.deepEqual(Array.from(terminal.result.coordinates), Array.from(expected.coordinates));
  assert.deepEqual(Array.from(terminal.result.xy), Array.from(node.message.xy));
  assert.deepEqual(terminal.result.mdsInfo.eigenvalues, expected.eigenvalues);
  assert.deepEqual(terminal.result.mdsInfo, node.message.mdsInfo);
  assert.deepEqual(terminal.result.qs, core.distanceQuantiles(distances, 2, [0.005, 0.01, 0.02, 0.05, 0.1, 0.25, 0.5]));
  assert.deepEqual(terminal.result.qs, node.message.qs);
});

test('multidimensional MDS preserves leading axes and reports projected explained variance and correlations', async () => {
  const n = 4;
  const distances = new Float32Array([
    0, 1, 2, 3,
    1, 0, 1, 2,
    2, 1, 0, 1,
    3, 2, 1, 0,
  ]);
  const features = new Float64Array([
    1, 1, 2, 0,
    2, 2, 3, 1,
    3, 3, 4, 4,
    4, 4, 5, 9,
  ]);
  const expected = core.mds(distances, n, 4);
  const { terminal } = await runWorker({ task: 'mds', n, dimensions: 4, matrix: distances, features });
  const node = await runNodeWorkerTask({ task: 'mds', n, dimensions: 4, matrix: distances, features });
  assert.deepEqual(Array.from(terminal.result.coordinates), Array.from(expected.coordinates));
  assert.deepEqual(Array.from(terminal.result.xy), Array.from(expected.xy));
  assert.deepEqual(terminal.result.mdsInfo.explainedVariance, expected.explainedVariance);
  assert.deepEqual(terminal.result.mdsInfo.correlations, core.mdsFeatureCorrelations(expected.coordinates, 4, features, n));
  assert.deepEqual(terminal.result.coordinates, node.message.coordinates);
  assert.deepEqual(terminal.result.mdsInfo, node.message.mdsInfo);
  assert.ok(Math.abs(terminal.result.mdsInfo.cumulativeExplainedVariance[0] - 1) < 1e-10);
  assert.equal(terminal.result.mdsInfo.fullSpectrum, true);
});

test('MDS explained variance handles a two-axis Euclidean configuration', () => {
  const equilateral = new Float64Array([
    0, 1, 1,
    1, 0, 1,
    1, 1, 0,
  ]);
  const result = core.mds(equilateral, 3, 4);
  assert.ok(Math.abs(result.explainedVariance[0] - 0.5) < 1e-10);
  assert.ok(Math.abs(result.explainedVariance[1] - 0.5) < 1e-10);
  assert.equal(result.cumulativeExplainedVariance[1], 1);
  assert.equal(result.fullSpectrum, true);
});

test('MDS-feature correlations report Pearson and tie-aware Spearman values', () => {
  const coords = new Float32Array([1, 4, 2, 3, 3, 2, 4, 1]);
  const features = new Float64Array([
    10, 0, 4, 7,
    20, 1, 4, 7,
    30, 2, 4, 8,
    40, 3, 4, 8,
  ]);
  const result = core.mdsFeatureCorrelations(coords, 2, features, 4);
  assert.equal(result.find((entry) => entry.axis === 0 && entry.feature === 0).pearson, 1);
  assert.equal(result.find((entry) => entry.axis === 1 && entry.feature === 0).spearman, -1);
  assert.equal(result.find((entry) => entry.axis === 0 && entry.feature === 2).pearson, null);
  assert.equal(result.find((entry) => entry.axis === 0 && entry.feature === 0).count, 4);
});

test('browser worker runs hierarchical, k-medoids, and DBSCAN clustering', async (t) => {
  const matrix = new Float32Array([
    0, 1, 10, 11,
    1, 0, 9, 10,
    10, 9, 0, 1,
    11, 10, 1, 0,
  ]);

  for (const params of [
    { algo: 'hierarchical', linkage: 'average', k: 2, auto: false },
    { algo: 'kmedoids', k: 2, auto: false },
    { algo: 'dbscan', eps: 2, minPts: 2 },
  ]) {
    await t.test(params.algo, async () => {
      const { terminal } = await runWorker({ task: 'cluster', n: 4, matrix, params });
      const node = await runNodeWorkerTask({ task: 'cluster', n: 4, matrix, params });
      const result = terminal.result;
      assert.deepEqual(Array.from(result.labels), Array.from(node.message.labels));
      assert.deepEqual(Array.from(result.medoids), Array.from(node.message.medoids));
      assert.equal(result.silhouette, node.message.silhouette);
      assert.equal(result.k, 2);
      assert.deepEqual(Array.from(result.labels).slice(0, 2), [0, 0]);
      assert.deepEqual(Array.from(result.labels).slice(2), [1, 1]);
      assert.equal(result.sizes.reduce((sum, size) => sum + size, 0), 4);
      assert.equal(result.noise, 0);
      assert.ok(Number.isFinite(result.silhouette));
    });
  }
});

test('DBSCAN rejects invalid matrix shape, radius, and neighbor count', () => {
  const matrix = new Float32Array([0, 1, 1, 0]);
  assert.throws(() => core.dbscan(new Float32Array(3), 2, 1, 1), /matrix must contain n \* n distances/);
  assert.throws(() => core.dbscan(matrix, 2, -1, 1), /eps must be finite and non-negative/);
  assert.throws(() => core.dbscan(matrix, 2, Number.NaN, 1), /eps must be finite and non-negative/);
  assert.throws(() => core.dbscan(matrix, 2, 1, 0), /minPts must be a positive integer/);
  assert.throws(() => core.dbscan(matrix, 2, 1, 1.5), /minPts must be a positive integer/);
});

test('hierarchical worker supports height and divisive information cuts without 2D projection input', async (t) => {
  const n = 4;
  const matrix = new Float32Array([
    0, 1, 10, 11,
    1, 0, 9, 10,
    10, 9, 0, 1,
    11, 10, 1, 0,
  ]);
  const features = new Float64Array([
    1, 1, 1, 1,
    1, 1, 1, 1,
    10, 10, 10, 10,
    10, 10, 10, 10,
  ]);
  for (const params of [
    { algo: 'hierarchical', linkage: 'average', cutMode: 'h', cutH: 1.5 },
    { algo: 'hierarchical', linkage: 'average', cutMode: 'info-k', k: 3 },
    { algo: 'hierarchical', linkage: 'average', cutMode: 'info-tau', cutTau: 0.01 },
    { algo: 'hierarchical', linkage: 'average', cutMode: 'info-frac', cutFrac: 0.9 },
  ]) {
    await t.test(params.cutMode, async () => {
      const { terminal } = await runWorker({ task: 'cluster', n, matrix, params, features });
      const node = await runNodeWorkerTask({ task: 'cluster', n, matrix, params, features });
      assert.deepEqual(Array.from(terminal.result.labels), Array.from(node.message.labels));
      assert.deepEqual(Array.from(terminal.result.cutNodes), Array.from(node.message.cutNodes));
      assert.equal(terminal.result.merges.a.length, n - 1);
      assert.equal(terminal.result.k, params.cutMode === 'info-k' ? 3 : 2);
      if (params.cutMode !== 'info-k') {
        const labels = terminal.result.labels;
        assert.equal(labels[0], labels[1]);
        assert.equal(labels[2], labels[3]);
        assert.notEqual(labels[0], labels[2]);
      }
      if (params.cutMode.startsWith('info-')) {
        assert.ok(Math.abs(terminal.result.information.total - 1) < 1e-10);
        assert.equal(terminal.result.information.preservedFraction, 1);
        assert.deepEqual(terminal.result.information, node.message.information);
      }
    });
  }
});

test('tree cuts by height honor boundaries and retain the corresponding active nodes', () => {
  const merges = {
    a: new Int32Array([0, 2, 4]),
    b: new Int32Array([1, 3, 5]),
    h: new Float64Array([1, 2, 10]),
  };
  assert.equal(new Set(core.cutTreeAtHeight(merges, 4, 0).labels).size, 4);
  const atOne = core.cutTreeAtHeight(merges, 4, 1);
  assert.equal(new Set(atOne.labels).size, 3);
  assert.deepEqual(Array.from(atOne.clusters).sort((left, right) => left - right), [2, 3, 4]);
  assert.equal(new Set(core.cutTreeAtHeight(merges, 4, 2).labels).size, 2);
  assert.equal(new Set(core.cutTreeAtHeight(merges, 4, 10).labels).size, 1);
});

test('height-ordered linkage cuts and k-range cuts retain a topologically valid dendrogram', () => {
  const matrix = new Float32Array([
    0, 1, 10, 11,
    1, 0, 9, 10,
    10, 9, 0, 1,
    11, 10, 1, 0,
  ]);
  for (const linkage of ['average', 'complete', 'single']) {
    const merges = core.hierarchical(matrix, 4, linkage);
    assert.ok(Array.from(merges.h).every((height, index, heights) => index === 0 || heights[index - 1] <= height));
    for (let merge = 0; merge < merges.a.length; merge++) {
      assert.ok(merges.a[merge] < 4 + merge);
      assert.ok(merges.b[merge] < 4 + merge);
    }
    const cuts = new Map();
    core.cutTreeRange(merges, 4, 2, 4, (k, labels) => cuts.set(k, labels));
    for (let k = 2; k <= 4; k++) {
      assert.deepEqual(Array.from(cuts.get(k)), Array.from(core.cutTree(merges, 4, k)));
    }
  }
});

test('k-medoids clusters a precomputed metric from more than two input dimensions', () => {
  const points = [
    [0, 0, 0, 0],
    [0, 0, 0, 1],
    [0, 0, 100, 0],
    [0, 0, 100, 1],
  ];
  const distances = new Float32Array(points.length ** 2);
  for (let left = 0; left < points.length; left++) {
    for (let right = 0; right < points.length; right++) {
      distances[left * points.length + right] = Math.sqrt(
        points[left].reduce((sum, value, dimension) => sum + (value - points[right][dimension]) ** 2, 0)
      );
    }
  }
  const result = core.kMedoids(distances, points.length, 2);
  assert.equal(result.labels[0], result.labels[1]);
  assert.equal(result.labels[2], result.labels[3]);
  assert.notEqual(result.labels[0], result.labels[2]);
});

test('divisive information cuts satisfy entropy identities, stop rules, and missing-data validation', () => {
  const merges = {
    a: new Int32Array([0, 2, 4]),
    b: new Int32Array([1, 3, 5]),
    h: new Float64Array([1, 1, 10]),
  };
  const features = new Float64Array([
    0, 0, 0, 0,
    0, 0, 0, 0,
    100, 100, 100, 100,
    100, 100, 100, 100,
  ]);
  const byTau = core.divisiveInformationCut(merges, 4, features, { tau: 0.01 });
  const byFraction = core.divisiveInformationCut(merges, 4, features, { frac: 0.9 });
  const byK = core.divisiveInformationCut(merges, 4, features, { k: 3 });
  const byGain = core.divisiveInformationCut(merges, 4, features, { k: 3, criterion: 'gain' });
  assert.ok(Math.abs(byTau.information.total - 1) < 1e-10);
  assert.equal(byTau.information.explained + byTau.information.inner, byTau.information.total);
  assert.equal(new Set(byTau.labels).size, 2);
  assert.equal(byFraction.information.preservedFraction, 1);
  assert.equal(new Set(byFraction.labels).size, 2);
  assert.equal(new Set(byK.labels).size, 3);
  assert.equal(new Set(byGain.labels).size, 3);
  assert.equal(byGain.information.criterion, 'gain');
  assert.ok(byTau.information.maxActiveInner <= 0.01);
  assert.throws(() => core.divisiveInformationCut(merges, 4, features, {}), /stopping condition/);
  const missing = features.slice();
  missing[0] = Number.NaN;
  assert.throws(() => core.divisiveInformationCut(merges, 4, missing, { tau: 0 }), /missing or non-finite/);
});

test('browser worker reports invalid tasks and malformed inputs explicitly', async () => {
  await assert.rejects(runWorker({ task: 'unknown-task' }), /Unsupported worker task/);
  await assert.rejects(runWorker({ ...pairPayload('hausdorff_profile_wmhd'), rowBatchSize: 65 }), /rowBatchSize/);
  await assert.rejects(
    runWorker({ task: 'dtw', n: 2, flat: new Float64Array([1, 2]), offsets: new Uint32Array([0, 1]) }),
    /offsets must contain n \+ 1 entries/
  );
});
