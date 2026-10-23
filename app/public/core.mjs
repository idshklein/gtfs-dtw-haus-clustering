// Pure numeric routines shared by the Node.js and browser workers.

// DTW with a Sakoe-Chiba band. `prev`/`cur` are scratch rows of length >= maxLen + 1.
export function dtw(data, aOff, aLen, bOff, bLen, winPct, lenNorm, prev, cur) {
  const w = Math.max(Math.ceil((winPct / 100) * Math.max(aLen, bLen)), Math.abs(aLen - bLen), 1);
  prev.fill(Infinity, 0, bLen + 1);
  prev[0] = 0;
  for (let i = 1; i <= aLen; i++) {
    cur.fill(Infinity, 0, bLen + 1);
    const lo = Math.max(1, i - w);
    const hi = Math.min(bLen, i + w);
    const ai = data[aOff + i - 1];
    for (let j = lo; j <= hi; j++) {
      const c = Math.abs(ai - data[bOff + j - 1]);
      const m1 = prev[j];
      const m2 = cur[j - 1];
      const m3 = prev[j - 1];
      cur[j] = c + (m1 < m2 ? (m1 < m3 ? m1 : m3) : m2 < m3 ? m2 : m3);
    }
    const t = prev;
    prev = cur;
    cur = t;
  }
  const d = prev[bLen];
  return lenNorm ? d / (aLen + bLen) : d;
}

// Discrete Fréchet distance with a Sakoe-Chiba band (minimax ordered alignment).
export function discreteFrechet(data, aOff, aLen, bOff, bLen, winPct, prev, cur) {
  if (aLen === 0 || bLen === 0) return Infinity;
  const w = Math.max(Math.ceil((winPct / 100) * Math.max(aLen, bLen)), Math.abs(aLen - bLen), 1);
  prev.fill(Infinity, 0, bLen + 1);
  prev[0] = 0;
  for (let i = 1; i <= aLen; i++) {
    cur.fill(Infinity, 0, bLen + 1);
    const lo = Math.max(1, i - w);
    const hi = Math.min(bLen, i + w);
    const ai = data[aOff + i - 1];
    for (let j = lo; j <= hi; j++) {
      const c = Math.abs(ai - data[bOff + j - 1]);
      const m1 = prev[j];
      const m2 = cur[j - 1];
      const m3 = prev[j - 1];
      const prevMin = m1 < m2 ? (m1 < m3 ? m1 : m3) : m2 < m3 ? m2 : m3;
      cur[j] = c > prevMin ? c : prevMin;
    }
    const t = prev;
    prev = cur;
    cur = t;
  }
  return prev[bLen];
}

function unweightedQuantile(arr, len, q) {
  if (len <= 0) return 0;
  if (q >= 0.9999 || len === 1) {
    let mx = arr[0];
    for (let i = 1; i < len; i++) if (arr[i] > mx) mx = arr[i];
    return mx;
  }
  // In-place insertion sort on scratch slice [0..len)
  for (let i = 1; i < len; i++) {
    const v = arr[i];
    let j = i - 1;
    while (j >= 0 && arr[j] > v) {
      arr[j + 1] = arr[j];
      j--;
    }
    arr[j + 1] = v;
  }
  const idx = Math.min(len - 1, Math.max(0, Math.floor(q * (len - 1))));
  return arr[idx];
}

function weightedQuantile(vals, weights, len, q) {
  if (len <= 0) return 0;
  if (q >= 0.9999 || len === 1) {
    let mx = vals[0];
    for (let i = 1; i < len; i++) if (vals[i] > mx) mx = vals[i];
    return mx;
  }
  for (let i = 1; i < len; i++) {
    const v = vals[i];
    const w = weights[i];
    let j = i - 1;
    while (j >= 0 && vals[j] > v) {
      vals[j + 1] = vals[j];
      weights[j + 1] = weights[j];
      j--;
    }
    vals[j + 1] = v;
    weights[j + 1] = w;
  }
  let acc = 0;
  for (let i = 0; i < len; i++) {
    acc += weights[i];
    if (acc >= q) return vals[i];
  }
  return vals[len - 1];
}

// 1D Hausdorff distance on sorted cumulative stop positions (in meters).
// Complexity: O(aLen + bLen) using two pointers.
export function hausdorff1DCum(data, aOff, aLen, bOff, bLen, aggMode, quantile, scratchD) {
  if (aLen === 0 || bLen === 0) return Infinity;
  let dirAB = 0;
  let j = 0;
  for (let i = 0; i < aLen; i++) {
    const ai = data[aOff + i];
    while (j + 1 < bLen && data[bOff + j + 1] <= ai) j++;
    let best = Math.abs(ai - data[bOff + j]);
    if (j + 1 < bLen) {
      const next = Math.abs(data[bOff + j + 1] - ai);
      if (next < best) best = next;
    }
    if (aggMode === 'mhd') dirAB += best;
    else if (aggMode === 'quantile') scratchD[i] = best;
    else if (best > dirAB) dirAB = best;
  }
  if (aggMode === 'mhd') dirAB /= aLen;
  else if (aggMode === 'quantile') dirAB = unweightedQuantile(scratchD, aLen, quantile);

  let dirBA = 0;
  let i = 0;
  for (let j2 = 0; j2 < bLen; j2++) {
    const bj = data[bOff + j2];
    while (i + 1 < aLen && data[aOff + i + 1] <= bj) i++;
    let best = Math.abs(bj - data[aOff + i]);
    if (i + 1 < aLen) {
      const next = Math.abs(data[aOff + i + 1] - bj);
      if (next < best) best = next;
    }
    if (aggMode === 'mhd') dirBA += best;
    else if (aggMode === 'quantile') scratchD[j2] = best;
    else if (best > dirBA) dirBA = best;
  }
  if (aggMode === 'mhd') dirBA /= bLen;
  else if (aggMode === 'quantile') dirBA = unweightedQuantile(scratchD, bLen, quantile);

  return dirAB > dirBA ? dirAB : dirBA;
}

