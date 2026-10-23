const VALID_METRICS = new Set([
  'hausdorff_profile_wmhd',
  'hausdorff_profile_quantile',
  'hausdorff_profile_max',
  'hausdorff_1d',
  'hausdorff_norm2d',
  'frechet',
  'dtw',
]);

const VALID_BACKENDS = new Set(['cpu', 'webgpu']);
const PROFILE_METRICS = new Set([
  'hausdorff_profile_wmhd',
  'hausdorff_profile_quantile',
  'hausdorff_profile_max',
]);

export function deriveBaseFeatures(rows) {
  const featureCount = 4;
  const features = new Float64Array(rows.length * featureCount);
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex];
    const segments = Array.from(row.seg || [], Number);
    const rawLengths = Array.from(row.seg_lengths || [], (value) => Math.max(0, Math.floor(Number(value) || 0)));
    const lengths = rawLengths.length ? rawLengths : [segments.length];
    const patternStops = [];
    const patternLengths = [];
    const intervals = [];
    let offset = 0;
    for (const segmentCount of lengths) {
      const count = Math.min(segmentCount, Math.max(0, segments.length - offset));
      const current = segments.slice(offset, offset + count).filter(Number.isFinite);
      offset += segmentCount;
      patternStops.push(count + 1);
      patternLengths.push(current.reduce((sum, value) => sum + Math.max(0, value), 0));
      intervals.push(...current.map((value) => Math.max(0, value)));
    }
    if (offset < segments.length) {
      const current = segments.slice(offset).filter(Number.isFinite).map((value) => Math.max(0, value));
      patternStops.push(current.length + 1);
      patternLengths.push(current.reduce((sum, value) => sum + value, 0));
      intervals.push(...current);
    }
    const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN;
    const intervalMean = mean(intervals);
    const variance = intervals.length
      ? intervals.reduce((sum, value) => sum + (value - intervalMean) ** 2, 0) / intervals.length
      : NaN;
    const start = rowIndex * featureCount;
    features[start] = mean(patternStops);
    features[start + 1] = mean(patternLengths);
    features[start + 2] = intervalMean;
    features[start + 3] = variance;
  }
  return features;
}

const asNumber = (value, fallback) => (
  value !== null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : fallback
);

const requiredFiniteNumber = (name, value) => {
  if (value == null || value === '' || !Number.isFinite(Number(value))) {
    throw new RangeError(`${name} must be a finite number`);
  }
  return Number(value);
};

const requiredInteger = (name, value, minimum, maximum = Number.MAX_SAFE_INTEGER) => {
  const number = requiredFiniteNumber(name, value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    const range = maximum === Number.MAX_SAFE_INTEGER ? `at least ${minimum}` : `between ${minimum} and ${maximum}`;
    throw new RangeError(`${name} must be an integer ${range}`);
  }
  return number;
};

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

const normalizeVec = (values, mode) => {
  if (mode === 'log') return values.map((value) => Math.log1p(Math.max(value, 0)));
  if (mode === 'zscore') {
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const deviation = Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length) || 1;
    return values.map((value) => (value - mean) / deviation);
  }
  return values;
};

function parseLengths(value, fallbackLength) {
  let lengths = value;
  if (typeof lengths === 'string') {
    try {
      lengths = JSON.parse(lengths);
    } catch {
      lengths = null;
    }
  }
  if (!Array.isArray(lengths) || lengths.length === 0) return [fallbackLength];
  return lengths.map((length) => Math.max(0, Math.floor(Number(length) || 0)));
}

