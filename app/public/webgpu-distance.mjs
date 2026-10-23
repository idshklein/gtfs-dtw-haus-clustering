const SHADER = `
struct Params {
  sampleCount: u32,
  positionWeight: f32,
  rowStart: u32,
  rowCount: u32,
}

@group(0) @binding(0) var<storage, read> segments: array<f32>;
@group(0) @binding(1) var<storage, read> mids: array<f32>;
@group(0) @binding(2) var<storage, read> weights: array<f32>;
@group(0) @binding(3) var<storage, read> totalLengths: array<f32>;
@group(0) @binding(4) var<storage, read> offsets: array<u32>;
@group(0) @binding(5) var<storage, read_write> distances: array<f32>;
@group(0) @binding(6) var<uniform> params: Params;

fn directedDistance(aOffset: u32, aLength: u32, bOffset: u32, bLength: u32) -> f32 {
  if (aLength == 0u || bLength == 0u) {
    return 3.402823e38;
  }

  var total = 0.0;
  for (var aIndex = 0u; aIndex < aLength; aIndex += 1u) {
    let aMid = mids[aOffset + aIndex];
    let aSegment = segments[aOffset + aIndex];
    var best = 3.402823e38;

    if (params.positionWeight > 0.0) {
      var low = 0u;
      var high = bLength;
      while (low < high) {
        let middle = low + (high - low) / 2u;
        if (mids[bOffset + middle] <= aMid) {
          low = middle + 1u;
        } else {
          high = middle;
        }
      }
      var nearest = 0u;
      if (low > 0u) {
        nearest = low - 1u;
      }
      let initialX = params.positionWeight * abs(aMid - mids[bOffset + nearest]);
      let initialY = abs(aSegment - segments[bOffset + nearest]);
      best = max(initialX, initialY);

      var right = nearest + 1u;
      while (right < bLength) {
        let dx = params.positionWeight * (mids[bOffset + right] - aMid);
        if (dx >= best) {
          break;
        }
        best = min(best, max(dx, abs(aSegment - segments[bOffset + right])));
        right += 1u;
      }
      var left = nearest;
      while (left > 0u) {
        left -= 1u;
        let dx = params.positionWeight * (aMid - mids[bOffset + left]);
        if (dx >= best) {
          break;
        }
        best = min(best, max(dx, abs(aSegment - segments[bOffset + left])));
      }
    } else {
      for (var bIndex = 0u; bIndex < bLength; bIndex += 1u) {
        best = min(best, abs(aSegment - segments[bOffset + bIndex]));
      }
    }
    total += weights[aOffset + aIndex] * best;
  }
  return total;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.y >= params.rowCount) {
    return;
  }
  let row = params.rowStart + id.y;
  let column = id.x;
  if (row >= params.sampleCount || column >= params.sampleCount) {
    return;
  }
  if (column == row) {
    distances[row * params.sampleCount + column] = 0.0;
    return;
  }
  if (column < row) {
    return;
  }

  let aOffset = offsets[row];
  let bOffset = offsets[column];
  let aLength = offsets[row + 1u] - aOffset;
  let bLength = offsets[column + 1u] - bOffset;
  let forward = directedDistance(aOffset, aLength, bOffset, bLength);
  let reverse = directedDistance(bOffset, bLength, aOffset, aLength);
  let profile = max(forward, reverse);
  let lengthDifference = params.positionWeight * abs(totalLengths[row] - totalLengths[column]);
  let distance = max(profile, lengthDifference);
  distances[row * params.sampleCount + column] = distance;
  distances[column * params.sampleCount + row] = distance;
}
`;

function abortError() {
  const error = new Error('WebGPU computation cancelled');
  error.name = 'AbortError';
  return error;
}

function makeBuffer(device, values, usage) {
  const source = values instanceof ArrayBuffer ? new Uint8Array(values) : values;
  const byteLength = source.byteLength;
  const buffer = device.createBuffer({ size: Math.max(4, byteLength), usage });
  if (byteLength) device.queue.writeBuffer(buffer, 0, source);
  return buffer;
}

function checkAbort(signal) {
  if (signal?.aborted) throw abortError();
}