// 2D Spacing-Profile Hausdorff in uniform meter units: each segment is (midpoint_m, spacing_m).
// Both midData[aOff..aOff+aLen) and midData[bOff..bOff+bLen) are sorted ascending, enabling
// exact branch-and-bound early termination around the moving midpoint pointer.
export function hausdorffSpacingProfile(
  segData,
  midData,
  weightData,
  totalLenData,
  iIdx,
  jIdx,
  aOff,
  aLen,
  bOff,
  bLen,
  posWeight,
  aggMode,
  quantile,
  scratchD,
  scratchW
) {
  if (aLen === 0 || bLen === 0) return Infinity;

  // Directed A -> B
  let dirAB = 0;
  let j0 = 0;
  for (let i = 0; i < aLen; i++) {
    const mi = midData[aOff + i];
    const si = segData[aOff + i];
    while (j0 + 1 < bLen && midData[bOff + j0 + 1] <= mi) j0++;
    const dx0 = posWeight * Math.abs(mi - midData[bOff + j0]);
    const dy0 = Math.abs(si - segData[bOff + j0]);
    let best = dx0 > dy0 ? dx0 : dy0;

    if (posWeight > 0) {
      for (let j = j0 + 1; j < bLen; j++) {
        const dx = posWeight * (midData[bOff + j] - mi);
        if (dx >= best) break;
        const dy = Math.abs(si - segData[bOff + j]);
        const d = dx > dy ? dx : dy;
        if (d < best) best = d;
      }
      for (let j = j0 - 1; j >= 0; j--) {
        const dx = posWeight * (mi - midData[bOff + j]);
        if (dx >= best) break;
        const dy = Math.abs(si - segData[bOff + j]);
        const d = dx > dy ? dx : dy;
        if (d < best) best = d;
      }
    } else {
      for (let j = 0; j < bLen; j++) {
        const dy = Math.abs(si - segData[bOff + j]);
        if (dy < best) best = dy;
      }
    }

    if (aggMode === 'wmhd') {
      dirAB += weightData[aOff + i] * best;
    } else if (aggMode === 'quantile') {
      scratchD[i] = best;
      scratchW[i] = weightData[aOff + i];
    } else if (best > dirAB) {
      dirAB = best;
    }
  }
  if (aggMode === 'quantile') dirAB = weightedQuantile(scratchD, scratchW, aLen, quantile);

  // Directed B -> A
  let dirBA = 0;
  let i0 = 0;
  for (let j = 0; j < bLen; j++) {
    const mj = midData[bOff + j];
    const sj = segData[bOff + j];
    while (i0 + 1 < aLen && midData[aOff + i0 + 1] <= mj) i0++;
    const dx0 = posWeight * Math.abs(mj - midData[aOff + i0]);
    const dy0 = Math.abs(sj - segData[aOff + i0]);
    let best = dx0 > dy0 ? dx0 : dy0;

    if (posWeight > 0) {
      for (let i = i0 + 1; i < aLen; i++) {
        const dx = posWeight * (midData[aOff + i] - mj);
        if (dx >= best) break;
        const dy = Math.abs(sj - segData[aOff + i]);
        const d = dx > dy ? dx : dy;
        if (d < best) best = d;
      }
      for (let i = i0 - 1; i >= 0; i--) {
        const dx = posWeight * (mj - midData[aOff + i]);
        if (dx >= best) break;
        const dy = Math.abs(sj - segData[aOff + i]);
        const d = dx > dy ? dx : dy;
        if (d < best) best = d;
      }
    } else {
      for (let i = 0; i < aLen; i++) {
        const dy = Math.abs(sj - segData[aOff + i]);
        if (dy < best) best = dy;
      }
    }

    if (aggMode === 'wmhd') {
      dirBA += weightData[bOff + j] * best;
    } else if (aggMode === 'quantile') {
      scratchD[j] = best;
      scratchW[j] = weightData[bOff + j];
    } else if (best > dirBA) {
      dirBA = best;
    }
  }
  if (aggMode === 'quantile') dirBA = weightedQuantile(scratchD, scratchW, bLen, quantile);

  const profileDist = dirAB > dirBA ? dirAB : dirBA;
  const lengthDiff = posWeight * Math.abs(totalLenData[iIdx] - totalLenData[jIdx]);
  return profileDist > lengthDiff ? profileDist : lengthDiff;
}