export function sanitizeBrowserConfig(value = {}, maxWorkers = 1) {
  const workerLimit = Math.max(1, Math.floor(Number(maxWorkers) || 1));
  return {
    unit: value.unit === 'pattern' ? 'pattern' : 'route',
    feature: value.feature === 'cum' ? 'cum' : 'seg',
    metric: VALID_METRICS.has(value.metric) ? value.metric : 'hausdorff_profile_wmhd',
    posWeight: clamp(asNumber(value.posWeight, 0.25), 0, 2),
    quantilePct: clamp(asNumber(value.quantilePct, 90), 50, 100),
    normalize: ['none', 'log', 'zscore'].includes(value.normalize) ? value.normalize : 'none',
    mdsDims: clamp(Math.floor(asNumber(value.mdsDims, 6)), 2, 10),
    windowPct: clamp(asNumber(value.windowPct, 10), 0, 100),
    lenNorm: value.lenNorm !== false,
    agencyIds: Array.isArray(value.agencyIds) ? value.agencyIds.map(String) : [],
    routeTypes: Array.isArray(value.routeTypes) ? value.routeTypes.map(String) : [],
    minLen: Math.max(0, Math.floor(asNumber(value.minLen, 0))),
    workers: clamp(Math.floor(asNumber(value.workers, workerLimit)), 1, workerLimit),
    computeBackend: VALID_BACKENDS.has(value.computeBackend) ? value.computeBackend : 'cpu',
  };
}

export function buildSampleBuffers(rows, config) {
  const count = rows.length;
  const offsets = new Uint32Array(count + 1);

  if (PROFILE_METRICS.has(config.metric)) {
    const segments = new Array(count);
    const mids = new Array(count);
    const weights = new Array(count);
    const totalLengths = new Float64Array(count);

    for (let index = 0; index < count; index++) {
      const rawSegments = rows[index].seg.map(Number);
      const rawMids = rows[index].mid.map(Number);
      const length = Math.min(rawSegments.length, rawMids.length);
      let rawTotal = 0;
      let maxEnd = 0;
      for (let offset = 0; offset < length; offset++) {
        const segment = Math.max(0, rawSegments[offset] || 0);
        const mid = Math.max(0, rawMids[offset] || 0);
        rawTotal += segment;
        maxEnd = Math.max(maxEnd, mid + 0.5 * segment);
      }
      const normalizedSegments = normalizeVec(rawSegments.slice(0, length), config.normalize);
      const normalizedMids = config.normalize === 'log'
        ? rawMids.slice(0, length).map((value) => Math.log1p(Math.max(value, 0)))
        : config.normalize === 'zscore'
          ? normalizeVec(rawMids.slice(0, length), 'zscore')
          : rawMids.slice(0, length);
      const order = Array.from({ length }, (_, offset) => offset)
        .sort((left, right) => normalizedMids[left] - normalizedMids[right]);
      segments[index] = new Float64Array(length);
      mids[index] = new Float64Array(length);
      weights[index] = new Float64Array(length);
      for (let offset = 0; offset < length; offset++) {
        const source = order[offset];
        segments[index][offset] = normalizedSegments[source];
        mids[index][offset] = normalizedMids[source];
        weights[index][offset] = rawTotal > 0
          ? Math.max(0, rawSegments[source]) / rawTotal
          : length > 0 ? 1 / length : 0;
      }
      totalLengths[index] = config.normalize === 'log'
        ? Math.log1p(maxEnd)
        : config.normalize === 'zscore' ? 0 : maxEnd;
      offsets[index + 1] = offsets[index] + length;
    }

    const total = offsets[count];
    const flat = new Float64Array(total);
    const flatMid = new Float64Array(total);
    const flatWeight = new Float64Array(total);
    for (let index = 0; index < count; index++) {
      flat.set(segments[index], offsets[index]);
      flatMid.set(mids[index], offsets[index]);
      flatWeight.set(weights[index], offsets[index]);
    }
    return {
      flat: flat.buffer,
      flatMid: flatMid.buffer,
      flatWeight: flatWeight.buffer,
      totalLens: totalLengths.buffer,
      offsets,
      aggMode: config.metric === 'hausdorff_profile_wmhd'
        ? 'wmhd'
        : config.metric === 'hausdorff_profile_quantile' ? 'quantile' : 'max',
    };
  }

  if (config.metric === 'hausdorff_1d') {
    const cumulative = rows.map((row) => normalizeVec(row.cum.map(Number), config.normalize).sort((a, b) => a - b));
    for (let index = 0; index < count; index++) offsets[index + 1] = offsets[index] + cumulative[index].length;
    const flat = new Float64Array(offsets[count]);
    cumulative.forEach((values, index) => flat.set(values, offsets[index]));
    return {
      flat: flat.buffer,
      flatMid: null,
      flatWeight: null,
      totalLens: null,
      offsets,
      aggMode: config.quantilePct < 100 ? 'quantile' : 'max',
    };
  }

  if (config.metric === 'hausdorff_norm2d') {
    const xs = new Array(count);
    const ys = new Array(count);
    for (let index = 0; index < count; index++) {
      const cumulative = rows[index].cum.map(Number);
      const patternLengths = parseLengths(rows[index].cum_lengths, cumulative.length);
      const points = [];
      let start = 0;
      for (const length of patternLengths) {
        if (length === 0) continue;
        const origin = cumulative[start] || 0;
        const total = Math.max(1e-9, (cumulative[start + length - 1] || 0) - origin);
        const denominator = Math.max(1, length - 1);
        for (let offset = 0; offset < length; offset++) {
          points.push([
            clamp(((cumulative[start + offset] || 0) - origin) / total, 0, 1),
            offset / denominator,
          ]);
        }
        start += length;
      }
      points.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
      xs[index] = Float64Array.from(points, (point) => point[0]);
      ys[index] = Float64Array.from(points, (point) => point[1]);
      offsets[index + 1] = offsets[index] + points.length;
    }
    const flat = new Float64Array(offsets[count]);
    const flatMid = new Float64Array(offsets[count]);
    for (let index = 0; index < count; index++) {
      flat.set(ys[index], offsets[index]);
      flatMid.set(xs[index], offsets[index]);
    }
    return {
      flat: flat.buffer,
      flatMid: flatMid.buffer,
      flatWeight: null,
      totalLens: null,
      offsets,
      aggMode: config.quantilePct < 100 ? 'quantile' : 'max',
    };
  }

  const vectors = rows.map((row) => normalizeVec(row.vec.map(Number), config.normalize));
  for (let index = 0; index < count; index++) offsets[index + 1] = offsets[index] + vectors[index].length;
  const flat = new Float64Array(offsets[count]);
  vectors.forEach((values, index) => flat.set(values, offsets[index]));
  return {
    flat: flat.buffer,
    flatMid: null,
    flatWeight: null,
    totalLens: null,
    offsets,
    aggMode: 'max',
  };
}

