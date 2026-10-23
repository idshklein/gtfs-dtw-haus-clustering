import express from 'express';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { initData, getMeta, loadSamples, getSample, listSamples, getVectors, getMapLines } from './lib/data.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PARQUET_DIR = process.env.GTFS_PARQUET_DIR || path.resolve(here, '..', 'israel-public-transportation-parquet');
const PORT = Number(process.env.PORT) || 3000;
const workerUrl = new URL('./lib/worker.mjs', import.meta.url);
const GTFS_FILES = new Set([
  'agency.parquet',
  'routes.parquet',
  'shapes.parquet',
  'stops.parquet',
  'stop_times.parquet',
  'trips.parquet',
]);

await initData(PARQUET_DIR);
const meta = await getMeta();

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(here, 'public')));
app.get('/gtfs/:filename', (req, res, next) => {
  if (!GTFS_FILES.has(req.params.filename)) return res.sendStatus(404);
  res.set('Cache-Control', 'public, max-age=3600, immutable');
  res.sendFile(path.join(PARQUET_DIR, req.params.filename), (error) => {
    if (error) next(error);
  });
});
app.use('/vendor/leaflet', express.static(path.join(here, 'node_modules', 'leaflet', 'dist')));
app.use('/vendor/duckdb', express.static(path.join(here, 'node_modules', '@duckdb', 'duckdb-wasm', 'dist')));
app.use('/vendor/apache-arrow', express.static(path.join(here, 'node_modules', 'apache-arrow')));

// ---------- DTW matrix state (only the latest matrix is kept in memory) ----------
let current = null; // { key, config, samples, n, matrix, xy, quantiles, dendro }
let job = { status: 'idle' };
let jobWorkers = [];

const normalizeVec = (vec, mode) => {
  if (mode === 'log') return vec.map((x) => Math.log1p(Math.max(x, 0)));
  if (mode === 'zscore') {
    const m = vec.reduce((s, x) => s + x, 0) / vec.length;
    const sd = Math.sqrt(vec.reduce((s, x) => s + (x - m) ** 2, 0) / vec.length) || 1;
    return vec.map((x) => (x - m) / sd);
  }
  return vec;
};

const VALID_METRICS = [
  'hausdorff_profile_wmhd',
  'hausdorff_profile_quantile',
  'hausdorff_profile_max',
  'hausdorff_1d',
  'hausdorff_norm2d',
  'frechet',
  'dtw',
];

const numericOr = (value, fallback) => (
  value !== null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : fallback
);

const sanitizeConfig = (c = {}) => ({
  unit: c.unit === 'pattern' ? 'pattern' : 'route',
  feature: c.feature === 'cum' ? 'cum' : 'seg',
  metric: VALID_METRICS.includes(c.metric) ? c.metric : 'hausdorff_profile_wmhd',
  posWeight: Math.min(2, Math.max(0, numericOr(c.posWeight, 0.25))),
  quantilePct: Math.min(100, Math.max(50, numericOr(c.quantilePct, 90))),
  normalize: ['none', 'log', 'zscore'].includes(c.normalize) ? c.normalize : 'none',
  windowPct: Math.min(100, Math.max(0, numericOr(c.windowPct, 10))),
  lenNorm: c.lenNorm !== false,
  agencyIds: Array.isArray(c.agencyIds) ? c.agencyIds.map(String) : [],
  routeTypes: Array.isArray(c.routeTypes) ? c.routeTypes.map(String) : [],
  minLen: Math.max(0, Math.floor(Number(c.minLen) || 0)),
  workers: Math.min(os.availableParallelism(), Math.max(1, Math.floor(Number(c.workers) || Math.max(1, os.availableParallelism() - 2)))),
});