// 2D Hausdorff on the normalized cumulative profile (d_i / L, i / (n - 1)) in [0, 1]^2 (Lévy / Lorenz shape).
export function hausdorffNorm2D(xData, yData, aOff, aLen, bOff, bLen, aggMode, quantile, scratchD) {
  if (aLen === 0 || bLen === 0) return Infinity;

  let dirAB = 0;
  let j0 = 0;
  for (let i = 0; i < aLen; i++) {
    const xi = xData[aOff + i];
    const yi = yData[aOff + i];
    while (j0 + 1 < bLen && xData[bOff + j0 + 1] <= xi) j0++;
    const dx0 = xi - xData[bOff + j0];
    const dy0 = yi - yData[bOff + j0];
    let bestSq = dx0 * dx0 + dy0 * dy0;

    for (let j = j0 + 1; j < bLen; j++) {
      const dx = xData[bOff + j] - xi;
      if (dx * dx >= bestSq) break;
      const dy = yi - yData[bOff + j];
      const dSq = dx * dx + dy * dy;
      if (dSq < bestSq) bestSq = dSq;
    }
    for (let j = j0 - 1; j >= 0; j--) {
      const dx = xi - xData[bOff + j];
      if (dx * dx >= bestSq) break;
      const dy = yi - yData[bOff + j];
      const dSq = dx * dx + dy * dy;
      if (dSq < bestSq) bestSq = dSq;
    }

    const best = Math.sqrt(bestSq);
    if (aggMode === 'mhd') dirAB += best;
    else if (aggMode === 'quantile') scratchD[i] = best;
    else if (best > dirAB) dirAB = best;
  }
  if (aggMode === 'mhd') dirAB /= aLen;
  else if (aggMode === 'quantile') dirAB = unweightedQuantile(scratchD, aLen, quantile);

  let dirBA = 0;
  let i0 = 0;
  for (let j = 0; j < bLen; j++) {
    const xj = xData[bOff + j];
    const yj = yData[bOff + j];
    while (i0 + 1 < aLen && xData[aOff + i0 + 1] <= xj) i0++;
    const dx0 = xj - xData[aOff + i0];
    const dy0 = yj - yData[aOff + i0];
    let bestSq = dx0 * dx0 + dy0 * dy0;

    for (let i = i0 + 1; i < aLen; i++) {
      const dx = xData[aOff + i] - xj;
      if (dx * dx >= bestSq) break;
      const dy = yj - yData[aOff + i];
      const dSq = dx * dx + dy * dy;
      if (dSq < bestSq) bestSq = dSq;
    }
    for (let i = i0 - 1; i >= 0; i--) {
      const dx = xj - xData[aOff + i];
      if (dx * dx >= bestSq) break;
      const dy = yj - yData[aOff + i];
      const dSq = dx * dx + dy * dy;
      if (dSq < bestSq) bestSq = dSq;
    }

    const best = Math.sqrt(bestSq);
    if (aggMode === 'mhd') dirBA += best;
    else if (aggMode === 'quantile') scratchD[j] = best;
    else if (best > dirBA) dirBA = best;
  }
  if (aggMode === 'mhd') dirBA /= bLen;
  else if (aggMode === 'quantile') dirBA = unweightedQuantile(scratchD, bLen, quantile);

  return dirAB > dirBA ? dirAB : dirBA;
}

// ---------- silhouette (labels < 0 = noise, ignored) ----------
export function silhouette(D, n, labels, k) {
  const sizes = new Float64Array(k);
  for (let i = 0; i < n; i++) if (labels[i] >= 0) sizes[labels[i]]++;
  const s = new Float64Array(n).fill(NaN);
  const sums = new Float64Array(k);
  for (let i = 0; i < n; i++) {
    const li = labels[i];
    if (li < 0) continue;
    sums.fill(0);
    const row = i * n;
    for (let j = 0; j < n; j++) {
      const lj = labels[j];
      if (lj >= 0) sums[lj] += D[row + j];
    }
    if (sizes[li] <= 1) {
      s[i] = 0;
      continue;
    }
    const a = sums[li] / (sizes[li] - 1);
    let b = Infinity;
    for (let c = 0; c < k; c++) if (c !== li && sizes[c] > 0) b = Math.min(b, sums[c] / sizes[c]);
    s[i] = b === Infinity ? 0 : (b - a) / Math.max(a, b, 1e-12);
  }
  const perCluster = new Float64Array(k);
  let total = 0;
  let cnt = 0;
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(s[i])) continue;
    perCluster[labels[i]] += s[i];
    total += s[i];
    cnt++;
  }
  for (let c = 0; c < k; c++) perCluster[c] = sizes[c] ? perCluster[c] / sizes[c] : 0;
  return { mean: cnt ? total / cnt : 0, perCluster: Array.from(perCluster), perPoint: s };
}