const isRunning = (status) => ['loading', 'dtw', 'mds'].includes(status);

function cancellationError() {
  const error = new Error('Computation cancelled');
  error.name = 'AbortError';
  return error;
}

export class BrowserAppService {
  constructor({
    dataClient,
    maxWorkers = 1,
    workerFactory = () => new Worker(new URL('./compute-worker.mjs', import.meta.url), { type: 'module' }),
  }) {
    if (!dataClient) throw new TypeError('dataClient is required');
    if (!Number.isSafeInteger(maxWorkers) || maxWorkers < 1) throw new RangeError('maxWorkers must be a positive integer');
    this.dataClient = dataClient;
    this.maxWorkers = maxWorkers;
    this.workerFactory = workerFactory;
    this.meta = null;
    this.job = { status: 'idle', progress: 0 };
    this.current = null;
    this.taskSequence = 0;
    this.activeRuns = new Set();
    this.clusterTask = null;
  }

  setMeta(meta) {
    if (!meta || typeof meta !== 'object') throw new TypeError('GTFS metadata is required');
    this.meta = meta;
  }

  clearCurrent() {
    this.current = null;
  }

  async request(path, body) {
    const url = new URL(path, 'http://browser.local');
    if (url.pathname === '/api/meta' && url.search === '') {
      if (!this.meta) throw new Error('GTFS metadata is not ready');
      return { ...this.meta, cores: this.maxWorkers };
    }
    if (url.pathname === '/api/samples' && body && typeof body === 'object') {
      return this.dataClient.listSamples({
        ...sanitizeBrowserConfig(body, this.maxWorkers),
        search: body.search,
        routeNameSearch: body.routeNameSearch,
        limit: body.limit,
      });
    }
    if (url.pathname === '/api/sample' && url.searchParams.has('id')) {
      const config = this.current?.config || {};
      const row = await this.dataClient.getSample(
        url.searchParams.get('unit') || config.unit || 'route',
        url.searchParams.get('feature') || config.feature || 'seg',
        url.searchParams.get('id')
      );
      if (!row) throw new Error('not found');
      return row;
    }
    if (url.pathname === '/api/vectors' && body && typeof body === 'object') {
      if (!this.current) throw new Error('no data');
      const ids = Array.isArray(body.ids) ? body.ids : [];
      return this.dataClient.getVectors(this.current.config.unit, this.current.config.feature, ids);
    }
    if (url.pathname === '/api/map-lines' && body && typeof body === 'object') {
      if (!this.current || !Array.isArray(body.samples)) throw new Error('אין דגימות מקובצות להצגה במפה');
      return this.dataClient.getMapLines(this.current.config.unit, body.samples);
    }
    if (url.pathname === '/api/dtw' && body && typeof body === 'object') {
      if (isRunning(this.job.status)) throw new Error('חישוב כבר רץ');
      this.startDtw(body);
      return { started: true };
    }
    if (url.pathname === '/api/dtw/cancel') {
      this.cancelDtw();
      return { ok: true };
    }
    if (url.pathname === '/api/status' && url.search === '') return this.getStatus();
    if (url.pathname === '/api/cluster/status' && url.search === '') {
      return {
        running: !!this.clusterTask,
        phase: this.clusterTask?.phase || '',
        progress: this.clusterTask?.progress || 0,
      };
    }
    if (url.pathname === '/api/cluster/cancel') {
      this.cancelCluster();
      return { ok: true };
    }
    if (url.pathname === '/api/cluster' && body && typeof body === 'object') {
      return this.cluster(body);
    }
    throw new Error(`Unsupported browser service request: ${url.pathname}`);
  }