function buildSampleBuffers(rows, config) {
  const n = rows.length;
  const metric = config.metric;
  const offsets = new Uint32Array(n + 1);

  if (metric === 'hausdorff_profile_wmhd' || metric === 'hausdorff_profile_quantile' || metric === 'hausdorff_profile_max') {
    const segs = new Array(n);
    const mids = new Array(n);
    const weights = new Array(n);
    const totalLens = new Float64Array(new SharedArrayBuffer(n * 8));

    for (let i = 0; i < n; i++) {
      const rawSeg = rows[i].seg.map(Number);
      const rawMid = rows[i].mid.map(Number);
      const len = Math.min(rawSeg.length, rawMid.length);
      let rawTotal = 0;
      let maxEnd = 0;
      for (let k = 0; k < len; k++) {
        const s = Math.max(0, rawSeg[k] || 0);
        const m = Math.max(0, rawMid[k] || 0);
        rawTotal += s;
        if (m + 0.5 * s > maxEnd) maxEnd = m + 0.5 * s;
      }
      const normSeg = normalizeVec(rawSeg.slice(0, len), config.normalize);
      const normMid = config.normalize === 'log'
        ? rawMid.slice(0, len).map((x) => Math.log1p(Math.max(x, 0)))
        : config.normalize === 'zscore'
        ? normalizeVec(rawMid.slice(0, len), 'zscore')
        : rawMid.slice(0, len);

      const order = Array.from({ length: len }, (_, k) => k).sort((a, b) => normMid[a] - normMid[b]);
      const sArr = new Float64Array(len);
      const mArr = new Float64Array(len);
      const wArr = new Float64Array(len);
      for (let k = 0; k < len; k++) {
        const idx = order[k];
        sArr[k] = normSeg[idx];
        mArr[k] = normMid[idx];
        wArr[k] = rawTotal > 0 ? Math.max(0, rawSeg[idx]) / rawTotal : len > 0 ? 1 / len : 0;
      }
      segs[i] = sArr;
      mids[i] = mArr;
      weights[i] = wArr;
      totalLens[i] = config.normalize === 'log' ? Math.log1p(maxEnd) : config.normalize === 'zscore' ? 0 : maxEnd;
      offsets[i + 1] = offsets[i] + len;
    }

    const total = offsets[n];
    const flat = new Float64Array(new SharedArrayBuffer(total * 8));
    const flatMid = new Float64Array(new SharedArrayBuffer(total * 8));
    const flatWeight = new Float64Array(new SharedArrayBuffer(total * 8));
    for (let i = 0; i < n; i++) {
      flat.set(segs[i], offsets[i]);
      flatMid.set(mids[i], offsets[i]);
      flatWeight.set(weights[i], offsets[i]);
    }
    const aggMode = metric === 'hausdorff_profile_wmhd' ? 'wmhd' : metric === 'hausdorff_profile_quantile' ? 'quantile' : 'max';
    return { flat: flat.buffer, flatMid: flatMid.buffer, flatWeight: flatWeight.buffer, totalLens: totalLens.buffer, offsets, aggMode };
  }

  if (metric === 'hausdorff_1d') {
    const cums = new Array(n);
    for (let i = 0; i < n; i++) {
      const rawCum = normalizeVec(rows[i].cum.map(Number), config.normalize);
      rawCum.sort((a, b) => a - b);
      cums[i] = rawCum;
      offsets[i + 1] = offsets[i] + rawCum.length;
    }
    const flat = new Float64Array(new SharedArrayBuffer(offsets[n] * 8));
    for (let i = 0; i < n; i++) flat.set(cums[i], offsets[i]);
    const aggMode = config.quantilePct < 100 ? 'quantile' : 'max';
    return { flat: flat.buffer, flatMid: null, flatWeight: null, totalLens: null, offsets, aggMode };
  }

  if (metric === 'hausdorff_norm2d') {
    const xs = new Array(n);
    const ys = new Array(n);
    for (let i = 0; i < n; i++) {
      const rawCum = rows[i].cum.map(Number);
      let patLens = rows[i].cum_lengths;
      if (typeof patLens === 'string') patLens = JSON.parse(patLens);
      if (!Array.isArray(patLens) || !patLens.length) patLens = [rawCum.length];
      const pairs = [];
      let off = 0;
      for (const lenRaw of patLens) {
        const len = Math.max(0, Number(lenRaw) || 0);
        if (len <= 0) continue;
        const origin = rawCum[off] || 0;
        const total = Math.max(1e-9, (rawCum[off + len - 1] || 0) - origin);
        const denom = Math.max(1, len - 1);
        for (let k = 0; k < len; k++) {
          const x = Math.min(1, Math.max(0, ((rawCum[off + k] || 0) - origin) / total));
          const y = k / denom;
          pairs.push([x, y]);
        }
        off += len;
      }
      pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      xs[i] = Float64Array.from(pairs, (p) => p[0]);
      ys[i] = Float64Array.from(pairs, (p) => p[1]);
      offsets[i + 1] = offsets[i] + pairs.length;
    }
    const total = offsets[n];
    const flat = new Float64Array(new SharedArrayBuffer(total * 8));
    const flatMid = new Float64Array(new SharedArrayBuffer(total * 8));
    for (let i = 0; i < n; i++) {
      flatMid.set(xs[i], offsets[i]);
      flat.set(ys[i], offsets[i]);
    }
    const aggMode = config.quantilePct < 100 ? 'quantile' : 'max';
    return { flat: flat.buffer, flatMid: flatMid.buffer, flatWeight: null, totalLens: null, offsets, aggMode };
  }

  const vecs = rows.map((r) => normalizeVec(r.vec.map(Number), config.normalize));
  for (let i = 0; i < n; i++) offsets[i + 1] = offsets[i] + vecs[i].length;
  const flat = new Float64Array(new SharedArrayBuffer(offsets[n] * 8));
  vecs.forEach((v, i) => flat.set(v, offsets[i]));
  return { flat: flat.buffer, flatMid: null, flatWeight: null, totalLens: null, offsets, aggMode: 'max' };
}