// ---------- hierarchical clustering (nearest-neighbour chain; average / complete / single) ----------
export function hierarchical(D, n, linkage, onProgress) {
  const W = new Float32Array(D); // working copy
  const active = new Uint8Array(n).fill(1);
  const size = new Float64Array(n).fill(1);
  const node = Int32Array.from({ length: n }, (_, index) => index);
  const ma = new Int32Array(n - 1);
  const mb = new Int32Array(n - 1);
  const mh = new Float64Array(n - 1);
  const chain = [];
  let m = 0;
  let firstActive = 0;
  while (m < n - 1) {
    if (chain.length === 0) {
      while (!active[firstActive]) firstActive++;
      chain.push(firstActive);
    }
    let a, b, bj, best;
    for (;;) {
      a = chain[chain.length - 1];
      b = chain.length > 1 ? chain[chain.length - 2] : -1;
      best = b >= 0 ? W[a * n + b] : Infinity;
      bj = b;
      const row = a * n;
      for (let j = 0; j < n; j++) {
        if (!active[j] || j === a) continue;
        const d = W[row + j];
        if (d < best) {
          best = d;
          bj = j;
        }
      }
      if (bj === b) break;
      chain.push(bj);
    }
    chain.pop();
    chain.pop();
    // merge a into b (slot b keeps the new cluster)
    const sa = size[a];
    const sb = size[b];
    for (let j = 0; j < n; j++) {
      if (!active[j] || j === a || j === b) continue;
      const da = W[a * n + j];
      const db = W[b * n + j];
      const v =
        linkage === 'complete' ? Math.max(da, db) : linkage === 'single' ? Math.min(da, db) : (sa * da + sb * db) / (sa + sb);
      W[b * n + j] = v;
      W[j * n + b] = v;
    }
    active[a] = 0;
    size[b] = sa + sb;
    ma[m] = node[a];
    mb[m] = node[b];
    mh[m] = best;
    node[b] = n + m;
    m++;
    if (onProgress && (m & 255) === 0) onProgress(m / (n - 1));
  }
  const order = Array.from({ length: n - 1 }, (_, index) => index)
    .sort((left, right) => mh[left] - mh[right] || left - right);
  const remap = new Int32Array(2 * n - 1).fill(-1);
  for (let leaf = 0; leaf < n; leaf++) remap[leaf] = leaf;
  const sortedA = new Int32Array(n - 1);
  const sortedB = new Int32Array(n - 1);
  const sortedH = new Float64Array(n - 1);
  for (let next = 0; next < order.length; next++) {
    const previous = order[next];
    const left = remap[ma[previous]];
    const right = remap[mb[previous]];
    if (left < 0 || right < 0) throw new RangeError('hierarchical merge heights are not topologically ordered');
    sortedA[next] = left;
    sortedB[next] = right;
    sortedH[next] = mh[previous];
    remap[n + previous] = n + next;
  }
  return { a: sortedA, b: sortedB, h: sortedH };
}

// Labels after applying the merges with the smallest heights so that k clusters remain
export function cutTree(merges, n, k) {
  const steps = n - Math.max(1, Math.min(k, n));
  const active = new Set(Array.from({ length: n }, (_, index) => index));
  for (let merge = 0; merge < steps; merge++) {
    active.delete(merges.a[merge]);
    active.delete(merges.b[merge]);
    active.add(n + merge);
  }
  return labelsFromTreeNodes(merges, n, [...active]);
}

function labelsFromTreeNodes(merges, n, nodes) {
  const labels = new Int32Array(n);
  nodes.forEach((node, label) => {
    const stack = [node];
    while (stack.length) {
      const current = stack.pop();
      if (current < n) {
        labels[current] = label;
      } else {
        const merge = current - n;
        if (merge < 0 || merge >= n - 1) throw new RangeError('tree contains an invalid node id');
        stack.push(merges.a[merge], merges.b[merge]);
      }
    }
  });
  return labels;
}

export function treeCutNodes(merges, n, labels) {
  if (labels.length !== n || merges.a.length !== n - 1 || merges.b.length !== n - 1) {
    throw new RangeError('labels and merges must describe a complete tree for n items');
  }
  const nodeLabels = new Int32Array(2 * n - 1);
  nodeLabels.set(labels, 0);
  for (let merge = 0; merge < n - 1; merge++) {
    const left = merges.a[merge];
    const right = merges.b[merge];
    nodeLabels[n + merge] = nodeLabels[left] >= 0 && nodeLabels[left] === nodeLabels[right]
      ? nodeLabels[left]
      : -1;
  }
  const nodes = [];
  const stack = [2 * n - 2];
  while (stack.length) {
    const node = stack.pop();
    if (node < n || nodeLabels[node] >= 0) {
      nodes.push(node);
    } else {
      const merge = node - n;
      stack.push(merges.b[merge], merges.a[merge]);
    }
  }
  return nodes;
}

export function cutTreeAtHeight(merges, n, height) {
  if (!Number.isFinite(height)) throw new RangeError('height must be finite');
  if (n < 1 || merges.a.length !== n - 1 || merges.b.length !== n - 1 || merges.h.length !== n - 1) {
    throw new RangeError('merges must describe a complete tree for n items');
  }
  const nodes = [];
  const stack = [2 * n - 2];
  while (stack.length) {
    const node = stack.pop();
    if (node < n || merges.h[node - n] <= height) {
      nodes.push(node);
    } else {
      const merge = node - n;
      stack.push(merges.b[merge], merges.a[merge]);
    }
  }
  return { labels: labelsFromTreeNodes(merges, n, nodes), clusters: nodes };
}

function makeMaxHeap(key = 'info') {
  const items = [];
  const before = (left, right) => left[key] > right[key] || (left[key] === right[key] && left.node < right.node);
  return {
    get size() { return items.length; },
    peek() { return items[0]; },
    push(value) {
      let index = items.push(value) - 1;
      while (index > 0) {
        const parent = (index - 1) >> 1;
        if (!before(items[index], items[parent])) break;
        [items[index], items[parent]] = [items[parent], items[index]];
        index = parent;
      }
    },
    pop() {
      const first = items[0];
      const last = items.pop();
      if (items.length) {
        items[0] = last;
        let index = 0;
        while (true) {
          const left = index * 2 + 1;
          const right = left + 1;
          let best = index;
          if (left < items.length && before(items[left], items[best])) best = left;
          if (right < items.length && before(items[right], items[best])) best = right;
          if (best === index) break;
          [items[index], items[best]] = [items[best], items[index]];
          index = best;
        }
      }
      return first;
    },
  };
}