export async function computeWebGpuMatrix({ n, buffers, posWeight, signal, onProgress = () => {} }) {
  if (!globalThis.isSecureContext) throw new Error('WebGPU דורש הקשר מאובטח (HTTPS או localhost)');
  if (!globalThis.navigator?.gpu) throw new Error('הדפדפן אינו חושף WebGPU');
  if (!Number.isSafeInteger(n) || n < 3) throw new RangeError('n must be at least 3');

  const adapter = await navigator.gpu.requestAdapter();
  checkAbort(signal);
  if (!adapter) throw new Error('לא נמצא מתאם WebGPU');
  const device = await adapter.requestDevice();
  const createdBuffers = [];
  const destroyDevice = () => {
    for (const buffer of createdBuffers) buffer.destroy();
    device.destroy();
  };
  const abortDevice = () => device.destroy();
  signal?.addEventListener('abort', abortDevice, { once: true });

  try {
    checkAbort(signal);
    const flatSegments = Float32Array.from(new Float64Array(buffers.flat));
    const flatMids = Float32Array.from(new Float64Array(buffers.flatMid));
    const flatWeights = Float32Array.from(new Float64Array(buffers.flatWeight));
    const lengths = Float32Array.from(new Float64Array(buffers.totalLens));
    const outputBytes = n * n * Float32Array.BYTES_PER_ELEMENT;
    const storageLimit = Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize);
    if (outputBytes > storageLimit) {
      throw new Error(`מטריצת WebGPU דורשת ${outputBytes} bytes, מעבר למגבלת המאגר ${storageLimit}`);
    }

    const storageUsage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    const segmentBuffer = makeBuffer(device, flatSegments, storageUsage);
    const midBuffer = makeBuffer(device, flatMids, storageUsage);
    const weightBuffer = makeBuffer(device, flatWeights, storageUsage);
    const lengthBuffer = makeBuffer(device, lengths, storageUsage);
    const offsetBuffer = makeBuffer(device, buffers.offsets, storageUsage);
    const resultBuffer = device.createBuffer({
      size: outputBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const readbackBuffer = device.createBuffer({
      size: outputBytes,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    const uniformData = new ArrayBuffer(16);
    const uniformView = new DataView(uniformData);
    uniformView.setUint32(0, n, true);
    uniformView.setFloat32(4, posWeight, true);
    uniformView.setUint32(8, 0, true);
    uniformView.setUint32(12, 1, true);
    const paramsBuffer = makeBuffer(device, uniformData, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    createdBuffers.push(
      segmentBuffer,
      midBuffer,
      weightBuffer,
      lengthBuffer,
      offsetBuffer,
      resultBuffer,
      readbackBuffer,
      paramsBuffer
    );

    const module = device.createShaderModule({ code: SHADER });
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
    checkAbort(signal);
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: segmentBuffer } },
        { binding: 1, resource: { buffer: midBuffer } },
        { binding: 2, resource: { buffer: weightBuffer } },
        { binding: 3, resource: { buffer: lengthBuffer } },
        { binding: 4, resource: { buffer: offsetBuffer } },
        { binding: 5, resource: { buffer: resultBuffer } },
        { binding: 6, resource: { buffer: paramsBuffer } },
      ],
    });
    onProgress(0);
    const rowBatchSize = 128;
    for (let rowStart = 0; rowStart < n; rowStart += rowBatchSize) {
      checkAbort(signal);
      const rowCount = Math.min(rowBatchSize, n - rowStart);
      uniformView.setUint32(8, rowStart, true);
      uniformView.setUint32(12, rowCount, true);
      device.queue.writeBuffer(paramsBuffer, 0, uniformData);
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(Math.ceil(n / 64), rowCount);
      pass.end();
      device.queue.submit([encoder.finish()]);
      await device.queue.onSubmittedWorkDone();
      onProgress(0.9 * Math.min(1, (rowStart + rowCount) / n));
    }
    checkAbort(signal);
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(resultBuffer, 0, readbackBuffer, 0, outputBytes);
    device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();
    onProgress(0.95);
    await readbackBuffer.mapAsync(GPUMapMode.READ);
    checkAbort(signal);
    const result = new Float32Array(readbackBuffer.getMappedRange()).slice();
    readbackBuffer.unmap();
    const validationChunk = 1 << 20;
    for (let start = 0; start < result.length; start += validationChunk) {
      const end = Math.min(result.length, start + validationChunk);
      for (let index = start; index < end; index++) {
        if (!Number.isFinite(result[index])) throw new Error('WebGPU החזיר מרחק לא סופי');
      }
      onProgress(0.95 + 0.05 * end / result.length);
      await new Promise((resolve) => setTimeout(resolve, 0));
      checkAbort(signal);
    }
    onProgress(1);
    return result;
  } finally {
    signal?.removeEventListener('abort', abortDevice);
    destroyDevice();
  }
}