const runWorker = (data, transfer = []) =>
  new Promise((resolve, reject) => {
    const w = new Worker(workerUrl, { workerData: data, transferList: transfer });
    jobWorkers.push(w);
    w.once('message', (m) => resolve(m));
    w.once('error', reject);
    w.once('exit', (code) => {
      if (code !== 0) reject(new Error(`worker exited with code ${code}`));
    });
  });

async function startDtw(config) {
  const t0 = Date.now();
  job = { id: Date.now(), status: 'loading', config, progress: 0, startedAt: t0 };
  const myJob = job;
  try {
    const rows = await loadSamples(config);
    if (rows.length < 3) throw new Error('נמצאו פחות מ-3 דגימות עם הסינון הנוכחי');
    if (myJob.status === 'cancelled') return;
    const n = rows.length;
    const { flat, flatMid, flatWeight, totalLens, offsets, aggMode } = buildSampleBuffers(rows, config);
    const matrix = new SharedArrayBuffer(n * n * 4);
    const counter = new SharedArrayBuffer(4);
    const progress = new SharedArrayBuffer(4);
    const totalPairs = (n * (n - 1)) / 2;
    Object.assign(myJob, { status: 'dtw', n, totalPairs, dtwStart: Date.now() });

    jobWorkers = [];
    const dtwDone = Array.from({ length: config.workers }, () =>
      runWorker({
        task: 'dtw',
        n,
        matrix,
        flat,
        flatMid,
        flatWeight,
        totalLens,
        offsets: offsets.buffer.slice(0),
        counter,
        progress,
        metric: config.metric,
        posWeight: config.posWeight,
        quantile: config.quantilePct / 100,
        aggMode,
        windowPct: config.windowPct,
        lenNorm: config.lenNorm,
      })
    );
    const timer = setInterval(() => {
      myJob.progress = Atomics.load(new Int32Array(progress), 0) / totalPairs;
    }, 250);
    try {
      await Promise.all(dtwDone);
    } finally {
      clearInterval(timer);
    }
    if (myJob.status === 'cancelled') return;
    myJob.progress = 1;
    myJob.dtwMs = Date.now() - myJob.dtwStart;
    myJob.status = 'mds';
    const { xy, qs, mdsInfo } = await runWorker({ task: 'mds', n, matrix });
    if (myJob.status === 'cancelled') return;

    const samples = rows.map(({ vec, seg, cum, mid, seg_lengths, cum_lengths, ...rest }) => rest);
    current = { config, samples, n, matrix, xy: Array.from(xy), quantiles: qs, mdsInfo, dendro: {} };
    myJob.status = 'done';
    myJob.totalMs = Date.now() - t0;
  } catch (e) {
    if (myJob.status !== 'cancelled') {
      myJob.status = 'error';
      myJob.error = e.message;
      console.error(e);
    }
  } finally {
    jobWorkers = [];
  }
}