export function divisiveInformationCut(
  merges,
  n,
  features,
  { k = null, tau = null, frac = null, criterion = 'inner' } = {}
) {
  const featureCount = 4;
  const bins = 5;
  const yCount = featureCount * bins;
  const nodeCount = 2 * n - 1;
  if (n < 2 || merges.a.length !== n - 1 || merges.b.length !== n - 1 || merges.h.length !== n - 1) {
    throw new RangeError('merges must describe a complete tree for n items');
  }
  if (!features || features.length !== n * featureCount) {
    throw new RangeError(`features must contain ${n * featureCount} values (four per item)`);
  }
  if (!Number.isSafeInteger(k) && k !== null) throw new RangeError('k must be an integer');
  if (k !== null && (k < 1 || k > n)) throw new RangeError('k must be between 1 and n');
  if (tau !== null && (!Number.isFinite(tau) || tau < 0)) throw new RangeError('tau must be finite and non-negative');
  if (frac !== null && (!Number.isFinite(frac) || frac < 0 || frac > 1)) throw new RangeError('frac must be between 0 and 1');
  if (!['inner', 'gain'].includes(criterion)) throw new RangeError('criterion must be inner or gain');
  if (k === null && tau === null && frac === null) throw new RangeError('an information-cut stopping condition is required');

  const thresholds = Array.from({ length: featureCount }, (_, feature) => {
    const values = [];
    for (let item = 0; item < n; item++) {
      const value = Number(features[item * featureCount + feature]);
      if (!Number.isFinite(value)) {
        throw new RangeError(`feature ${feature + 1} is missing or non-finite for item ${item + 1}`);
      }
      values.push(value);
    }
    values.sort((left, right) => left - right);
    const out = [];
    for (let bin = 1; bin < bins; bin++) {
      const boundary = values[Math.ceil((bin * n) / bins) - 1];
      if (out.length === 0 || boundary > out[out.length - 1]) out.push(boundary);
    }
    return out;
  });

  const mass = new Float64Array(nodeCount);
  const entropySum = new Float64Array(nodeCount);
  const inner = new Float64Array(nodeCount);
  const gain = new Float64Array(nodeCount);
  const distributions = new Float64Array(nodeCount * yCount);
  const itemMass = 1 / n;
  const itemEntropy = Math.log2(featureCount);
  for (let item = 0; item < n; item++) {
    mass[item] = itemMass;
    entropySum[item] = itemMass * itemEntropy;
    for (let feature = 0; feature < featureCount; feature++) {
      const value = Number(features[item * featureCount + feature]);
      const boundaries = thresholds[feature];
      let bin = 0;
      while (bin < boundaries.length && value > boundaries[bin]) bin++;
      distributions[item * yCount + feature * bins + bin] = itemMass / featureCount;
    }
  }

  for (let merge = 0; merge < n - 1; merge++) {
    const left = merges.a[merge];
    const right = merges.b[merge];
    const node = n + merge;
    if (left < 0 || right < 0 || left >= node || right >= node) {
      throw new RangeError(`merge ${merge} contains an invalid or forward child node`);
    }
    mass[node] = mass[left] + mass[right];
    entropySum[node] = entropySum[left] + entropySum[right];
    const offset = node * yCount;
    const leftOffset = left * yCount;
    const rightOffset = right * yCount;
    let entropy = 0;
    for (let y = 0; y < yCount; y++) {
      const value = distributions[leftOffset + y] + distributions[rightOffset + y];
      distributions[offset + y] = value;
      if (value > 0) entropy -= value * Math.log2(value);
    }
    inner[node] = Math.max(0, entropy + mass[node] * Math.log2(mass[node]) - entropySum[node]);
    gain[node] = Math.max(0, inner[node] - inner[left] - inner[right]);
  }

  const root = nodeCount - 1;
  const totalInformation = inner[root];
  let totalInner = totalInformation;
  const heap = makeMaxHeap('priority');
  const innerHeap = makeMaxHeap('info');
  const active = new Uint8Array(nodeCount);
  const done = [];
  const enqueue = (node) => {
    active[node] = 1;
    const info = inner[node];
    heap.push({ node, info, priority: node < n && criterion === 'gain' ? -Infinity : criterion === 'gain' ? gain[node] : info });
    innerHeap.push({ node, info });
  };
  enqueue(root);
  let activeCount = 1;
  while (heap.size) {
    if (k !== null && activeCount >= k) break;
    while (innerHeap.size && !active[innerHeap.peek().node]) innerHeap.pop();
    if (tau !== null && innerHeap.size && innerHeap.peek().info <= tau) break;
    if (frac !== null && totalInformation - totalInner >= frac * totalInformation) break;

    const { node } = heap.pop();
    if (!active[node]) continue;
    if (node < n) {
      done.push(node);
      continue;
    }
    active[node] = 0;
    const merge = node - n;
    const left = merges.a[merge];
    const right = merges.b[merge];
    totalInner += inner[left] + inner[right] - inner[node];
    activeCount++;
    enqueue(left);
    enqueue(right);
  }
  const clusters = done.concat(Array.from({ length: heap.size }, () => heap.pop().node).filter((node) => active[node]));
  clusters.sort((left, right) => left - right);
  const explainedInformation = Math.max(0, totalInformation - totalInner);
  return {
    labels: labelsFromTreeNodes(merges, n, clusters),
    clusters,
    information: {
      total: totalInformation,
      explained: explainedInformation,
      inner: totalInner,
      preservedFraction: totalInformation > 0 ? explainedInformation / totalInformation : 1,
      maxActiveInner: clusters.reduce((maximum, node) => Math.max(maximum, inner[node]), 0),
      criterion,
    },
  };
}

