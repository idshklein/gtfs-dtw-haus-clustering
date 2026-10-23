import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserAppService, buildSampleBuffers, deriveBaseFeatures } from '../public/browser-service.mjs';

const config = {
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
  workers: 1,
  computeBackend: 'cpu',
  lenNorm: true,
  mdsDims: 6,
};

const rows = [
  {
    sample_id: 'route-1',
    route_id: 'route-1',
    route_short_name: '1',
    route_long_name: 'Route One',
    route_desc: '',
    agency_name: 'Agency',
    route_type: 3,
    n_patterns: 1,
    n_trips: 2,
    n: 2,
    vec: [10, 20],
    seg: [10, 20],
    cum: [0, 10, 30],
    mid: [5, 20],
    seg_lengths: [2],
    cum_lengths: [3],
  },
  {
    sample_id: 'route-2',
    route_id: 'route-2',
    route_short_name: '2',
    route_long_name: 'Route Two',
    route_desc: '',
    agency_name: 'Agency',
    route_type: 3,
    n_patterns: 1,
    n_trips: 1,
    n: 2,
    vec: [11, 19],
    seg: [11, 19],
    cum: [0, 11, 30],
    mid: [5.5, 20.5],
    seg_lengths: [2],
    cum_lengths: [3],
  },
  {
    sample_id: 'route-3',
    route_id: 'route-3',
    route_short_name: '3',
    route_long_name: 'Route Three',
    route_desc: '',
    agency_name: 'Agency',
    route_type: 3,
    n_patterns: 1,
    n_trips: 1,
    n: 2,
    vec: [12, 18],
    seg: [12, 18],
    cum: [0, 12, 30],
    mid: [6, 21],
    seg_lengths: [2],
    cum_lengths: [3],
  },
];

class FakeWorker {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type, event) {
    for (const listener of this.listeners.get(type) || []) listener(event);
  }

  postMessage(message) {
    queueMicrotask(() => {
      if (message.task === 'dtw') {
        const distances = [];
        let completedPairs = 0;
        for (let row = message.rowStart; row < message.rowEnd; row++) {
          for (let column = row + 1; column < message.n; column++) {
            distances.push(Math.abs(row - column));
            completedPairs++;
          }
        }
        this.emit('message', {
          data: {
            taskId: message.taskId,
            type: 'rows',
            rowStart: message.rowStart,
            rowEnd: message.rowEnd,
            distances: Float32Array.from(distances).buffer,
          },
        });
        this.emit('message', {
          data: {
            taskId: message.taskId,
            type: 'progress',
            completedPairs,
            totalPairs: (message.n * (message.n - 1)) / 2,
          },
        });
        this.emit('message', {
          data: {
            taskId: message.taskId,
            type: 'result',
            result: { completedPairs, totalPairs: (message.n * (message.n - 1)) / 2 },
          },
        });
      } else if (message.task === 'mds') {
        const dimensions = message.dimensions ?? 2;
        this.emit('message', {
          data: {
            taskId: message.taskId,
            type: 'result',
            result: {
              xy: new Float32Array(message.n * 2),
              coordinates: new Float32Array(message.n * dimensions),
              qs: [1, 2, 3],
              mdsInfo: {
                axisRatio: 0.5,
                dimensions,
                explainedVariance: Array(dimensions).fill(1 / dimensions),
                cumulativeExplainedVariance: Array.from({ length: dimensions }, (_, i) => (i + 1) / dimensions),
                fullSpectrum: true,
                correlations: [],
              },
            },
          },
        });
      } else if (message.task === 'cluster') {
        this.emit('message', {
          data: {
            taskId: message.taskId,
            type: 'result',
            result: {
              k: 2,
              labels: new Int32Array([0, 0, 1]),
              medoids: new Int32Array([0, 2]),
              sizes: [2, 1],
              noise: 0,
              silhouette: 0.25,
              silhouetteByCluster: [0.5, 0],
              silCurve: null,
            },
          },
        });
      }
    });
  }

  terminate() {
    this.terminated = true;
  }
}

function createService(dataClient = {}) {
  return new BrowserAppService({
    dataClient: {
      meta: { counts: { routes: 3 }, agencies: [], routeTypes: [] },
      listSamples: async (filters) => ({ total: 3, rows, filters }),
      loadSamples: async () => rows,
      getSample: async (unit, feature, id) => ({ unit, feature, sample_id: id }),
      getVectors: async (unit, feature, ids) => ids.map((sample_id) => ({ sample_id, unit, feature, vec: [1, 2] })),
      getMapLines: async (unit, samples) => samples.map((sample) => ({ ...sample, unit })),
      ...dataClient,
    },
    maxWorkers: 2,
    workerFactory: () => new FakeWorker(),
  });
}