  startDtw(value) {
    if (isRunning(this.job.status)) throw new Error('חישוב כבר רץ');
    for (const cancelRun of [...this.activeRuns]) cancelRun();
    const config = sanitizeBrowserConfig(value, this.maxWorkers);
    const job = {
      id: `dtw-${++this.taskSequence}`,
      status: 'loading',
      progress: 0,
      config,
      startedAt: Date.now(),
      workers: new Set(),
      abortController: new AbortController(),
      notice: '',
    };
    this.job = job;
    this.current = null;
    void this.calculate(job);
  }

  async calculate(job) {
    try {
      const startedAt = performance.now();
      const rows = await this.dataClient.loadSamples(job.config);
      if (job.status === 'cancelled') return;
      if (rows.length < 3) throw new Error('נמצאו פחות מ-3 דגימות עם הסינון הנוכחי');

      const n = rows.length;
      const features = deriveBaseFeatures(rows);
      const totalPairs = (n * (n - 1)) / 2;
      const buffers = buildSampleBuffers(rows, job.config);
      job.n = n;
      job.totalPairs = totalPairs;
      job.status = 'dtw';
      job.dtwStart = Date.now();
      const dtwStartedAt = performance.now();
      let matrix;
      let backend = 'cpu';

      if (job.config.computeBackend === 'webgpu' && job.config.metric === 'hausdorff_profile_wmhd') {
        try {
          const { computeWebGpuMatrix } = await import('./webgpu-distance.mjs');
          matrix = await computeWebGpuMatrix({
            n,
            buffers,
            posWeight: job.config.posWeight,
            signal: job.abortController?.signal,
            onProgress: (progress) => { job.progress = progress; },
          });
          if (job.status === 'cancelled') return;
          backend = 'webgpu';
        } catch (error) {
          if (job.status === 'cancelled' || error.name === 'AbortError') return;
          job.notice = `WebGPU נכשל; החישוב ממשיך ב-CPU. (${error.message})`;
          matrix = await this.computeCpuMatrix(job, buffers, n, totalPairs);
        }
      } else {
        if (job.config.computeBackend === 'webgpu') {
          job.notice = 'WebGPU זמין כרגע רק למדד WMHD; החישוב ממשיך ב-CPU.';
        }
        matrix = await this.computeCpuMatrix(job, buffers, n, totalPairs);
      }

      if (job.status === 'cancelled') return;
      job.progress = 1;
      job.backend = backend;
      job.dtwMs = performance.now() - dtwStartedAt;
      job.status = 'mds';
      job.progress = 0;
      const mdsMatrix = matrix.buffer.slice(0);
      const featureBuffer = features.buffer.slice(0);
      const { xy, coordinates, qs, mdsInfo } = await this.runWorker(job, {
        task: 'mds',
        n,
        dimensions: job.config.mdsDims,
        matrix: mdsMatrix,
        features: featureBuffer,
      }, [mdsMatrix, featureBuffer], (message) => {
        if (message.type === 'progress' && message.phase === 'mds') {
          job.progress = message.total ? message.completed / message.total : 0;
        }
      });
      if (job.status === 'cancelled') return;

      const samples = rows.map(({ vec, seg, cum, mid, seg_lengths, cum_lengths, ...rest }) => rest);
      this.current = {
        config: job.config,
        rows,
        samples,
        n,
        matrix,
        xy: Array.from(xy),
        coordinates: Array.from(coordinates),
        dimensions: job.config.mdsDims,
        features,
        quantiles: qs,
        mdsInfo,
        dendro: {},
      };
      job.progress = 1;
      job.status = 'done';
      job.totalMs = performance.now() - startedAt;
    } catch (error) {
      if (job.status !== 'cancelled') {
        job.status = 'error';
        job.error = error.message;
        for (const cancelRun of [...this.activeRuns]) cancelRun();
        console.error(error);
      }
    }
  }