// Cut at every k in [kMin, kMax] in one pass (descending), calling cb(k, labels)
export function cutTreeRange(merges, n, kMin, kMax, cb) {
  let clusters = n;
  let merge = 0;
  const active = new Set(Array.from({ length: n }, (_, index) => index));
  for (let k = kMax; k >= kMin; k--) {
    while (clusters > k && merge < n - 1) {
      active.delete(merges.a[merge]);
      active.delete(merges.b[merge]);
      active.add(n + merge);
      clusters--;
      merge++;
    }
    cb(k, labelsFromTreeNodes(merges, n, [...active]));
  }
}

function relabel(raw) {
  const map = new Map();
  const out = new Int32Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] < 0) {
      out[i] = -1;
      continue;
    }
    if (!map.has(raw[i])) map.set(raw[i], map.size);
    out[i] = map.get(raw[i]);
  }
  return out;
}

// ---------- k-medoids (greedy BUILD init + alternating updates) ----------
export function kMedoids(D, n, k, maxIter = 50) {
  const medoids = [];
  let bestSum = Infinity;
  let first = 0;
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += D[i * n + j];
    if (s < bestSum) {
      bestSum = s;
      first = i;
    }
  }
  medoids.push(first);
  const near = new Float64Array(n);
  for (let j = 0; j < n; j++) near[j] = D[first * n + j];
  while (medoids.length < k) {
    let bestGain = -1;
    let bi = -1;
    for (let i = 0; i < n; i++) {
      if (medoids.includes(i)) continue;
      let gain = 0;
      const row = i * n;
      for (let j = 0; j < n; j++) {
        const g = near[j] - D[row + j];
        if (g > 0) gain += g;
      }
      if (gain > bestGain) {
        bestGain = gain;
        bi = i;
      }
    }
    medoids.push(bi);
    for (let j = 0; j < n; j++) near[j] = Math.min(near[j], D[bi * n + j]);
  }
  const labels = new Int32Array(n);
  const assign = () => {
    let cost = 0;
    for (let j = 0; j < n; j++) {
      let bd = Infinity;
      let bc = 0;
      for (let c = 0; c < k; c++) {
        const d = D[medoids[c] * n + j];
        if (d < bd) {
          bd = d;
          bc = c;
        }
      }
      labels[j] = bc;
      cost += bd;
    }
    return cost;
  };
  let cost = assign();
  for (let it = 0; it < maxIter; it++) {
    let changed = false;
    for (let c = 0; c < k; c++) {
      const members = [];
      for (let j = 0; j < n; j++) if (labels[j] === c) members.push(j);
      let bm = medoids[c];
      let bs = Infinity;
      for (const i of members) {
        let s = 0;
        for (const j of members) s += D[i * n + j];
        if (s < bs) {
          bs = s;
          bm = i;
        }
      }
      if (bm !== medoids[c]) {
        medoids[c] = bm;
        changed = true;
      }
    }
    if (!changed) break;
    cost = assign();
  }
  return { labels, medoids, cost };
}

// ---------- DBSCAN on a precomputed matrix ----------
export function dbscan(D, n, eps, minPts) {
  if (!Number.isInteger(n) || n < 1 || D.length !== n * n) {
    throw new RangeError('matrix must contain n * n distances');
  }
  if (!Number.isFinite(eps) || eps < 0) {
    throw new RangeError('eps must be finite and non-negative');
  }
  if (!Number.isSafeInteger(minPts) || minPts < 1) {
    throw new RangeError('minPts must be a positive integer');
  }
  const labels = new Int32Array(n).fill(-2); // -2 = unvisited, -1 = noise
  const neighbors = (i) => {
    const out = [];
    const row = i * n;
    for (let j = 0; j < n; j++) if (D[row + j] <= eps) out.push(j);
    return out;
  };
  let cluster = 0;
  for (let i = 0; i < n; i++) {
    if (labels[i] !== -2) continue;
    const nb = neighbors(i);
    if (nb.length < minPts) {
      labels[i] = -1;
      continue;
    }
    labels[i] = cluster;
    const queue = nb.slice();
    for (let q = 0; q < queue.length; q++) {
      const p = queue[q];
      if (labels[p] === -1) labels[p] = cluster;
      if (labels[p] !== -2) continue;
      labels[p] = cluster;
      const nb2 = neighbors(p);
      if (nb2.length >= minPts) for (const x of nb2) if (labels[x] < 0) queue.push(x);
    }
    cluster++;
  }
  return { labels, k: cluster };
}

export function medoidsOf(D, n, labels, k) {
  const members = Array.from({ length: k }, () => []);
  for (let i = 0; i < n; i++) if (labels[i] >= 0) members[labels[i]].push(i);
  return members.map((mem) => {
    let bm = mem[0] ?? -1;
    let bs = Infinity;
    for (const i of mem) {
      let s = 0;
      for (const j of mem) s += D[i * n + j];
      if (s < bs) {
        bs = s;
        bm = i;
      }
    }
    return bm;
  });
}