test('buildSampleBuffers creates sorted WMHD buffers and preserves per-route weights', () => {
  const buffers = buildSampleBuffers(rows.slice(0, 2), config);
  assert.deepEqual(Array.from(new Uint32Array(buffers.offsets)), [0, 2, 4]);
  assert.deepEqual(Array.from(new Float64Array(buffers.flat)), [10, 20, 11, 19]);
  assert.deepEqual(Array.from(new Float64Array(buffers.flatMid)), [5, 20, 5.5, 20.5]);
  assert.ok(Math.abs(new Float64Array(buffers.flatWeight)[0] - 1 / 3) < 1e-12);
  assert.ok(Math.abs(new Float64Array(buffers.flatWeight)[1] - 2 / 3) < 1e-12);
  assert.deepEqual(Array.from(new Float64Array(buffers.totalLens)), [30, 30]);
});

test('base line features summarize pattern-level stops, length, mean spacing, and population variance', () => {
  const features = deriveBaseFeatures([
    { seg: [10, 20, 30, 50], seg_lengths: [2, 2] },
    { seg: [], seg_lengths: [0] },
  ]);
  assert.deepEqual(Array.from(features.slice(0, 4)), [3, 55, 27.5, 218.75]);
  assert.equal(features[4], 1);
  assert.equal(features[5], 0);
  assert.ok(Number.isNaN(features[6]));
  assert.ok(Number.isNaN(features[7]));
});

test('browser service dispatches data, computation, clustering, vectors, and map requests locally', async () => {
  const service = createService();
  service.setMeta(service.dataClient.meta);

  assert.equal((await service.request('/api/meta')).cores, 2);
  assert.equal((await service.request('/api/samples', { unit: 'pattern', search: 'מרכז' })).filters.unit, 'pattern');
  assert.equal((await service.request('/api/sample?id=route-1')).sample_id, 'route-1');

  await service.request('/api/dtw', { ...config, workers: 1 });
  let status;
  do {
    await new Promise((resolve) => setTimeout(resolve, 0));
    status = await service.request('/api/status');
  } while (['loading', 'dtw', 'mds'].includes(status.status));

  assert.equal(status.status, 'done');
  assert.equal(status.n, 3);
  assert.equal(status.backend, 'cpu');
  assert.equal(status.mdsDimensions, 6);
  assert.equal(status.coordinates.length, 3 * 6);
  assert.equal(status.features.length, 3 * 4);
  assert.equal(service.current.matrix[1], 1);
  assert.deepEqual((await service.request('/api/cluster', { algo: 'kmedoids', k: 2 })).labels, [0, 0, 1]);
  await assert.rejects(
    service.request('/api/cluster', { algo: 'dbscan', eps: -1, minPts: 2 }),
    /eps must be finite and non-negative/
  );
  await assert.rejects(
    service.request('/api/cluster', { algo: 'dbscan', eps: 1, minPts: 0 }),
    /minPts must be an integer at least 1/
  );
  assert.equal((await service.request('/api/vectors', { ids: ['route-1'] }))[0].sample_id, 'route-1');
  assert.equal((await service.request('/api/map-lines', { samples: [{ sample_id: 'route-1', cluster: 0 }] }))[0].unit, 'route');
});

test('unsupported WebGPU metrics fall back to CPU and expose the reason', async () => {
  const service = createService();
  service.setMeta(service.dataClient.meta);
  await service.request('/api/dtw', { ...config, metric: 'dtw', computeBackend: 'webgpu' });
  let status;
  do {
    await new Promise((resolve) => setTimeout(resolve, 0));
    status = await service.request('/api/status');
  } while (['loading', 'dtw', 'mds'].includes(status.status));

  assert.equal(status.status, 'done');
  assert.equal(status.backend, 'cpu');
  assert.match(status.notice, /רק למדד WMHD/);
});

test('unavailable WebGPU falls back to CPU and reports the failure', async () => {
  const service = createService();
  service.setMeta(service.dataClient.meta);
  await service.request('/api/dtw', { ...config, computeBackend: 'webgpu' });
  let status;
  do {
    await new Promise((resolve) => setTimeout(resolve, 0));
    status = await service.request('/api/status');
  } while (['loading', 'dtw', 'mds'].includes(status.status));

  assert.equal(status.status, 'done');
  assert.equal(status.backend, 'cpu');
  assert.match(status.notice, /WebGPU נכשל/);
});

test('cancelling a computation prevents delayed sample loading from starting workers', async () => {
  let finishLoading;
  const service = createService({
    loadSamples: () => new Promise((resolve) => { finishLoading = resolve; }),
  });
  service.setMeta(service.dataClient.meta);
  await service.request('/api/dtw', config);
  service.cancelDtw();
  finishLoading(rows);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal((await service.request('/api/status')).status, 'cancelled');
});
