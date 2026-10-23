import { parentPort, workerData } from 'node:worker_threads';
import * as core from './core.mjs';

const w = workerData;
const D = w.matrix ? new Float32Array(w.matrix) : null;

if (w.task === 'dtw') {
  const data = new Float64Array(w.flat);
  const midData = w.flatMid ? new Float64Array(w.flatMid) : null;
  const weightData = w.flatWeight ? new Float64Array(w.flatWeight) : null;
  const totalLenData = w.totalLens ? new Float64Array(w.totalLens) : null;
  const offsets = new Uint32Array(w.offsets);
  const counter = new Int32Array(w.counter);
  const progress = new Int32Array(w.progress);
  const n = w.n;
  const metric = w.metric || 'dtw';
  const posWeight = Number.isFinite(w.posWeight) ? w.posWeight : 0.25;
  const quantile = Number.isFinite(w.quantile) ? w.quantile : 0.9;
  const aggMode = w.aggMode || 'max';
  let maxLen = 0;
  for (let i = 0; i < n; i++) maxLen = Math.max(maxLen, offsets[i + 1] - offsets[i]);
  const a = new Float64Array(maxLen + 1);
  const b = new Float64Array(maxLen + 1);
  for (;;) {
    const i = Atomics.add(counter, 0, 1);
    if (i >= n) break;
    const aOff = offsets[i];
    const aLen = offsets[i + 1] - aOff;
    D[i * n + i] = 0;
    for (let j = i + 1; j < n; j++) {
      const bOff = offsets[j];
      const bLen = offsets[j + 1] - bOff;
      let d;
      if (metric === 'hausdorff_profile_wmhd' || metric === 'hausdorff_profile_quantile' || metric === 'hausdorff_profile_max') {
        d = core.hausdorffSpacingProfile(
          data,
          midData,
          weightData,
          totalLenData,
          i,
          j,
          aOff,
          aLen,
          bOff,
          bLen,
          posWeight,
          aggMode,
          quantile,
          a,
          b
        );
      } else if (metric === 'hausdorff_1d') {
        d = core.hausdorff1DCum(data, aOff, aLen, bOff, bLen, aggMode, quantile, a);
      } else if (metric === 'hausdorff_norm2d') {
        d = core.hausdorffNorm2D(midData, data, aOff, aLen, bOff, bLen, aggMode, quantile, a);
      } else if (metric === 'frechet') {
        d = core.discreteFrechet(data, aOff, aLen, bOff, bLen, w.windowPct, a, b);
      } else {
        d = core.dtw(data, aOff, aLen, bOff, bLen, w.windowPct, w.lenNorm, a, b);
      }
      D[i * n + j] = d;
      D[j * n + i] = d;
    }
    Atomics.add(progress, 0, n - i - 1);
  }
  parentPort.postMessage({ done: true });
} else if (w.task === 'mds') {
  const n = w.n;
  const result = core.mds(D, n, w.dimensions ?? 2);
  const features = w.features == null ? null : new Float64Array(w.features);
  const { xy, coordinates, ...mdsInfo } = result;
  mdsInfo.correlations = features
    ? core.mdsFeatureCorrelations(coordinates, result.dimensions, features, n)
    : [];
  const qs = core.distanceQuantiles(D, n, [0.005, 0.01, 0.02, 0.05, 0.1, 0.25, 0.5]);
  parentPort.postMessage(
    { xy, coordinates, qs, mdsInfo },
    [...new Set([xy.buffer, coordinates.buffer])]
  );
} else if (w.task === 'cluster') {
  const n = w.n;
  const p = w.params;
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
    if (!merges) merges = core.hierarchical(D, n, p.linkage);
    if (p.cutMode === 'h') {
      cutHeight = Number(p.cutH);
      const cut = core.cutTreeAtHeight(merges, n, cutHeight);
      labels = cut.labels;
      cutNodes = cut.clusters;
    } else if (typeof p.cutMode === 'string' && p.cutMode.startsWith('info-')) {
      const stop = p.cutMode === 'info-k'
        ? { k: Math.max(1, Math.min(p.k, n)) }
        : p.cutMode === 'info-tau' ? { tau: Number(p.cutTau) } : { frac: Number(p.cutFrac) };
      const cut = core.divisiveInformationCut(merges, n, new Float64Array(w.features), stop);
      labels = cut.labels;
      cutNodes = cut.clusters;
      information = cut.information;
    } else if (p.auto) {
      silCurve = [];
      let best = { s: -Infinity, k: 0, labels: null };
      core.cutTreeRange(merges, n, p.kMin, Math.min(p.kMax, n), (kk, lab) => {
        const s = core.silhouette(D, n, lab, kk).mean;
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
        const r = core.kMedoids(D, n, kk);
        const s = core.silhouette(D, n, r.labels, kk).mean;
        silCurve.push({ k: kk, silhouette: s });
        if (s > best.s) best = { s, k: kk, r };
      }
      labels = best.r.labels;
      medoids = best.r.medoids;
      k = best.k;
    } else {
      k = Math.max(1, Math.min(p.k, n));
      const r = core.kMedoids(D, n, k);
      labels = r.labels;
      medoids = r.medoids;
    }
  } else {
    const r = core.dbscan(D, n, p.eps, p.minPts);
    labels = r.labels;
    k = r.k;
  }

  const sil = core.silhouette(D, n, labels, Math.max(k, 1));
  if (!medoids) medoids = core.medoidsOf(D, n, labels, k);
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
  parentPort.postMessage(out);
}