  async computeCpuMatrix(job, buffers, n, totalPairs) {
    const matrix = new Float32Array(n * n);
    const workerCount = Math.min(job.config.workers, n - 1);
    const rowCount = n - 1;
    const progressByWorker = new Array(workerCount).fill(0);
    const jobs = [];

    for (let workerIndex = 0; workerIndex < workerCount; workerIndex++) {
      const rowStart = Math.floor(rowCount * workerIndex / workerCount);
      const rowEnd = Math.floor(rowCount * (workerIndex + 1) / workerCount);
      const payload = {
        task: 'dtw',
        n,
        rowStart,
        rowEnd,
        rowBatchSize: 8,
        flat: buffers.flat.slice(0),
        flatMid: buffers.flatMid?.slice(0) ?? null,
        flatWeight: buffers.flatWeight?.slice(0) ?? null,
        totalLens: buffers.totalLens?.slice(0) ?? null,
        offsets: buffers.offsets.buffer.slice(0),
        metric: job.config.metric,
        posWeight: job.config.posWeight,
        quantile: job.config.quantilePct / 100,
        aggMode: buffers.aggMode,
        windowPct: job.config.windowPct,
        lenNorm: job.config.lenNorm,
      };
      const transfer = [
        payload.flat,
        payload.offsets,
        ...[payload.flatMid, payload.flatWeight, payload.totalLens].filter(Boolean),
      ];
      jobs.push(this.runWorker(job, payload, transfer, (message) => {
        if (message.type === 'progress') {
          progressByWorker[workerIndex] = message.completedPairs;
          job.progress = Math.min(1, progressByWorker.reduce((sum, value) => sum + value, 0) / totalPairs);
        } else if (message.type === 'rows') {
          const distances = new Float32Array(message.distances);
          let offset = 0;
          for (let row = message.rowStart; row < message.rowEnd; row++) {
            for (let column = row + 1; column < n; column++) {
              const distance = distances[offset++];
              if (!Number.isFinite(distance)) throw new Error('חישוב המרחקים החזיר ערך לא סופי');
              matrix[row * n + column] = distance;
              matrix[column * n + row] = distance;
            }
          }
          if (offset !== distances.length) throw new Error('Worker returned an invalid distance batch');
        }
      }));
    }
    await Promise.all(jobs);
    if (job.status === 'cancelled') throw cancellationError();
    return matrix;
  }