app.get('/api/meta', (req, res) => res.json({ ...meta, cores: os.availableParallelism() }));

app.post('/api/samples', async (req, res) => {
  try {
    res.json(await listSamples({
      ...sanitizeConfig(req.body),
      search: req.body?.search,
      routeNameSearch: req.body?.routeNameSearch,
      limit: req.body?.limit,
    }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/sample', async (req, res) => {
  const cfg = current?.config ?? {};
  const row = await getSample(req.query.unit || cfg.unit, req.query.feature || cfg.feature, String(req.query.id));
  row ? res.json(row) : res.status(404).json({ error: 'not found' });
});

app.post('/api/vectors', async (req, res) => {
  if (!current) return res.status(409).json({ error: 'no data' });
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  res.json(await getVectors(current.config.unit, current.config.feature, ids));
});

app.post('/api/map-lines', async (req, res) => {
  if (!current || !Array.isArray(req.body?.samples)) return res.status(409).json({ error: 'אין דגימות מקובצות להצגה במפה' });
  try {
    res.json(await getMapLines(current.config.unit, req.body.samples));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/dtw', (req, res) => {
  if (['loading', 'dtw', 'mds'].includes(job.status)) return res.status(409).json({ error: 'חישוב כבר רץ' });
  const config = sanitizeConfig(req.body);
  current = null;
  startDtw(config);
  res.json({ started: true });
});

app.post('/api/dtw/cancel', (req, res) => {
  if (['loading', 'dtw', 'mds'].includes(job.status)) {
    job.status = 'cancelled';
    jobWorkers.forEach((w) => w.terminate());
  }
  res.json({ ok: true });
});

app.get('/api/status', (req, res) => {
  const { status, progress, n, totalPairs, dtwStart, dtwMs, totalMs, error, config } = job;
  const out = { status, progress, n, totalPairs, dtwMs, totalMs, error, config, mdsInfo: current?.mdsInfo ?? null };
  if (status === 'dtw' && progress > 0.005) out.etaMs = ((Date.now() - dtwStart) / progress) * (1 - progress);
  if (status === 'done' && current) {
    out.points = current.xy;
    out.samples = current.samples;
    out.quantiles = current.quantiles;
  }
  res.json(out);
});

app.post('/api/cluster', async (req, res) => {
  if (!current) return res.status(409).json({ error: 'אין מטריצת DTW. הריצו חישוב קודם.' });
  const b = req.body || {};
  const params = {
    algo: ['hierarchical', 'kmedoids', 'dbscan'].includes(b.algo) ? b.algo : 'hierarchical',
    linkage: ['average', 'complete', 'single'].includes(b.linkage) ? b.linkage : 'average',
    auto: !!b.auto,
    k: Math.max(1, Math.floor(Number(b.k) || 5)),
    kMin: Math.min(Math.max(2, Math.floor(Number(b.kMin) || 3)), 39),
    kMax: Math.min(40, Math.max(2, Math.floor(Number(b.kMax) || 15))),
    eps: Number(b.eps) || 0,
    minPts: Math.max(1, Math.floor(Number(b.minPts) || 5)),
  };
  params.kMax = Math.max(params.kMax, params.kMin);
  if (params.algo === 'kmedoids' && params.auto) params.kMax = Math.min(params.kMax, 15);
  const snapshot = current;
  const dkey = params.linkage;
  try {
    const t0 = Date.now();
    const result = await runWorker({
      task: 'cluster',
      n: snapshot.n,
      matrix: snapshot.matrix,
      params,
      merges: params.algo === 'hierarchical' ? snapshot.dendro[dkey] || null : null,
    });
    if (result.merges) {
      snapshot.dendro[dkey] = result.merges;
      delete result.merges;
    }
    result.labels = Array.from(result.labels);
    result.ms = Date.now() - t0;
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, '127.0.0.1', () => console.log(`http://localhost:${PORT}`));