// ---------- classical MDS (matrix-free Lanczos) ----------
export function mds(D, n, dimensions = 2, maxLanczos = 64) {
  if (!Number.isInteger(n) || n < 1 || D.length !== n * n) throw new RangeError('distance matrix must contain n * n values');
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 10) throw new RangeError('MDS dimensions must be between 1 and 10');
  if (!Number.isInteger(maxLanczos) || maxLanczos < 1) throw new RangeError('maxLanczos must be a positive integer');
  if (n < 2) {
    const coordinates = new Float32Array(n * dimensions);
    return {
      xy: new Float32Array(n * 2), coordinates, eigenvalues: Array(dimensions).fill(0),
      spectrum: [], explainedVariance: Array(dimensions).fill(0),
      cumulativeExplainedVariance: Array(dimensions).fill(0), positiveEigenvalueTotal: 0,
      varianceScope: 'Lanczos projected subspace', fullSpectrum: true,
      axisRatio: 0, iterations: 0, dimensions,
    };
  }
  const rmean = new Float64Array(n);
  let g = 0;
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) {
      const d = D[i * n + j];
      s += d * d;
    }
    rmean[i] = s / n;
    g += rmean[i];
  }
  g /= n;
  const mulB = (v, out) => {
    let sv = 0;
    let rv = 0;
    for (let i = 0; i < n; i++) {
      sv += v[i];
      rv += rmean[i] * v[i];
    }
    for (let i = 0; i < n; i++) {
      let s = 0;
      const row = i * n;
      for (let j = 0; j < n; j++) {
        const d = D[row + j];
        s += d * d * v[j];
      }
      out[i] = -0.5 * (s - rmean[i] * sv - rv + g * sv);
    }
  };
  let used;
  let basis;
  let T;
  let eigVecs;
  if (n <= 64) {
    used = n;
    basis = new Float64Array(n * n);
    T = new Float64Array(n * n);
    eigVecs = new Float64Array(n * n);
    for (let i = 0; i < n; i++) {
      basis[i * n + i] = 1;
      eigVecs[i * n + i] = 1;
      for (let j = 0; j < n; j++) {
        T[i * n + j] = -0.5 * (D[i * n + j] ** 2 - rmean[i] - rmean[j] + g);
      }
    }
  } else {
    const steps = Math.min(n, maxLanczos);
    basis = new Float64Array(steps * n);
    const alpha = new Float64Array(steps);
    const beta = new Float64Array(Math.max(steps - 1, 0));
    const q = basis.subarray(0, n);
    let seed = (0x9e3779b9 ^ n) >>> 0;
    const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
    let mean = 0;
    for (let i = 0; i < n; i++) {
      q[i] = random() - 0.5;
      mean += q[i];
    }
    mean /= n;
    let norm = 0;
    for (let i = 0; i < n; i++) {
      q[i] -= mean;
      norm += q[i] * q[i];
    }
    norm = Math.sqrt(norm);
    for (let i = 0; i < n; i++) q[i] /= norm;

    const z = new Float64Array(n);
    const qPrev = new Float64Array(n);
    let betaPrev = 0;
    used = 0;
    for (let j = 0; j < steps; j++) {
      const qj = basis.subarray(j * n, (j + 1) * n);
      mulB(qj, z);
      let a = 0;
      for (let i = 0; i < n; i++) a += qj[i] * z[i];
      alpha[j] = a;
      for (let i = 0; i < n; i++) z[i] -= a * qj[i] + betaPrev * qPrev[i];

      for (let pass = 0; pass < 2; pass++) {
        for (let k = 0; k <= j; k++) {
          const qk = basis.subarray(k * n, (k + 1) * n);
          let dot = 0;
          for (let i = 0; i < n; i++) dot += qk[i] * z[i];
          for (let i = 0; i < n; i++) z[i] -= dot * qk[i];
        }
      }
      let b = 0;
      for (let i = 0; i < n; i++) b += z[i] * z[i];
      b = Math.sqrt(b);
      used = j + 1;
      if (j === steps - 1 || b <= 1e-12 * Math.max(1, Math.abs(a))) break;
      beta[j] = b;
      qPrev.set(qj);
      betaPrev = b;
      const qNext = basis.subarray((j + 1) * n, (j + 2) * n);
      for (let i = 0; i < n; i++) qNext[i] = z[i] / b;
    }

    T = new Float64Array(used * used);
    eigVecs = new Float64Array(used * used);
    for (let i = 0; i < used; i++) {
      T[i * used + i] = alpha[i];
      eigVecs[i * used + i] = 1;
      if (i + 1 < used) T[i * used + i + 1] = T[(i + 1) * used + i] = beta[i];
    }
  }
  for (let sweep = 0; sweep < 50; sweep++) {
    let maxOff = 0;
    for (let p = 0; p < used - 1; p++) {
      for (let r = p + 1; r < used; r++) {
        const apr = T[p * used + r];
        maxOff = Math.max(maxOff, Math.abs(apr));
        if (Math.abs(apr) <= 1e-14) continue;
        const app = T[p * used + p];
        const arr = T[r * used + r];
        const tau = (arr - app) / (2 * apr);
        const t = (tau < 0 ? -1 : 1) / (Math.abs(tau) + Math.sqrt(1 + tau * tau));
        const c = 1 / Math.sqrt(1 + t * t);
        const s = t * c;
        for (let k = 0; k < used; k++) {
          if (k === p || k === r) continue;
          const akp = T[k * used + p];
          const akr = T[k * used + r];
          T[k * used + p] = T[p * used + k] = c * akp - s * akr;
          T[k * used + r] = T[r * used + k] = s * akp + c * akr;
        }
        T[p * used + p] = app - t * apr;
        T[r * used + r] = arr + t * apr;
        T[p * used + r] = T[r * used + p] = 0;
        for (let k = 0; k < used; k++) {
          const vkp = eigVecs[k * used + p];
          const vkr = eigVecs[k * used + r];
          eigVecs[k * used + p] = c * vkp - s * vkr;
          eigVecs[k * used + r] = s * vkp + c * vkr;
        }
      }
    }
    if (maxOff < 1e-12) break;
  }

  const order = Array.from({ length: used }, (_, i) => i).sort((a, b) => T[b * used + b] - T[a * used + a]);
  const spectrum = order.map((i) => T[i * used + i]);
  const eigenvalues = Array.from({ length: dimensions }, (_, axis) => spectrum[axis] ?? 0);
  const positiveEigenvalueTotal = spectrum.reduce((sum, value) => sum + Math.max(value, 0), 0);
  const explainedVariance = eigenvalues.map((value) => positiveEigenvalueTotal > 0 ? Math.max(value, 0) / positiveEigenvalueTotal : 0);
  const cumulativeExplainedVariance = [];
  explainedVariance.reduce((sum, value, axis) => (cumulativeExplainedVariance[axis] = sum + value), 0);
  const coordinates = new Float32Array(n * dimensions);
  for (let axis = 0; axis < dimensions; axis++) {
    const eigIndex = order[axis];
    if (eigIndex == null) continue;
    const scale = Math.sqrt(Math.max(eigenvalues[axis], 0));
    if (!scale) continue;
    for (let j = 0; j < used; j++) {
      const weight = eigVecs[j * used + eigIndex] * scale;
      const qj = basis.subarray(j * n, (j + 1) * n);
      for (let i = 0; i < n; i++) coordinates[i * dimensions + axis] += qj[i] * weight;
    }
  }
  const xy = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    xy[i * 2] = coordinates[i * dimensions];
    xy[i * 2 + 1] = dimensions > 1 ? coordinates[i * dimensions + 1] : 0;
  }
  return {
    xy,
    coordinates,
    eigenvalues,
    spectrum,
    explainedVariance,
    cumulativeExplainedVariance,
    positiveEigenvalueTotal,
    varianceScope: used === n ? 'full positive spectrum' : 'Lanczos projected subspace',
    fullSpectrum: used === n,
    axisRatio: eigenvalues[0] > 0 ? Math.max(eigenvalues[1], 0) / eigenvalues[0] : 0,
    iterations: used,
    dimensions,
  };
}