  runWorker(job, payload, transfer = [], onMessage = () => {}) {
    if (job.status === 'cancelled') return Promise.reject(cancellationError());
    const worker = this.workerFactory();
    job.workers.add(worker);
    return new Promise((resolve, reject) => {
      let settled = false;
      const taskId = `${job.id}:${++this.taskSequence}`;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        worker.removeEventListener('message', onWorkerMessage);
        worker.removeEventListener('error', onWorkerError);
        worker.removeEventListener('messageerror', onWorkerMessageError);
        job.workers.delete(worker);
        this.activeRuns.delete(cancel);
        worker.terminate();
        if (error) reject(error);
        else resolve(result);
      };
      const cancel = () => finish(cancellationError());
      job.cancel = cancel;
      const onWorkerMessage = (event) => {
        const message = event.data;
        if (message?.taskId !== taskId) return;
        if (message.type === 'error') {
          finish(new Error(message.error?.message || 'Browser worker failed'));
          return;
        }
        try {
          onMessage(message);
        } catch (error) {
          finish(error);
          return;
        }
        if (message.type === 'result') finish(null, message.result);
      };
      const onWorkerError = (event) => finish(event.error || new Error(event.message || 'Browser worker failed'));
      const onWorkerMessageError = () => finish(new Error('Browser worker returned an unreadable message'));
      this.activeRuns.add(cancel);
      worker.addEventListener('message', onWorkerMessage);
      worker.addEventListener('error', onWorkerError);
      worker.addEventListener('messageerror', onWorkerMessageError);
      try {
        worker.postMessage({ ...payload, taskId }, transfer);
      } catch (error) {
        finish(error);
      }
    });
  }

  async cluster(value) {
    if (!this.current) throw new Error('אין מטריצת DTW. הריצו חישוב קודם.');
    if (this.clusterTask) throw new Error('חישוב אשכולות כבר רץ');
    const snapshot = this.current;
    const algo = value.algo ?? 'hierarchical';
    const linkage = value.linkage ?? 'average';
    const cutMode = value.cutMode ?? 'k';
    if (!['hierarchical', 'kmedoids', 'dbscan'].includes(algo)) {
      throw new RangeError(`Unsupported clustering algorithm: ${algo}`);
    }
    if (!['average', 'complete', 'single'].includes(linkage)) {
      throw new RangeError(`Unsupported linkage: ${linkage}`);
    }
    if (!['k', 'h', 'info-k', 'info-tau', 'info-frac'].includes(cutMode)) {
      throw new RangeError(`Unsupported hierarchical cut mode: ${cutMode}`);
    }
    const auto = Boolean(value.auto) && (algo === 'kmedoids' || (algo === 'hierarchical' && cutMode === 'k'));
    const k = value.k == null ? 5 : requiredInteger('k', value.k, 1);
    const kMin = auto ? requiredInteger('kMin', value.kMin ?? 3, 2, 39) : 3;
    let kMax = auto ? requiredInteger('kMax', value.kMax ?? 15, 2, 40) : 15;
    if (algo === 'kmedoids' && auto) kMax = Math.min(kMax, 15);
    if (auto && kMin > kMax) throw new RangeError('kMin must not exceed kMax');
    const cutH = algo === 'hierarchical' && cutMode === 'h' ? requiredFiniteNumber('cutH', value.cutH) : asNumber(value.cutH, 0);
    const cutTau = algo === 'hierarchical' && cutMode === 'info-tau' ? requiredFiniteNumber('cutTau', value.cutTau) : asNumber(value.cutTau, 0.01);
    const cutFrac = algo === 'hierarchical' && cutMode === 'info-frac' ? requiredFiniteNumber('cutFrac', value.cutFrac) : asNumber(value.cutFrac, 0.9);
    if (algo === 'hierarchical' && cutMode === 'h' && cutH < 0) throw new RangeError('cutH must be finite and non-negative');
    if (algo === 'hierarchical' && cutMode === 'info-tau' && cutTau < 0) throw new RangeError('cutTau must be finite and non-negative');
    if (algo === 'hierarchical' && cutMode === 'info-frac' && (cutFrac < 0 || cutFrac > 1)) {
      throw new RangeError('cutFrac must be between 0 and 1');
    }
    const eps = algo === 'dbscan'
      ? value.eps == null ? 0 : requiredFiniteNumber('eps', value.eps)
      : asNumber(value.eps, 0);
    const minPts = algo === 'dbscan'
      ? value.minPts == null ? 5 : requiredInteger('minPts', value.minPts, 1)
      : 5;
    if (algo === 'dbscan' && eps < 0) throw new RangeError('eps must be finite and non-negative');
    const params = {
      algo,
      linkage,
      cutMode,
      auto,
      k,
      kMin,
      kMax,
      cutH,
      cutTau,
      cutFrac,
      eps,
      minPts,
    };
    const startedAt = performance.now();
    const oldMerges = params.algo === 'hierarchical' ? snapshot.dendro[linkage] : null;
    const merges = oldMerges
      ? { a: oldMerges.a.slice(), b: oldMerges.b.slice(), h: oldMerges.h.slice() }
      : null;
    const clusterMatrix = snapshot.matrix.buffer.slice(0);
    const featureBuffer = cutMode.startsWith('info-') ? snapshot.features.buffer.slice(0) : null;
    const job = {
      id: `cluster-${++this.taskSequence}`,
      status: 'running',
      workers: new Set(),
      phase: 'starting',
      progress: 0,
    };
    this.clusterTask = job;
    try {
      const result = await this.runWorker(job, {
        task: 'cluster',
        n: snapshot.n,
        matrix: clusterMatrix,
        params,
        merges,
        features: featureBuffer,
      }, [clusterMatrix, ...(featureBuffer ? [featureBuffer] : [])], (message) => {
        if (message.type === 'progress') {
          job.phase = message.phase || 'clustering';
          job.progress = Number(message.progress) || 0;
        }
      });
      if (this.current !== snapshot) throw new Error('התצורה השתנתה; תוצאת הקיבוץ הושלכה.');
      if (result.merges) snapshot.dendro[linkage] = result.merges;
      result.labels = Array.from(result.labels);
      result.medoids = Array.from(result.medoids || []);
      result.ms = performance.now() - startedAt;
      return result;
    } finally {
      if (this.clusterTask === job) this.clusterTask = null;
    }
  }

  cancelCluster() {
    if (!this.clusterTask?.cancel) return;
    this.clusterTask.cancel();
    this.clusterTask = null;
  }

  cancelDtw() {
    if (!isRunning(this.job.status)) return;
    this.job.status = 'cancelled';
    this.job.abortController.abort();
    for (const cancelRun of [...this.activeRuns]) cancelRun();
    this.job.workers.clear();
  }

  getStatus() {
    const { status, progress, n, totalPairs, dtwMs, totalMs, error, config, backend, notice } = this.job;
    const result = { status, progress, n, totalPairs, dtwMs, totalMs, error, config, backend, notice };
    if (status === 'dtw' && progress > 0.005 && this.job.dtwStart) {
      result.etaMs = ((Date.now() - this.job.dtwStart) / progress) * (1 - progress);
    }
    if (status === 'done' && this.current) {
      result.points = this.current.xy;
      result.coordinates = this.current.coordinates;
      result.mdsDimensions = this.current.dimensions;
      result.features = this.current.features;
      result.samples = this.current.samples;
      result.quantiles = this.current.quantiles;
      result.mdsInfo = this.current.mdsInfo;
    }
    return result;
  }
}
