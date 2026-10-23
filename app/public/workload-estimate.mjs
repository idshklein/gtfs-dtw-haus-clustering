const FLOAT32_BYTES = Float32Array.BYTES_PER_ELEMENT;
const FLOAT64_BYTES = Float64Array.BYTES_PER_ELEMENT;
const MAX_LANCZOS_STEPS = 64;
const MAX_QUANTILE_SAMPLES = 200_000;
const PEAK_MEMORY_TARGET_BYTES = 2.5 * 1024 ** 3;
export const MEMORY_WARNING_BYTES = PEAK_MEMORY_TARGET_BYTES / 2;

const PROFILE_METRICS = new Set([
  'hausdorff_profile_wmhd',
  'hausdorff_profile_quantile',
  'hausdorff_profile_max',
]);

const integerAtLeast = (value, minimum, name) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) {
    throw new RangeError(`${name} must be a safe integer greater than or equal to ${minimum}`);
  }
  return number;
};

export function estimateWorkload({ n, maxVectorLength, metric, workers, mdsDimensions = 2 }) {
  n = integerAtLeast(n, 0, 'n');
  maxVectorLength = integerAtLeast(maxVectorLength, 0, 'maxVectorLength');
  workers = integerAtLeast(workers, 1, 'workers');
  mdsDimensions = integerAtLeast(mdsDimensions, 2, 'mdsDimensions');
  if (mdsDimensions > 10) throw new RangeError('mdsDimensions must not exceed 10');
  if (typeof metric !== 'string' || !metric) throw new TypeError('metric must be a non-empty string');

  const pairs = (n * (n - 1)) / 2;
  const matrixBytes = n * n * FLOAT32_BYTES;
  const vectorArraysPerWorker = PROFILE_METRICS.has(metric)
    ? 3
    : metric === 'hausdorff_norm2d'
      ? 2
      : 1;
  const workerInputBytes = n * maxVectorLength * FLOAT64_BYTES * vectorArraysPerWorker * workers;
  const scratchBytes = workers * (
    n * FLOAT32_BYTES
    + 2 * (maxVectorLength + 1) * FLOAT64_BYTES
  );

  const steps = Math.min(n, MAX_LANCZOS_STEPS);
  const mdsBytes = n < 2
    ? 0
    : (
      (steps * n + 3 * n) * FLOAT64_BYTES
      + (steps + Math.max(steps - 1, 0)) * FLOAT64_BYTES
      + 2 * steps * steps * FLOAT64_BYTES
      + n * n * FLOAT32_BYTES
      + n * (mdsDimensions * (FLOAT32_BYTES + FLOAT64_BYTES) + 2 * (FLOAT32_BYTES + FLOAT64_BYTES))
      + n * 4 * 2 * FLOAT64_BYTES
      + Math.min(pairs, MAX_QUANTILE_SAMPLES) * FLOAT64_BYTES
    );
  const knownBufferBytes = matrixBytes + workerInputBytes + scratchBytes + mdsBytes;
  for (const [name, value] of Object.entries({
    pairs,
    matrixBytes,
    workerInputBytes,
    scratchBytes,
    mdsBytes,
    knownBufferBytes,
  })) {
    if (!Number.isSafeInteger(value)) throw new RangeError(`${name} exceeds the safe integer range`);
  }

  return {
    n,
    pairs,
    matrixBytes,
    workerInputBytes,
    scratchBytes,
    mdsBytes,
    knownBufferBytes,
    warningThresholdBytes: MEMORY_WARNING_BYTES,
    maxVectorLength,
    workers,
    warning: knownBufferBytes >= MEMORY_WARNING_BYTES,
  };
}