export function mds2d(D, n, maxLanczos = 64) {
  return mds(D, n, 2, maxLanczos);
}

function averageRanks(values) {
  const order = Array.from({ length: values.length }, (_, index) => index)
    .sort((left, right) => values[left] - values[right]);
  const ranks = new Float64Array(values.length);
  for (let start = 0; start < order.length;) {
    let end = start + 1;
    while (end < order.length && values[order[end]] === values[order[start]]) end++;
    const rank = (start + end - 1) / 2;
    for (let index = start; index < end; index++) ranks[order[index]] = rank;
    start = end;
  }
  return ranks;
}

function pearson(x, y) {
  if (x.length < 2 || y.length !== x.length) return null;
  const meanX = x.reduce((sum, value) => sum + value, 0) / x.length;
  const meanY = y.reduce((sum, value) => sum + value, 0) / y.length;
  let numerator = 0;
  let sumX = 0;
  let sumY = 0;
  for (let index = 0; index < x.length; index++) {
    const dx = x[index] - meanX;
    const dy = y[index] - meanY;
    numerator += dx * dy;
    sumX += dx * dx;
    sumY += dy * dy;
  }
  if (sumX === 0 || sumY === 0) return null;
  return numerator / Math.sqrt(sumX * sumY);
}

export function mdsFeatureCorrelations(coordinates, dimensions, features, n, featureCount = 4) {
  if (!Number.isInteger(dimensions) || dimensions < 1 || coordinates.length !== n * dimensions) {
    throw new RangeError('coordinates must contain n * dimensions values');
  }
  if (features.length !== n * featureCount) throw new RangeError('feature matrix has an invalid length');
  const correlations = [];
  for (let axis = 0; axis < Math.min(2, dimensions); axis++) {
    for (let feature = 0; feature < featureCount; feature++) {
      const x = [];
      const y = [];
      for (let item = 0; item < n; item++) {
        const coordinate = Number(coordinates[item * dimensions + axis]);
        const value = Number(features[item * featureCount + feature]);
        if (Number.isFinite(coordinate) && Number.isFinite(value)) {
          x.push(coordinate);
          y.push(value);
        }
      }
      correlations.push({
        axis,
        feature,
        count: x.length,
        pearson: pearson(x, y),
        spearman: pearson(averageRanks(x), averageRanks(y)),
      });
    }
  }
  return correlations;
}

// Quantiles of DTW distances over a deterministic sample of pairs (helps pick DBSCAN eps)
export function distanceQuantiles(D, n, qs, samples = 200000) {
  const vals = [];
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let s = 0; s < samples; s++) {
    const i = Math.floor(rnd() * n);
    const j = Math.floor(rnd() * n);
    if (i !== j) vals.push(D[i * n + j]);
  }
  vals.sort((a, b) => a - b);
  return qs.map((q) => vals[Math.min(vals.length - 1, Math.floor(q * vals.length))] ?? 0);
}
