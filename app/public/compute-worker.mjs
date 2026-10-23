import * as core from './core.mjs';

const METRICS = new Set([
  'hausdorff_profile_wmhd',
  'hausdorff_profile_quantile',
  'hausdorff_profile_max',
  'hausdorff_1d',
  'hausdorff_norm2d',
  'frechet',
  'dtw',
]);

const view = (value, Type, name) => {
  if (value instanceof Type) return value;
  if (value instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer)) {
    return new Type(value);
  }
  throw new TypeError(`${name} must be an ${Type.name} or buffer`);
};

const progress = (taskId, values) => self.postMessage({ taskId, type: 'progress', ...values });

async function runDtw(taskId, w) {
  const n = Number(w.n);
  if (!Number.isInteger(n) || n < 1) throw new RangeError('n must be a positive integer');
  const data = view(w.flat, Float64Array, 'flat');
  const offsets = view(w.offsets, Uint32Array, 'offsets');
  if (offsets.length !== n + 1) throw new RangeError('offsets must contain n + 1 entries');
  if (offsets[n] > data.length) throw new RangeError('offsets exceed the flat data length');

  const metric = w.metric || 'dtw';
  if (!METRICS.has(metric)) throw new RangeError(`Unsupported distance metric: ${metric}`);
  const midData = w.flatMid == null ? null : view(w.flatMid, Float64Array, 'flatMid');
  const weightData = w.flatWeight == null ? null : view(w.flatWeight, Float64Array, 'flatWeight');
  const totalLens = w.totalLens == null ? null : view(w.totalLens, Float64Array, 'totalLens');
  if (metric.startsWith('hausdorff_profile_') && (!midData || !weightData || !totalLens)) {
    throw new TypeError('Spacing-profile metrics require flatMid, flatWeight, and totalLens');
  }
  if (metric === 'hausdorff_norm2d' && !midData) throw new TypeError('hausdorff_norm2d requires flatMid');
  const rowStart = w.rowStart == null ? 0 : Number(w.rowStart);
  const rowEnd = w.rowEnd == null ? n : Number(w.rowEnd);
  if (!Number.isInteger(rowStart) || !Number.isInteger(rowEnd) || rowStart < 0 || rowEnd < rowStart || rowEnd > n) {
    throw new RangeError('rowStart and rowEnd must define a valid half-open row range');
  }
  const rowBatchSize = w.rowBatchSize == null ? 1 : Number(w.rowBatchSize);
  if (!Number.isSafeInteger(rowBatchSize) || rowBatchSize < 1 || rowBatchSize > 64) {
    throw new RangeError('rowBatchSize must be an integer between 1 and 64');
  }

  let maxLen = 0;
  for (let i = 0; i < n; i++) maxLen = Math.max(maxLen, offsets[i + 1] - offsets[i]);
  const scratchA = new Float64Array(maxLen + 1);
  const scratchB = new Float64Array(maxLen + 1);
  const totalPairs = (n * (n - 1)) / 2;
  let completedPairs = 0;

  for (let batchStart = rowStart; batchStart < rowEnd;) {
    const batchEnd = Math.min(rowEnd, batchStart + rowBatchSize);
    let batchPairCount = 0;
    for (let row = batchStart; row < batchEnd; row++) batchPairCount += n - row - 1;
    const batchDistances = rowBatchSize === 1 ? null : new Float32Array(batchPairCount);
    let batchOffset = 0;

    for (let i = batchStart; i < batchEnd; i++) {
      const aOff = offsets[i];
      const aLen = offsets[i + 1] - aOff;
      const distances = batchDistances ? null : new Float32Array(n - i);
      for (let j = i + 1; j < n; j++) {
        const bOff = offsets[j];
        const bLen = offsets[j + 1] - bOff;
        let distance;
        if (metric.startsWith('hausdorff_profile_')) {
          const aggMode = metric === 'hausdorff_profile_wmhd'
            ? 'wmhd'
            : metric === 'hausdorff_profile_quantile'
              ? 'quantile'
              : 'max';
          distance = core.hausdorffSpacingProfile(
            data,
            midData,
            weightData,
            totalLens,
            i,
            j,
            aOff,
            aLen,
            bOff,
            bLen,
            Number.isFinite(w.posWeight) ? w.posWeight : 0.25,
            aggMode,
            Number.isFinite(w.quantile) ? w.quantile : 0.9,
            scratchA,
            scratchB
          );
        } else if (metric === 'hausdorff_1d') {
          distance = core.hausdorff1DCum(
            data,
            aOff,
            aLen,
            bOff,
            bLen,
            w.aggMode || 'max',
            Number.isFinite(w.quantile) ? w.quantile : 0.9,
            scratchA
          );
        } else if (metric === 'hausdorff_norm2d') {
          distance = core.hausdorffNorm2D(
            midData,
            data,
            aOff,
            aLen,
            bOff,
            bLen,
            w.aggMode || 'max',
            Number.isFinite(w.quantile) ? w.quantile : 0.9,
            scratchA
          );
        } else if (metric === 'frechet') {
          distance = core.discreteFrechet(data, aOff, aLen, bOff, bLen, w.windowPct, scratchA, scratchB);
        } else {
          distance = core.dtw(data, aOff, aLen, bOff, bLen, w.windowPct, w.lenNorm, scratchA, scratchB);
        }
        if (batchDistances) batchDistances[batchOffset++] = distance;
        else distances[j - i] = distance;
      }

      if (distances) self.postMessage({ taskId, type: 'row', row: i, distances: distances.buffer }, [distances.buffer]);
      completedPairs += n - i - 1;
      if (rowBatchSize === 1) progress(taskId, { completedPairs, totalPairs, row: i });
      if ((i - rowStart + 1) % 8 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    }

    if (batchDistances) {
      self.postMessage(
        { taskId, type: 'rows', rowStart: batchStart, rowEnd: batchEnd, distances: batchDistances.buffer },
        [batchDistances.buffer]
      );
      progress(taskId, { completedPairs, totalPairs, row: batchEnd - 1 });
    }
    batchStart = batchEnd;
  }
  self.postMessage({ taskId, type: 'result', result: { rowStart, rowEnd, completedPairs, totalPairs } });
}

function runMds(taskId, w) {
  const n = Number(w.n);
  const matrix = view(w.matrix, Float32Array, 'matrix');
  if (!Number.isInteger(n) || n < 1 || matrix.length !== n * n) throw new RangeError('matrix must contain n * n distances');
  progress(taskId, { phase: 'mds', completed: 0, total: 1 });
  const dimensions = Number(w.dimensions ?? 2);
  const result = core.mds(matrix, n, dimensions);
  const features = w.features == null ? null : view(w.features, Float64Array, 'features');
  const correlations = features
    ? core.mdsFeatureCorrelations(result.coordinates, result.dimensions, features, n)
    : [];
  const qs = core.distanceQuantiles(matrix, n, [0.005, 0.01, 0.02, 0.05, 0.1, 0.25, 0.5]);
  progress(taskId, { phase: 'mds', completed: 1, total: 1 });
  const { xy, coordinates, ...mdsInfo } = result;
  mdsInfo.correlations = correlations;
  const transfer = [...new Set([xy.buffer, coordinates.buffer])];
  self.postMessage(
    { taskId, type: 'result', result: { xy, coordinates, qs, mdsInfo } },
    transfer
  );
}

function runCluster(taskId, w) {
  const n = Number(w.n);
  const matrix = view(w.matrix, Float32Array, 'matrix');
  if (!Number.isInteger(n) || n < 1 || matrix.length !== n * n) throw new RangeError('matrix must contain n * n distances');
  const p = w.params || {};
  let labels;
  let k = 0;
  let medoids = null;
  let merges = w.merges || null;
  let silCurve = null;
  let cutNodes = null;
  let cutHeight = null;
  let information = null;
  const out = {};

  if (p.algo === 'hierarchical') {
    if (!merges) {
      merges = core.hierarchical(matrix, n, p.linkage, (value) => progress(taskId, { phase: 'hierarchical', progress: value }));
    }
    if (p.cutMode === 'h') {
      cutHeight = Number(p.cutH);
      const cut = core.cutTreeAtHeight(merges, n, cutHeight);
      labels = cut.labels;
      cutNodes = cut.clusters;
    } else if (typeof p.cutMode === 'string' && p.cutMode.startsWith('info-')) {
      const stop = p.cutMode === 'info-k'
        ? { k: Math.max(1, Math.min(p.k, n)) }
        : p.cutMode === 'info-tau' ? { tau: Number(p.cutTau) } : { frac: Number(p.cutFrac) };
      const cut = core.divisiveInformationCut(merges, n, view(w.features, Float64Array, 'features'), stop);
      labels = cut.labels;
      cutNodes = cut.clusters;
      information = cut.information;
    } else if (p.auto) {
      silCurve = [];
      let best = { s: -Infinity, k: 0, labels: null };
      core.cutTreeRange(merges, n, p.kMin, Math.min(p.kMax, n), (kk, lab) => {
        const s = core.silhouette(matrix, n, lab, kk).mean;
        silCurve.push({ k: kk, silhouette: s });
        if (s > best.s) best = { s, k: kk, labels: lab };
      });
      silCurve.reverse();
      labels = best.labels;
      k = best.k;
    } else {
      k = Math.max(1, Math.min(p.k, n));
      labels = core.cutTree(merges, n, k);
    }
    k = new Set(labels).size;
    if (!cutNodes) cutNodes = core.treeCutNodes(merges, n, labels);
    out.merges = { a: merges.a, b: merges.b, h: merges.h };
  } else if (p.algo === 'kmedoids') {
    if (p.auto) {
      silCurve = [];
      let best = { s: -Infinity };
      for (let kk = p.kMin; kk <= Math.min(p.kMax, n); kk++) {
        const r = core.kMedoids(matrix, n, kk);
        const s = core.silhouette(matrix, n, r.labels, kk).mean;
        silCurve.push({ k: kk, silhouette: s });
        if (s > best.s) best = { s, k: kk, r };
      }
      labels = best.r.labels;
      medoids = best.r.medoids;
      k = best.k;
    } else {
      k = Math.max(1, Math.min(p.k, n));
      const r = core.kMedoids(matrix, n, k);
      labels = r.labels;
      medoids = r.medoids;
    }
  } else if (p.algo === 'dbscan') {
    const r = core.dbscan(matrix, n, p.eps, p.minPts);
    labels = r.labels;
    k = r.k;
  } else {
    throw new RangeError(`Unsupported clustering algorithm: ${p.algo}`);
  }

  const sil = core.silhouette(matrix, n, labels, Math.max(k, 1));
  if (!medoids) medoids = core.medoidsOf(matrix, n, labels, k);
  const sizes = new Array(k).fill(0);
  let noise = 0;
  for (let i = 0; i < n; i++) {
    if (labels[i] >= 0) sizes[labels[i]]++;
    else noise++;
  }
  Object.assign(out, {
    k,
    labels,
    medoids,
    sizes,
    noise,
    cutNodes,
    cutHeight,
    information,
    silhouette: sil.mean,
    silhouetteByCluster: sil.perCluster,
    silCurve,
  });
  const transfer = [labels.buffer];
  if (medoids instanceof Int32Array) transfer.push(medoids.buffer);
  if (cutNodes instanceof Int32Array) transfer.push(cutNodes.buffer);
  if (out.merges) transfer.push(out.merges.a.buffer, out.merges.b.buffer, out.merges.h.buffer);
  self.postMessage({ taskId, type: 'result', result: out }, transfer);
}

self.addEventListener('message', (event) => {
  const message = event.data || {};
  const taskId = message.taskId ?? null;
  self.postMessage({ taskId, type: 'started', task: message.task });
  try {
    if (message.task === 'dtw') {
      void runDtw(taskId, message).catch((error) => {
        self.postMessage({ taskId, type: 'error', error: { name: error.name, message: error.message } });
      });
    } else if (message.task === 'mds') {
      runMds(taskId, message);
    } else if (message.task === 'cluster') {
      runCluster(taskId, message);
    } else {
      throw new RangeError(`Unsupported worker task: ${message.task}`);
    }
  } catch (error) {
    self.postMessage({ taskId, type: 'error', error: { name: error.name, message: error.message } });
  }
});
