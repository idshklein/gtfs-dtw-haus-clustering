import { browserSupportError, installClientErrorHandlers } from './browser-support.mjs';

const $ = (id) => document.getElementById(id);
const TYPE_NAMES = { 0: 'רכבת קלה', 2: 'רכבת', 3: 'אוטובוס', 5: 'רכבל', 8: 'מעלית', 715: 'לפי דרישה' };
const typeName = (t) => (TYPE_NAMES[t] ? `${t} · ${TYPE_NAMES[t]}` : String(t));
const api = async (url, body) => {
  if (!S.service) throw new Error('שירותי הדפדפן עדיין אינם מוכנים');
  return S.service.request(url, body);
};
const fmt = (x, d = 3) => (x == null || Number.isNaN(x) ? '–' : Number(x).toFixed(d));
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const routeDescription = (s) => s.route_desc ? ` (${s.route_desc})` : '';
const routeLabel = (s) => `${s.route_short_name} · ${s.route_long_name || ''}${routeDescription(s)}`;
const profileHitTargets = new WeakMap();
let shareConfigCodec = null;

const S = { meta: null, service: null, samples: [], points: [], coordinates: [], features: null, mdsInfo: null, labels: null, result: null, profiles: null, selected: -1, activeCluster: null, view: { s: 1, tx: 0, ty: 0 }, bounds: null, config: null, map: null, mapLayers: [], mapStatus: '', workloadRequest: 0 };

// ---------- setup ----------
async function init() {
  const compatibilityError = browserSupportError();
  if (compatibilityError) throw new Error(compatibilityError);

  const manifestUrl = document.querySelector('meta[name="gtfs-manifest"]')?.content;
  if (!manifestUrl) throw new Error('לא הוגדרה כתובת manifest לנתוני GTFS');
  const hardwareCores = Math.max(1, Math.floor(Number(navigator.hardwareConcurrency) || 1));
  const maxWorkers = Math.max(1, Math.min(2, hardwareCores - 2));
  $('statusLine').textContent = 'טוען DuckDB-Wasm ונתוני GTFS בדפדפן…';
  const [{ BrowserGtfsData }, { BrowserAppService }] = await Promise.all([
    import('./data-client.bundle.mjs'),
    import('./browser-service.mjs'),
  ]);
  const dataClient = new BrowserGtfsData({
    manifestUrl,
    onProgress: ({ phase }) => {
      $('statusLine').textContent = `טוען נתוני GTFS בדפדפן: ${phase}`;
    },
  });
  const initialized = await dataClient.init();
  const service = new BrowserAppService({ dataClient, maxWorkers });
  service.setMeta(initialized.meta);
  S.service = service;
  const m = (S.meta = await api('/api/meta'));
  const c = m.counts;
  $('metaLine').textContent = `${c.routes.toLocaleString()} קווים · ${c.patterns.toLocaleString()} תבניות נסיעה ייחודיות · ${c.route_samples.toLocaleString()} קווים עם shape_dist_traveled (${c.patterns_without_dist.toLocaleString()} תבניות ללא מרחק הוצאו)`;
  $('agencies').innerHTML = m.agencies.map((a) => `<option value="${a.agency_id}">${a.agency_name} (${a.n})</option>`).join('');
  $('routeTypes').innerHTML = m.routeTypes.map((t) => `<option value="${t.route_type}">${typeName(t.route_type)} (${t.n})</option>`).join('');
  $('workers').value = Math.max(1, m.cores - 2);
  $('workers').max = m.cores;
  S.shareDefaults = readShareConfig();
  shareConfigCodec = await import('./config-url.mjs');
  const options = {
    defaults: S.shareDefaults,
    agencyIds: m.agencies.map((agency) => String(agency.agency_id)),
    routeTypes: m.routeTypes.map((routeType) => String(routeType.route_type)),
    maxWorkers: m.cores,
  };
  const shared = shareConfigCodec.parseShareConfig(location.search, options, location.href.length);
  if (shared.hasConfig) {
    applyShareConfig(shared.config);
    showShareLoadStatus(shared);
  }
  window.addEventListener('popstate', async () => {
    try {
      const previousConfig = readConfig();
      const next = shareConfigCodec.parseShareConfig(location.search, options, location.href.length);
      applyShareConfig(next.config);
      $('shareConfigPanel').open = next.hasConfig || next.warnings.length > 0;
      $('shareUrl').value = '';
      $('shareUrl').hidden = true;
      $('copyShareUrl').disabled = true;
      showShareLoadStatus(next);
      if (!sameComputeConfig(previousConfig, readConfig())) {
        await api('/api/dtw/cancel');
        clearComputedResult();
      }
      await refreshDataTab();
      await refreshWorkloadEstimate();
    } catch (error) {
      $('statusLine').textContent = `שגיאה בעדכון התצורה מהקישור: ${error.message}`;
    }
  });
  $('createShareUrl').onclick = () => {
    try {
      const url = shareConfigCodec.createShareUrl(`${location.origin}${location.pathname}`, readShareConfig());
      const parsed = shareConfigCodec.parseShareConfig(new URL(url).search, options, url.length);
      if (parsed.warnings.length) throw new Error(parsed.warnings.join(' '));
      $('shareUrl').value = url;
      $('shareUrl').hidden = false;
      $('copyShareUrl').disabled = false;
      $('shareConfigPanel').open = true;
      $('shareStatus').textContent = `הקישור מוכן לשיתוף (${url.length} תווים); הוא כולל תצורה בלבד, ללא תוצאות.`;
    } catch (error) {
      $('shareUrl').value = '';
      $('shareUrl').hidden = true;
      $('copyShareUrl').disabled = true;
      $('shareStatus').textContent = `לא ניתן ליצור קישור: ${error.message}`;
    }
  };
  $('copyShareUrl').onclick = async () => {
    const url = $('shareUrl').value;
    if (!url) {
      $('shareStatus').textContent = 'יש ליצור קישור לפני ההעתקה.';
      return;
    }
    try {
      if (!navigator.clipboard?.writeText) throw new Error('ממשק הלוח אינו זמין בהקשר זה');
      await navigator.clipboard.writeText(url);
      $('shareStatus').textContent = 'הקישור הועתק ללוח.';
    } catch (error) {
      $('shareUrl').focus();
      $('shareUrl').select();
      $('shareStatus').textContent = `העתקה אוטומטית נכשלה (${error.message}); הקישור סומן כדי להעתיקו ידנית.`;
    }
  };
  await refreshDataTab();
  refreshWorkloadEstimate();
  $('statusLine').textContent = `נתוני GTFS נטענו בדפדפן (snapshot ${initialized.version}).`;
}

const METRIC_LABELS = {
  hausdorff_profile_wmhd: 'האוסדורף פרופיל מרווחים משוקלל-אורך (WMHD במטרים)',
  hausdorff_profile_quantile: 'האוסדורף פרופיל מרווחים אחוזוני (H_q במטרים)',
  hausdorff_profile_max: 'האוסדורף פרופיל מרווחים קלאסי (Max במטרים)',
  hausdorff_1d: 'האוסדורף 1D על מיקומי תחנות (במטרים)',
  hausdorff_norm2d: 'האוסדורף 2D מנורמל [0,1]² (ריכוז תחנות)',
  frechet: 'מרחק Fréchet בדיד',
  dtw: 'DTW',
};

const METRIC_HINTS = {
  hausdorff_profile_wmhd: 'יחידות אחידות (מטרים × מטרים): כל מקטע מיוצג כ-(מיקום m_k, מרווח s_k) במטרים, ומשוקלל לפי חלקו באורך הקו (s_k / L) ללא הזזת אינדקס תחנה.',
  hausdorff_profile_quantile: 'יחידות אחידות (מטרים × מטרים): מחשב את אחוזון q של מרחקי ההתאמה הקרובים ביותר במישור (m_k, s_k) במטרים — עמיד למקטעי קצה חריגים.',
  hausdorff_profile_max: 'יחידות אחידות (מטרים × מטרים): מרחק האוסדורף קלאסי (L∞ מקסימלי) בין פרופילי המרווחים (m_k, s_k) במטרים.',
  hausdorff_1d: 'יחידות אחידות (מטרים): מרחק האוסדורף חד-ממדי O(n+m) בין קבוצות מיקומי התחנות המצטברים לאורך הקו ללא אינדקס תחנה.',
  hausdorff_norm2d: 'יחידות אחידות חסרות-ממד [0,1]²: מרחק האוסדורף בין עקומות הריכוז (d_i / L, i / (n-1)) להשוואת צורת פיזור התחנות נטו.',
  frechet: 'האוסדורף שומר-סדר (מינימקס לאורך הרצף במקום סכימה ב-DTW), עם חלון Sakoe-Chiba.',
  dtw: 'יישור גמיש הסוכם הפרשים לאורך הרצף (המתודולוגיה המקורית).',
};

const syncMetricUi = () => {
  const m = $('metric').value;
  const isProfile = m.startsWith('hausdorff_profile_');
  const isSeq = m === 'dtw' || m === 'frechet';
  const usesQuantile = m === 'hausdorff_profile_quantile' || m === 'hausdorff_1d' || m === 'hausdorff_norm2d';
  $('posWeightWrap').hidden = !isProfile;
  $('quantileWrap').hidden = !usesQuantile;
  $('hausdorffWrap').hidden = !isProfile && !usesQuantile;
  $('windowWrap').hidden = !isSeq;
  $('lenNormWrap').hidden = m !== 'dtw';
  $('featureWrap').hidden = m !== 'dtw' && m !== 'frechet';
  $('metricHint').textContent = METRIC_HINTS[m] || '';
};

const syncComputeBackendUi = () => {
  const backend = $('computeBackend').value;
  if (backend === 'cpu') {
    $('computeBackendInfo').textContent = 'CPU הוא מסלול ברירת המחדל. WebGPU אינו מופעל.';
  } else if ($('metric').value !== 'hausdorff_profile_wmhd') {
    $('computeBackendInfo').textContent = 'WebGPU נתמך כרגע רק למדד WMHD; מדדים אחרים יחושבו ב-CPU.';
  } else if (!navigator.gpu || !globalThis.isSecureContext) {
    $('computeBackendInfo').textContent = 'WebGPU אינו זמין בהקשר זה; בעת החישוב יתבצע fallback גלוי ל-CPU.';
  } else {
    $('computeBackendInfo').textContent = 'WMHD ינסה להשתמש ב-WebGPU; במקרה של כשל החישוב ימשיך ב-CPU ותוצג הודעה.';
  }
};

function readConfig() {
  const sel = (id) => [...$(id).selectedOptions].map((o) => o.value);
  return {
    unit: $('unit').value,
    feature: $('feature').value,
    metric: $('metric').value,
    posWeight: +$('posWeight').value,
    quantilePct: +$('quantilePct').value,
    normalize: $('normalize').value,
    agencyIds: sel('agencies'),
    routeTypes: sel('routeTypes'),
    minLen: +$('minLen').value,
    windowPct: +$('windowPct').value,
    workers: +$('workers').value,
    computeBackend: $('computeBackend').value,
    lenNorm: $('lenNorm').checked,
    mdsDims: +$('mdsDims').value,
  };
}

function readShareConfig() {
  return {
    ...readConfig(),
    search: $('search').value,
    algo: $('algo').value,
    linkage: $('linkage').value,
    auto: $('auto').checked,
    k: +$('k').value,
    kMin: +$('kMin').value,
    kMax: +$('kMax').value,
    cutMode: $('cutMode').value,
    cutH: +$('cutH').value,
    cutTau: +$('cutTau').value,
    cutFrac: +$('cutFrac').value,
    eps: $('eps').value === '' ? '' : +$('eps').value,
    minPts: +$('minPts').value,
  };
}

function applyShareConfig(config) {
  $('unit').value = config.unit;
  $('feature').value = config.feature;
  $('metric').value = config.metric;
  $('posWeight').value = config.posWeight;
  $('quantilePct').value = config.quantilePct;
  $('normalize').value = config.normalize;
  $('minLen').value = config.minLen;
  $('windowPct').value = config.windowPct;
  $('workers').value = config.workers;
  $('computeBackend').value = config.computeBackend;
  $('lenNorm').checked = config.lenNorm;
  $('mdsDims').value = config.mdsDims;
  $('search').value = config.search;
  const agencies = new Set(config.agencyIds);
  for (const option of $('agencies').options) option.selected = agencies.has(option.value);
  const routeTypes = new Set(config.routeTypes);
  for (const option of $('routeTypes').options) option.selected = routeTypes.has(option.value);
  $('algo').value = config.algo;
  $('linkage').value = config.linkage;
  $('auto').checked = config.auto;
  $('k').value = config.k;
  $('kMin').value = config.kMin;
  $('kMax').value = config.kMax;
  $('cutMode').value = config.cutMode;
  $('cutH').value = config.cutH;
  $('cutTau').value = config.cutTau;
  $('cutFrac').value = config.cutFrac;
  $('eps').value = config.eps;
  $('minPts').value = config.minPts;
  syncMetricUi();
  syncComputeBackendUi();
  syncAlgoUi();
}

function showShareLoadStatus(parsed) {
  if (!parsed.hasConfig) {
    $('shareStatus').textContent = '';
    return;
  }
  $('shareConfigPanel').open = true;
  $('shareStatus').textContent = parsed.warnings.length
    ? `התצורה נטענה עם אזהרות: ${parsed.warnings.join(' ')}`
    : 'ההגדרות נטענו; הקישור אינו כולל תוצאות. לחצו על „חשב” להרצה חדשה.';
}

function sameComputeConfig(a, b) {
  if (!a || !b) return false;
  const scalarKeys = [
    'unit', 'feature', 'metric', 'posWeight', 'quantilePct', 'normalize',
    'minLen', 'windowPct', 'workers', 'computeBackend', 'lenNorm', 'mdsDims',
  ];
  if (!scalarKeys.every((key) => a[key] === b[key])) return false;
  const sameArray = (left, right) => {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    const sortedLeft = [...left].sort();
    const sortedRight = [...right].sort();
    return sortedLeft.every((value, index) => value === sortedRight[index]);
  };
  return sameArray(a.agencyIds, b.agencyIds) && sameArray(a.routeTypes, b.routeTypes);
}

function clearComputedResult() {
  S.samples = [];
  S.points = [];
  S.coordinates = [];
  S.features = null;
  S.mdsInfo = null;
  S.labels = null;
  S.result = null;
  S.profiles = null;
  S.config = null;
  S.service?.clearCurrent();
  S.bounds = null;
  S.selected = -1;
  S.activeCluster = null;
  S.mapRequest = (S.mapRequest || 0) + 1;
  for (const item of S.mapLayers) item.layer.remove();
  S.mapLayers = [];
  $('tabButton-profiles').disabled = true;
  $('tabButton-investigation').disabled = true;
  $('clusterSection').classList.add('disabled');
  $('clusterSection').open = false;
  $('clusterTable').tBodies[0].replaceChildren();
  $('clusterStatus').textContent = '';
  $('mapInfo').textContent = 'הריצו DTW וקיבוץ כדי לצבוע מסלולים לפי אשכול.';
  $('bar').style.width = '0%';
  $('bar').parentElement.setAttribute('aria-valuenow', '0');
  $('scatterTitle').textContent = 'מפת דגימות (MDS דו-ממדי של מטריצת המרחקים)';
  $('scatter').getContext('2d').clearRect(0, 0, $('scatter').width, $('scatter').height);
  $('mdsVariance').textContent = 'השונות תוצג לאחר חישוב.';
  $('mdsVariancePlot').getContext('2d').clearRect(0, 0, $('mdsVariancePlot').width, $('mdsVariancePlot').height);
  $('correlationPlot').getContext('2d').clearRect(0, 0, $('correlationPlot').width, $('correlationPlot').height);
  $('correlationLegend').replaceChildren();
  $('dendrogramCard').hidden = true;
  syncClusterViewTabs();
  $('dendrogram').getContext('2d').clearRect(0, 0, $('dendrogram').width, $('dendrogram').height);
  $('statusLine').textContent = '';
  activateTab('clusters');
}

function invalidateComputedResultIfConfigChanged() {
  const running = ['loading', 'dtw', 'mds'].includes(S.service?.job?.status);
  const previous = running ? S.service.job.config : S.config;
  if (!previous || sameComputeConfig(previous, readConfig())) return;
  if (running) S.service.cancelDtw();
  clearComputedResult();
}

// ---------- DTW run ----------
$('runDtw').onclick = async () => {
  try {
    const estimate = await refreshWorkloadEstimate();
    if (!estimate) return;
    if (estimate.warning && !window.confirm(
      `האומדן למאגרי החישוב הידועים הוא ${formatMiB(estimate.knownBufferBytes)} — מעל סף האזהרה של ${formatMiB(estimate.warningThresholdBytes)}. ` +
      'הזיכרון בפועל עלול להיות גבוה יותר. אפשר לצמצם מסננים או לבטל; לא תתבצע דגימת-משנה אוטומטית. להמשיך?'
    )) {
      $('statusLine').textContent = 'החישוב לא התחיל; אפשר לצמצם מסננים או לבטל.';
      return;
    }
    await api('/api/dtw', readConfig());
    S.result = null;
    S.labels = null;
    S.profiles = null;
    S.samples = [];
    S.points = [];
    S.coordinates = [];
    S.features = null;
    S.mdsInfo = null;
    S.config = null;
    $('tabButton-profiles').disabled = true;
    $('tabButton-investigation').disabled = true;
    activateTab('clusters');
    $('runDtw').disabled = true;
    $('cancelDtw').disabled = false;
    $('clusterSection').classList.add('disabled');
    poll();
  } catch (e) {
    $('statusLine').textContent = e.message;
  }
};
$('cancelDtw').onclick = async () => {
  try {
    await api('/api/dtw/cancel');
  } catch (error) {
    $('statusLine').textContent = `שגיאה בביטול: ${error.message}`;
  }
};

const formatMiB = (bytes) => `${(bytes / 1024 ** 2).toLocaleString(undefined, { maximumFractionDigits: 1 })} MiB`;
async function refreshWorkloadEstimate() {
  const request = ++S.workloadRequest;
  const panel = $('workloadEstimate');
  const config = readConfig();
  panel.textContent = 'מחשב אומדן לפי המסננים...';
  try {
    const [{ estimateWorkload }, samples] = await Promise.all([
      import('./workload-estimate.mjs'),
      api('/api/samples', { ...config, search: '', limit: 1 }),
    ]);
    if (request !== S.workloadRequest) return null;
    const maxVectorLength = Number(
      config.unit === 'pattern' ? S.meta.counts.max_pattern_len : S.meta.counts.max_route_len
    ) + (config.feature === 'cum' ? 1 : 0);
    const estimate = estimateWorkload({
      n: Number(samples.total),
      maxVectorLength,
      metric: config.metric,
      workers: Math.max(1, Math.floor(config.workers)),
      mdsDimensions: config.mdsDims,
    });
    const warning = estimate.warning
      ? `<div class="workload-warning">עומס הזיכרון המשוער גבוה. צמצמו מסננים או בטלו; אין קיטוע אוטומטי.</div>`
      : '';
    panel.innerHTML =
      `<strong>אומדן לפני חישוב, ללא דגימת-משנה:</strong> ${estimate.n.toLocaleString()} דגימות · ` +
      `${estimate.pairs.toLocaleString()} זוגות · מטריצה ${formatMiB(estimate.matrixBytes)} · ` +
      `מאגרי מספרים ידועים ${formatMiB(estimate.knownBufferBytes)} (${estimate.workers} Workers). ` +
      `אורך וקטור מרבי שמרני: ${estimate.maxVectorLength.toLocaleString()}.` +
      `<div>האומדן מתייחס למסלול CPU ול-fallback, וכולל מטריצה, עותקי קלט לכל Worker, scratch, MDS ב-${config.mdsDims} ממדים וארבעת מאפייני הקו. הוא אינו כולל את DuckDB-Wasm, מטמון Parquet, זיכרון GPU, מנוע דפדפן או עותקים זמניים.</div>${warning}`;
    return estimate;
  } catch (error) {
    if (request !== S.workloadRequest) return null;
    panel.textContent = `שגיאה בחישוב אומדן העומס: ${error.message}`;
    return null;
  }
}

async function poll() {
  const st = await api('/api/status');
  const metricName = METRIC_LABELS[st.config?.metric || $('metric').value] || 'מרחקים';
  const names = { loading: 'טוען דגימות מ-DuckDB-Wasm…', dtw: `מחשב ${metricName}`, mds: 'מחשב היטל דו-ממדי…' };
  const progressPercent = Math.round((st.progress || 0) * 100);
  $('bar').style.width = `${progressPercent}%`;
  $('bar').parentElement.setAttribute('aria-valuenow', String(progressPercent));
  if (['loading', 'dtw', 'mds'].includes(st.status)) {
    $('runDtw').disabled = true;
    $('cancelDtw').disabled = false;
    const eta = st.etaMs ? ` · נותרו ~${Math.ceil(st.etaMs / 1000)} שנ'` : '';
    const pairs = st.n ? ` · ${st.n.toLocaleString()} דגימות` : '';
    const backend = st.status === 'dtw' && st.config?.computeBackend === 'webgpu'
      ? ' · WebGPU/CPU'
      : st.status === 'dtw' ? ' · CPU' : '';
    $('statusLine').textContent = `${names[st.status]} ${Math.round((st.progress || 0) * 100)}%${pairs}${eta}${backend}`;
    setTimeout(poll, 500);
    return;
  }
  $('runDtw').disabled = false;
  $('cancelDtw').disabled = true;
  if (st.status === 'done') onDone(st);
  else $('statusLine').textContent = st.status === 'error' ? `שגיאה: ${st.error}` : st.status === 'cancelled' ? 'בוטל' : '';
}

function onDone(st) {
  S.samples = st.samples;
  S.points = st.points;
  S.coordinates = st.coordinates;
  S.features = st.features;
  S.mdsInfo = st.mdsInfo;
  S.config = st.config;
  S.labels = null;
  S.profiles = null;
  $('tabButton-profiles').disabled = true;
  $('tabButton-investigation').disabled = true;
  S.selected = -1;
  S.activeCluster = null;
  $('bar').style.width = '100%';
  $('bar').parentElement.setAttribute('aria-valuenow', '100');
  const metric = st.config?.metric || 'hausdorff_profile_wmhd';
  const metricLabel = METRIC_LABELS[metric] || metric;
  if ($('scatterTitle')) $('scatterTitle').textContent = `מפת דגימות (MDS דו-ממדי — ${metricLabel})`;
  if ($('profileViewMode')) $('profileViewMode').value = 'cumulative';
  const axisRatio = st.mdsInfo?.axisRatio;
  const axisNote = axisRatio == null ? '' : ` · יחס הערכים העצמיים: ${fmt(axisRatio * 100, 1)}%`;
  const backendLabel = st.backend === 'webgpu' ? 'WebGPU' : 'CPU';
  const notice = st.notice ? ` · ${st.notice}` : '';
  $('statusLine').textContent = `${st.n.toLocaleString()} דגימות · ${metricLabel} (${backendLabel}): ${(st.dtwMs / 1000).toFixed(1)} שנ' · סה"כ ${(st.totalMs / 1000).toFixed(1)} שנ'${axisNote}${notice}`;
  renderMdsVariance();
  drawCorrelationPlots();
  $('clusterSection').classList.remove('disabled');
  $('clusterSection').open = true;
  const q = st.quantiles;
  $('epsHints').textContent = `אחוזונים של מרחקי זוגות (0.5%, 1%, 2%, 5%, 10%, 25%, 50%): ${q.map((v) => fmt(v, 2)).join(' · ')}`;
  if (!+$('eps').value) $('eps').value = fmt(q[2], 3);
  computeBounds();
  resetView();
  draw();
  runCluster();
}

// ---------- clustering ----------
const syncAlgoUi = () => {
  const a = $('algo').value;
  const hierarchical = a === 'hierarchical';
  const cutMode = $('cutMode').value;
  const kCut = cutMode === 'k' || cutMode === 'info-k';
  $('linkageWrap').hidden = !hierarchical;
  $('cutModeWrap').hidden = !hierarchical;
  $('kWrap').hidden = a === 'dbscan' || (hierarchical && !kCut);
  $('autoWrap').hidden = a === 'dbscan' || (hierarchical && cutMode !== 'k');
  const showAutoRange = $('auto').checked && (a === 'kmedoids' || (hierarchical && cutMode === 'k'));
  $('kMin').parentElement.hidden = !showAutoRange;
  $('kMax').parentElement.hidden = !showAutoRange;
  $('cutHWrap').hidden = !hierarchical || cutMode !== 'h';
  $('cutInfoWrap').hidden = !hierarchical || !cutMode.startsWith('info-');
  $('cutTauWrap').hidden = cutMode !== 'info-tau';
  $('cutFracWrap').hidden = cutMode !== 'info-frac';
  $('dbWrap').hidden = a !== 'dbscan';
  $('dendrogramCard').hidden = !hierarchical || !S.result?.merges;
  syncClusterViewTabs();
};
$('algo').onchange = syncAlgoUi;
$('cutMode').onchange = syncAlgoUi;
$('auto').onchange = syncAlgoUi;
syncAlgoUi();

$('runCluster').onclick = runCluster;
let clusterPollToken = 0;
async function pollClusterProgress(token) {
  if (token !== clusterPollToken) return;
  try {
    const status = await api('/api/cluster/status');
    if (token !== clusterPollToken || !status.running) return;
    const phaseName = status.phase === 'hierarchical' ? 'בונה דנדוגרמה' : 'מחשב אשכולות';
    const progress = status.progress > 0 ? ` ${Math.round(status.progress * 100)}%` : '…';
    $('clusterStatus').textContent = `${phaseName}${progress}`;
  } catch (error) {
    if (token === clusterPollToken) $('clusterStatus').textContent = `שגיאה במעקב אחר הקיבוץ: ${error.message}`;
  }
  if (token === clusterPollToken) setTimeout(() => pollClusterProgress(token), 250);
}

async function runCluster() {
  $('clusterStatus').textContent = 'מקבץ…';
  $('runCluster').disabled = true;
  $('cancelCluster').disabled = false;
  const pollToken = ++clusterPollToken;
  setTimeout(() => pollClusterProgress(pollToken), 0);
  try {
    const r = await api('/api/cluster', {
      algo: $('algo').value,
      linkage: $('linkage').value,
      cutMode: $('cutMode').value,
      auto: $('auto').checked,
      k: +$('k').value,
      kMin: +$('kMin').value,
      kMax: +$('kMax').value,
      cutH: +$('cutH').value,
      cutTau: +$('cutTau').value,
      cutFrac: +$('cutFrac').value,
      eps: +$('eps').value,
      minPts: +$('minPts').value,
    });
    rankClustersBySize(r);
    S.result = r;
    S.labels = r.labels;
    S.profiles = null;
    $('tabButton-profiles').disabled = false;
    S.activeCluster = null;
    const infoNote = r.information
      ? ` · שימור מידע ${(r.information.preservedFraction * 100).toFixed(1)}%`
      : '';
    $('clusterStatus').textContent = `${r.k} אשכולות · ${r.noise} רעש · ${r.ms.toFixed(0)} ms${infoNote}`;
    if ($('auto').checked && $('algo').value !== 'dbscan') $('k').value = r.k;
    if (r.merges?.h?.length) {
      const maxHeight = r.merges.h.reduce((maximum, height) => Math.max(maximum, height), 0);
      $('cutH').max = String(maxHeight);
      if (+$('cutH').value > maxHeight) $('cutH').value = String(maxHeight);
    }
    renderClusters();
    draw();
  } catch (e) {
    $('clusterStatus').textContent = e.name === 'AbortError' ? 'הקיבוץ בוטל.' : e.message;
  } finally {
    clusterPollToken++;
    $('runCluster').disabled = false;
    $('cancelCluster').disabled = true;
  }
}

function rankClustersBySize(result) {
  const { k, labels, sizes } = result;
  if (!Number.isInteger(k) || k < 0 || sizes?.length !== k || labels?.length !== S.samples.length) {
    throw new RangeError('תוצאת הקיבוץ אינה כוללת גדלים ותוויות התואמים למספר האשכולות והדגימות.');
  }
  const order = Array.from({ length: k }, (_, cluster) => cluster)
    .sort((left, right) => sizes[right] - sizes[left] || left - right);
  const rankedLabel = new Int32Array(k);
  order.forEach((oldLabel, newLabel) => { rankedLabel[oldLabel] = newLabel; });
  for (let index = 0; index < labels.length; index++) {
    const label = labels[index];
    if (label === -1) continue;
    if (!Number.isInteger(label) || label < 0 || label >= k) {
      throw new RangeError(`תווית אשכול לא תקינה בדגימה ${index}.`);
    }
    labels[index] = rankedLabel[label];
  }
  for (const key of ['sizes', 'medoids', 'silhouetteByCluster', 'cutNodes']) {
    const values = result[key];
    if (values?.length === k) result[key] = order.map((cluster) => values[cluster]);
  }
}

$('cancelCluster').onclick = async () => {
  $('cancelCluster').disabled = true;
  try {
    await api('/api/cluster/cancel');
  } catch (error) {
    $('clusterStatus').textContent = `שגיאה בביטול הקיבוץ: ${error.message}`;
  }
};

const color = (c) => (c < 0 ? '#9aa1ab' : `hsl(${(c * 137.508) % 360} 70% 45%)`);
const FEATURE_NAMES = [
  'מספר תחנות',
  'אורך הקו',
  'ממוצע מרחק בין תחנות',
  'שונות מרחק בין תחנות',
];

function renderMdsVariance() {
  const info = S.mdsInfo;
  if (!info?.explainedVariance?.length) {
    $('mdsVariance').textContent = 'אין ספקטרום ערכים עצמיים להצגה.';
    $('mdsVariancePlot').getContext('2d').clearRect(0, 0, $('mdsVariancePlot').width, $('mdsVariancePlot').height);
    return;
  }
  const axes = info.explainedVariance.map((value, index) =>
    `ציר ${index + 1}: ${(value * 100).toFixed(1)}% (מצטבר ${(info.cumulativeExplainedVariance[index] * 100).toFixed(1)}%)`
  );
  const scope = info.fullSpectrum
    ? 'השונות חושבה מתוך הספקטרום החיובי המלא.'
    : 'האחוזים מנורמלים לספקטרום החיובי שאמד Lanczos בתת-המרחב המחושב; הם אומדן ולא שונות של המטריצה כולה.';
  $('mdsVariance').textContent = `${info.dimensions} ממדים חושבו; מוצגים צירים 1–2. ${axes.join(' · ')} ${scope}`;
  drawMdsVarianceBars(info.explainedVariance);
}

function drawMdsVarianceBars(explainedVariance) {
  const canvas = $('mdsVariancePlot');
  const g = canvas.getContext('2d');
  const { width, height } = canvas;
  g.clearRect(0, 0, width, height);
  if (!explainedVariance.length) return;
  const pad = { left: 54, right: 18, top: 16, bottom: 34 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const y = (percent) => pad.top + plotHeight * (1 - percent / 100);
  g.font = '11px sans-serif';
  g.textAlign = 'right';
  g.textBaseline = 'middle';
  for (let tick = 0; tick <= 4; tick++) {
    const percent = tick * 25;
    const yPos = y(percent);
    g.strokeStyle = '#e4e7ec';
    g.beginPath();
    g.moveTo(pad.left, yPos);
    g.lineTo(width - pad.right, yPos);
    g.stroke();
    g.fillStyle = '#667085';
    g.fillText(`${percent}%`, pad.left - 7, yPos);
  }
  const slotWidth = plotWidth / explainedVariance.length;
  const barWidth = Math.min(52, slotWidth * 0.66);
  explainedVariance.forEach((value, index) => {
    const percent = Math.max(0, Math.min(100, Number(value) * 100));
    const barHeight = plotHeight * percent / 100;
    const x = pad.left + slotWidth * index + (slotWidth - barWidth) / 2;
    g.fillStyle = index < 2 ? '#1f6feb' : '#82aef5';
    g.fillRect(x, pad.top + plotHeight - barHeight, barWidth, barHeight);
    g.fillStyle = '#344054';
    g.textAlign = 'center';
    g.textBaseline = 'bottom';
    g.fillText(`${percent.toFixed(1)}%`, x + barWidth / 2, Math.max(pad.top + 11, pad.top + plotHeight - barHeight - 3));
    g.fillStyle = '#667085';
    g.textBaseline = 'top';
    g.fillText(String(index + 1), x + barWidth / 2, height - pad.bottom + 7);
  });
  g.fillStyle = '#667085';
  g.textAlign = 'center';
  g.textBaseline = 'bottom';
  g.fillText('ציר MDS', pad.left + plotWidth / 2, height - 1);
  canvas.setAttribute('aria-label', `שונות מוסברת לפי ציר MDS: ${explainedVariance.map((value, index) => `ציר ${index + 1} ${(value * 100).toFixed(1)} אחוז`).join(', ')}`);
}

function drawCorrelationPlots() {
  const canvas = $('correlationPlot');
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, canvas.width, canvas.height);
  renderCorrelationLegend();
  const dimensions = Number(S.mdsInfo?.dimensions) || 0;
  if (!S.coordinates.length || !S.features || dimensions < 2) return;
  const width = canvas.width;
  const height = canvas.height;
  const columns = FEATURE_NAMES.length;
  const rows = 2;
  const gap = 12;
  const cellWidth = (width - gap * (columns + 1)) / columns;
  const cellHeight = (height - gap * (rows + 1)) / rows;
  const count = S.samples.length;
  const routeUnit = S.config?.unit === 'route';
  const names = routeUnit
    ? ['תחנות ממוצעות לתבנית', 'אורך ממוצע לתבנית (מ׳)', 'מרווח ממוצע (מ׳)', 'שונות מרווחים (מ׳²)']
    : ['מספר תחנות', 'אורך קו (מ׳)', 'מרווח ממוצע (מ׳)', 'שונות מרווחים (מ׳²)'];
  for (let axis = 0; axis < rows; axis++) {
    for (let feature = 0; feature < columns; feature++) {
      const left = gap + feature * (cellWidth + gap);
      const top = gap + axis * (cellHeight + gap);
      const pad = { left: 28, right: 7, top: 42, bottom: 22 };
      const points = [];
      for (let item = 0; item < count; item++) {
        const x = Number(S.coordinates[item * dimensions + axis]);
        const y = Number(S.features[item * columns + feature]);
        if (Number.isFinite(x) && Number.isFinite(y)) points.push({ x, y, label: S.labels?.[item] });
      }
      if (!points.length) continue;
      const min = (values) => Math.min(...values);
      const max = (values) => Math.max(...values);
      let x0 = min(points.map((point) => point.x)), x1 = max(points.map((point) => point.x));
      let y0 = min(points.map((point) => point.y)), y1 = max(points.map((point) => point.y));
      if (x0 === x1) { x0 -= 0.5; x1 += 0.5; }
      if (y0 === y1) { y0 -= 0.5; y1 += 0.5; }
      const plotLeft = left + pad.left;
      const plotRight = left + cellWidth - pad.right;
      const plotTop = top + pad.top;
      const plotBottom = top + cellHeight - pad.bottom;
      const X = (value) => plotLeft + (value - x0) / (x1 - x0) * (plotRight - plotLeft);
      const Y = (value) => plotBottom - (value - y0) / (y1 - y0) * (plotBottom - plotTop);
      const stats = S.mdsInfo.correlations?.find((entry) => entry.axis === axis && entry.feature === feature);
      g.fillStyle = '#1b1f24';
      g.font = '12px sans-serif';
      g.textAlign = 'right';
      g.fillText(names[feature], left + cellWidth - 4, top + 13);
      g.font = '10px sans-serif';
      g.fillStyle = '#667085';
      g.fillText(`ציר ${axis + 1} · Pearson ${fmt(stats?.pearson, 2)} · Spearman ${fmt(stats?.spearman, 2)}`, left + cellWidth - 4, top + 29);
      g.strokeStyle = '#cbd2dc';
      g.strokeRect(plotLeft, plotTop, plotRight - plotLeft, plotBottom - plotTop);
      g.globalAlpha = 0.42;
      for (const point of points) {
        g.fillStyle = point.label == null ? '#1f6feb' : color(point.label);
        g.beginPath();
        g.arc(X(point.x), Y(point.y), 1.8, 0, Math.PI * 2);
        g.fill();
      }
      g.globalAlpha = 1;
      g.textAlign = 'center';
      g.fillStyle = '#667085';
      g.fillText(`MDS ${axis + 1}`, (plotLeft + plotRight) / 2, top + cellHeight - 4);
    }
  }
}

function renderCorrelationLegend() {
  const legend = $('correlationLegend');
  legend.replaceChildren();
  if (!S.labels?.length) {
    legend.textContent = 'הריצו קיבוץ כדי לצבוע את הנקודות לפי אשכול.';
    return;
  }
  const clusterIds = [...new Set(S.labels)].sort((a, b) => {
    if (a < 0) return 1;
    if (b < 0) return -1;
    return a - b;
  });
  for (const clusterId of clusterIds) {
    const item = document.createElement('span');
    item.className = 'cluster-legend-item';
    const swatch = document.createElement('span');
    swatch.className = 'dot';
    swatch.style.backgroundColor = color(clusterId);
    const label = document.createElement('span');
    label.textContent = clusterId < 0 ? 'רעש' : `אשכול ${clusterId + 1}`;
    item.append(swatch, label);
    legend.append(item);
  }
}

function drawDendrogram() {
  const canvas = $('dendrogram');
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, canvas.width, canvas.height);
  const merges = S.result?.merges;
  const n = S.samples.length;
  if (!merges || !n) {
    $('dendrogramCard').hidden = true;
    return;
  }
  $('dendrogramCard').hidden = $('algo').value !== 'hierarchical';
  const root = 2 * n - 2;
  const order = [];
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (node < n) order.push(node);
    else {
      const merge = node - n;
      stack.push(merges.b[merge], merges.a[merge]);
    }
  }
  S.dendrogramOrder = order;
  const positions = new Float64Array(2 * n - 1);
  const heights = new Float64Array(2 * n - 1);
  order.forEach((item, index) => { positions[item] = index; });
  let maxHeight = 0;
  for (let merge = 0; merge < n - 1; merge++) {
    const node = n + merge;
    positions[node] = (positions[merges.a[merge]] + positions[merges.b[merge]]) / 2;
    heights[node] = Math.max(0, Number(merges.h[merge]) || 0);
    maxHeight = Math.max(maxHeight, heights[node]);
  }
  const labels = Int32Array.from(S.labels || new Array(n).fill(0));
  const nodeLabels = new Int32Array(2 * n - 1);
  nodeLabels.set(labels);
  for (let merge = 0; merge < n - 1; merge++) {
    const left = merges.a[merge], right = merges.b[merge];
    nodeLabels[n + merge] = nodeLabels[left] >= 0 && nodeLabels[left] === nodeLabels[right]
      ? nodeLabels[left]
      : -1;
  }
  const pad = { left: 48, right: 18, top: 18, bottom: n <= 50 ? 112 : 32 };
  const plotWidth = canvas.width - pad.left - pad.right;
  const plotHeight = canvas.height - pad.top - pad.bottom;
  const X = (node) => pad.left + ((positions[node] + 0.5) / n) * plotWidth;
  const Y = (node) => canvas.height - pad.bottom - (maxHeight ? heights[node] / maxHeight : 0) * plotHeight;
  g.strokeStyle = '#e1e5eb';
  g.fillStyle = '#667085';
  g.font = '10px sans-serif';
  g.textAlign = 'right';
  for (let tick = 0; tick <= 4; tick++) {
    const height = maxHeight * tick / 4;
    const y = canvas.height - pad.bottom - tick / 4 * plotHeight;
    g.beginPath();
    g.moveTo(pad.left, y);
    g.lineTo(canvas.width - pad.right, y);
    g.stroke();
    g.fillText(fmt(height, 2), pad.left - 5, y + 3);
  }
  for (let merge = 0; merge < n - 1; merge++) {
    const node = n + merge;
    const left = merges.a[merge], right = merges.b[merge];
    const leftX = X(left), rightX = X(right), nodeY = Y(node);
    g.lineWidth = 1;
    g.strokeStyle = color(nodeLabels[left]);
    g.beginPath();
    g.moveTo(leftX, Y(left));
    g.lineTo(leftX, nodeY);
    g.stroke();
    g.strokeStyle = color(nodeLabels[right]);
    g.beginPath();
    g.moveTo(rightX, Y(right));
    g.lineTo(rightX, nodeY);
    g.stroke();
    g.strokeStyle = nodeLabels[node] >= 0 ? color(nodeLabels[node]) : '#748094';
    g.beginPath();
    g.moveTo(leftX, nodeY);
    g.lineTo(rightX, nodeY);
    g.stroke();
  }
  for (const node of S.result.cutNodes || []) {
    if (node < n) continue;
    g.fillStyle = '#111827';
    g.beginPath();
    g.arc(X(node), Y(node), 2.5, 0, Math.PI * 2);
    g.fill();
  }
  if (S.result.cutHeight != null && maxHeight > 0) {
    const y = canvas.height - pad.bottom - Math.max(0, Math.min(maxHeight, S.result.cutHeight)) / maxHeight * plotHeight;
    g.strokeStyle = '#dc2626';
    g.setLineDash([5, 4]);
    g.beginPath();
    g.moveTo(pad.left, y);
    g.lineTo(canvas.width - pad.right, y);
    g.stroke();
    g.setLineDash([]);
  }
  if (n <= 50) {
    g.save();
    g.fillStyle = '#475467';
    g.font = '8px sans-serif';
    g.textAlign = 'right';
    order.forEach((sampleIndex) => {
      const [x, y] = [X(sampleIndex), canvas.height - pad.bottom + 6];
      g.save();
      g.translate(x, y);
      g.rotate(-Math.PI / 3);
      g.fillText(routeLabel(S.samples[sampleIndex]).slice(0, 42), 0, 0);
      g.restore();
    });
    g.restore();
  }
  const cutMode = $('cutMode').value;
  const information = S.result.information;
  const cutLabel = cutMode === 'h' ? `חיתוך h=${fmt(S.result.cutHeight, 3)}`
    : cutMode.startsWith('info-') ? `חיתוך מידע: ${(information?.preservedFraction * 100 || 0).toFixed(1)}% נשמר`
      : `חיתוך k=${S.result.k}`;
  $('dendrogramInfo').textContent = `${n.toLocaleString()} עלים · ${$('linkage').value} linkage · ${cutLabel}. ${n > 50 ? 'הצביעו על מיקום בתחתית לקבלת שם הדגימה.' : 'תוויות העלים מוצגות.'}`;
}

const dendrogramCanvas = $('dendrogram');
dendrogramCanvas.onmousemove = (event) => {
  const order = S.dendrogramOrder || [];
  if (!order.length) return;
  const rect = dendrogramCanvas.getBoundingClientRect();
  const x = (event.clientX - rect.left) * dendrogramCanvas.width / rect.width;
  const plotWidth = dendrogramCanvas.width - 66;
  const index = Math.max(0, Math.min(order.length - 1, Math.floor(((x - 48) / plotWidth) * order.length)));
  const sampleIndex = order[index];
  const sample = S.samples[sampleIndex];
  $('dendrogramTip').textContent = sample
    ? `עלה ${index + 1}/${order.length}: ${routeLabel(sample)} · אשכול ${S.labels?.[sampleIndex] >= 0 ? S.labels[sampleIndex] + 1 : 'רעש'}`
    : '';
};
dendrogramCanvas.onmouseleave = () => { $('dendrogramTip').textContent = ''; };

function drawSilCurve() {
  const cv = $('silcurve');
  const curve = S.result.silCurve;
  cv.hidden = !curve;
  if (!curve) return;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, cv.width, cv.height);
  const xs = curve.map((p) => p.k);
  const ys = curve.map((p) => p.silhouette);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  const [y0, y1] = [Math.min(...ys), Math.max(...ys)];
  const X = (x) => 30 + ((x - x0) / Math.max(1, x1 - x0)) * (cv.width - 45);
  const Y = (y) => cv.height - 22 - ((y - y0) / Math.max(1e-9, y1 - y0)) * (cv.height - 36);
  g.strokeStyle = '#1f6feb';
  g.beginPath();
  curve.forEach((p, i) => (i ? g.lineTo(X(p.k), Y(p.silhouette)) : g.moveTo(X(p.k), Y(p.silhouette))));
  g.stroke();
  g.fillStyle = '#444';
  g.font = '14px sans-serif';
  curve.forEach((p) => {
    g.fillStyle = p.k === S.result.k ? '#d1242f' : '#1f6feb';
    g.beginPath();
    g.arc(X(p.k), Y(p.silhouette), p.k === S.result.k ? 4 : 2.5, 0, 7);
    g.fill();
    g.fillStyle = '#555';
    g.fillText(p.k, X(p.k) - 4, cv.height - 8);
  });
  g.fillText(`silhouette לפי k  (${fmt(y0, 2)}–${fmt(y1, 2)})`, 30, 11);
}

async function selectClusterLegacy(c) {
  S.activeCluster = c;
  document.querySelectorAll('#clusterTable tbody tr').forEach((tr) => tr.classList.toggle('sel', +tr.dataset.c === c));
  draw();
  const ids = [];
  S.labels.forEach((l, i) => l === c && ids.push(i));
  const medoid = S.result.medoids[c];
  const pickIdx = ids.filter((i) => i !== medoid);
  const step = Math.max(1, Math.floor(pickIdx.length / 40));
  const shown = pickIdx.filter((_, i) => i % step === 0).slice(0, 40);
  const vecs = await api('/api/vectors', { ids: [...shown, ...(medoid >= 0 ? [medoid] : [])].map((i) => S.samples[i].sample_id) });
  const byId = Object.fromEntries(vecs.map((v) => [v.sample_id, v.vec]));
  const series = shown.map((i) => ({ vec: byId[S.samples[i].sample_id], color: color(c) + '', alpha: 0.35, w: 1 }));
  if (medoid >= 0) series.push({ vec: byId[S.samples[medoid].sample_id], color: '#000', alpha: 1, w: 2.5 });
  $('detailPanel').classList.remove('empty-detail');
  $('detailPanel').innerHTML = `<h2>${c < 0 ? 'רעש' : `אשכול ${c + 1}`}</h2><div class="muted">${ids.length.toLocaleString()} דגימות · מוצגות ${shown.length} דגימות ונציג האשכול בשחור.</div><div class="vector-card"><h3>השוואת וקטורים באשכול</h3><div class="vector-caption">עד 40 דגימות והנציג (medoid).</div><canvas id="vecplot" width="1200" height="300"></canvas></div>`;
  drawLines($('vecplot'), series);
}

async function selectPointLegacy(i) {
  S.selected = i;
  draw();
  const s = S.samples[i];
  const d = await api(`/api/sample?id=${encodeURIComponent(s.sample_id)}`);
  $('detailTitle').textContent = `קו ${d.route_short_name} · ${d.agency_name}`;
  const cl = S.labels ? S.labels[i] : null;
  $('detail').innerHTML = `<bdi>${d.route_long_name}</bdi><br><bdi>${d.first_stop || ''}</bdi> ← <bdi>${d.last_stop || ''}</bdi><br>סוג ${typeName(d.route_type)} · ${d.n_patterns} תבניות · ${d.n_trips} נסיעות · ${d.vec.length} איברים${cl != null ? ` · אשכול ${cl < 0 ? 'רעש' : cl + 1}` : ''}
    <table><tr><th>תבנית</th><th>נסיעות</th><th>עצירות</th><th>מרחק (מ')</th><th>מ- עד</th></tr>${d.patterns.map((p) => `<tr><td>${p.rank}</td><td>${p.trips}</td><td>${p.n_stops}</td><td>${Math.round(p.total_m)}</td><td><bdi>${p.first_stop}</bdi> ← <bdi>${p.last_stop}</bdi></td></tr>`).join('')}</table>`;
  drawLines($('vecplot'), [{ vec: d.vec, color: cl != null ? color(cl) : '#1f6feb', alpha: 1, w: 2 }], d.n_patterns > 1 ? d.patterns.map((p) => p.n_stops - (S.config.feature === 'seg' ? 1 : 0)) : null);
}

function drawLines(cv, series, breaks) {
  const g = cv.getContext('2d');
  g.clearRect(0, 0, cv.width, cv.height);
  if (!series.length) return;
  const all = series.flatMap((s) => s.vec);
  const maxLen = Math.max(...series.map((s) => s.vec.length));
  const sorted = [...all].sort((a, b) => a - b);
  const ymax = Math.max(sorted[Math.floor(sorted.length * 0.98)] * 1.1 || 1, 1); // clip outlier spikes
  const L = 48, R = 10, T = 10, B = 22;
  const X = (i) => L + (i / Math.max(1, maxLen - 1)) * (cv.width - L - R);
  const Y = (v) => cv.height - B - (Math.min(v, ymax) / ymax) * (cv.height - T - B);
  g.strokeStyle = '#e5e8ee';
  g.fillStyle = '#666';
  g.font = '16px sans-serif';
  for (let t = 0; t <= 4; t++) {
    const v = (ymax * t) / 4;
    g.beginPath();
    g.moveTo(L, Y(v));
    g.lineTo(cv.width - R, Y(v));
    g.stroke();
    g.fillText(Math.round(v), 4, Y(v) + 4);
  }
  g.fillText('אינדקס עצירה', cv.width / 2 - 25, cv.height - 5);
  if (breaks) {
    let acc = 0;
    g.strokeStyle = '#bbb';
    g.setLineDash([4, 4]);
    breaks.slice(0, -1).forEach((n) => {
      acc += n;
      g.beginPath();
      g.moveTo(X(acc - 0.5), T);
      g.lineTo(X(acc - 0.5), cv.height - B);
      g.stroke();
    });
    g.setLineDash([]);
  }
  for (const s of series) {
    g.globalAlpha = s.alpha;
    g.strokeStyle = s.color;
    g.lineWidth = s.w;
    g.beginPath();
    s.vec.forEach((v, i) => (i ? g.lineTo(X(i), Y(v)) : g.moveTo(X(i), Y(v))));
    g.stroke();
  }
  g.globalAlpha = 1;
  g.lineWidth = 1;
}

// ---------- scatter ----------
const cv = $('scatter');
// 1st-99th percentile bounds so a few outliers do not squash the map; outliers are clamped to the frame
function computeBounds() {
  const q = (k) => {
    const v = [];
    for (let i = k; i < S.points.length; i += 2) v.push(S.points[i]);
    v.sort((a, b) => a - b);
    return [v[Math.floor(v.length * 0.01)], v[Math.min(v.length - 1, Math.floor(v.length * 0.99))]];
  };
  const [x0, x1] = q(0);
  const [y0, y1] = q(1);
  S.bounds = { x0, x1, y0, y1 };
}
const resetView = () => (S.view = { s: 1, tx: 0, ty: 0 });
function toScreen(i) {
  const b = S.bounds, pad = 20, w = cv.width - 2 * pad, h = cv.height - 2 * pad;
  const cl = (v) => Math.max(-0.03, Math.min(1.03, v));
  const nx = cl((S.points[2 * i] - b.x0) / (b.x1 - b.x0 || 1));
  const ny = cl((S.points[2 * i + 1] - b.y0) / (b.y1 - b.y0 || 1));
  return [(pad + nx * w) * S.view.s + S.view.tx, (cv.height - pad - ny * h) * S.view.s + S.view.ty];
}
function draw() {
  const g = cv.getContext('2d');
  g.clearRect(0, 0, cv.width, cv.height);
  if (!S.points.length) return;
  const n = S.points.length / 2;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < n; i++) {
      const l = S.labels ? S.labels[i] : 0;
      const hi = S.activeCluster === null || l === S.activeCluster;
      if ((pass === 0) === hi) continue;
      const [x, y] = toScreen(i);
      g.globalAlpha = hi ? 0.85 : 0.12;
      g.fillStyle = S.labels ? color(l) : '#1f6feb';
      g.beginPath();
      g.arc(x, y, hi ? 3 : 2.5, 0, 7);
      g.fill();
    }
  }
  g.globalAlpha = 1;
  if (S.result && S.result.medoids) {
    S.result.medoids.forEach((m) => {
      if (m < 0) return;
      const [x, y] = toScreen(m);
      g.strokeStyle = '#000';
      g.lineWidth = 2;
      g.beginPath();
      g.arc(x, y, 6, 0, 7);
      g.stroke();
    });
  }
  if (S.selected >= 0) {
    const [x, y] = toScreen(S.selected);
    g.strokeStyle = '#d1242f';
    g.lineWidth = 3;
    g.beginPath();
    g.arc(x, y, 8, 0, 7);
    g.stroke();
  }
  g.lineWidth = 1;
}

const mouse = (e) => {
  const r = cv.getBoundingClientRect();
  return [((e.clientX - r.left) * cv.width) / r.width, ((e.clientY - r.top) * cv.height) / r.height];
};
function nearest(mx, my) {
  let best = -1, bd = 12 * 12;
  for (let i = 0; i < S.points.length / 2; i++) {
    const [x, y] = toScreen(i);
    const d = (x - mx) ** 2 + (y - my) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}
let drag = null;
cv.onmousedown = (e) => { drag = { m: mouse(e), tx: S.view.tx, ty: S.view.ty, moved: false }; };
window.onmouseup = () => (drag = null);
cv.onmousemove = (e) => {
  const [mx, my] = mouse(e);
  if (drag) {
    if (Math.abs(mx - drag.m[0]) + Math.abs(my - drag.m[1]) > 3) drag.moved = true;
    S.view.tx = drag.tx + mx - drag.m[0];
    S.view.ty = drag.ty + my - drag.m[1];
    draw();
    return;
  }
  const i = S.points.length ? nearest(mx, my) : -1;
  const tip = $('tip');
  if (i < 0) { tip.hidden = true; return; }
  const s = S.samples[i];
  tip.hidden = false;
  tip.textContent = `${routeLabel(s)} · ${s.agency_name}${S.labels ? ` · אשכול ${S.labels[i] < 0 ? 'רעש' : S.labels[i] + 1}` : ''}`;
  const card = cv.parentElement.getBoundingClientRect();
  tip.style.left = `${Math.min(e.clientX - card.left + 12, card.width - 330)}px`;
  tip.style.top = `${e.clientY - card.top + 14}px`;
};
cv.onmouseleave = () => ($('tip').hidden = true);
cv.onclick = (e) => {
  if (drag && drag.moved) return;
  const i = nearest(...mouse(e));
  if (i >= 0) selectPoint(i);
};
cv.ondblclick = () => { resetView(); draw(); };
cv.onwheel = (e) => {
  e.preventDefault();
  const [mx, my] = mouse(e);
  const f = e.deltaY < 0 ? 1.2 : 1 / 1.2;
  S.view.tx = mx - (mx - S.view.tx) * f;
  S.view.ty = my - (my - S.view.ty) * f;
  S.view.s *= f;
  draw();
};

// ---------- data tab ----------
async function refreshDataTabLegacy() {
  const r = await api('/api/samples', { ...readConfig(), search: $('search').value, limit: 300 });
  $('dataInfo').textContent = `${r.total.toLocaleString()} דגימות תואמות לסינון (מוצגות ${r.rows.length})`;
  $('sampleInfo').textContent = `${r.total.toLocaleString()} דגימות עומדות בסינון`;
  $('dataTable').tBodies[0].innerHTML = r.rows
    .map((x) => `<tr><td>${x.route_short_name}</td><td><bdi>${x.route_long_name}</bdi></td><td>${x.agency_name}</td><td>${typeName(x.route_type)}</td><td>${x.n_patterns}</td><td>${x.n_trips}</td><td>${x.n}</td><td>${x.total_m}</td></tr>`)
    .join('');
}
$('reloadData').onclick = refreshDataTab;
$('search').onkeydown = (e) => e.key === 'Enter' && refreshDataTab();
['unit', 'feature', 'agencies', 'routeTypes', 'minLen', 'mdsDims'].forEach((id) => ($(id).onchange = () => {
  invalidateComputedResultIfConfigChanged();
  refreshDataTab();
  refreshWorkloadEstimate();
}));
$('workers').onchange = () => {
  invalidateComputedResultIfConfigChanged();
  refreshWorkloadEstimate();
};
$('metric').onchange = () => {
  syncMetricUi();
  syncComputeBackendUi();
  invalidateComputedResultIfConfigChanged();
  refreshDataTab();
  refreshWorkloadEstimate();
};
syncMetricUi();
syncComputeBackendUi();
$('computeBackend').onchange = () => {
  syncComputeBackendUi();
  invalidateComputedResultIfConfigChanged();
  refreshWorkloadEstimate();
};
['posWeight', 'quantilePct', 'normalize', 'windowPct', 'lenNorm'].forEach((id) => {
  $(id).onchange = invalidateComputedResultIfConfigChanged;
});
if ($('profileViewMode')) {
  $('profileViewMode').onchange = () => {
    if (S.profiles && S.result) renderClusterFacets();
  };
}
if ($('profileClipOutliers')) {
  $('profileClipOutliers').onchange = () => {
    if (S.profiles && S.result) renderClusterFacets();
  };
}

installClientErrorHandlers({ statusElement: $('statusLine') });

init().catch((error) => {
  $('runDtw').disabled = true;
  $('runCluster').disabled = true;
  $('statusLine').textContent = `טעינת נתוני הדפדפן נכשלה: ${error.message}`;
  console.error(error);
});

function renderClusters() {
  const r = S.result;
  const lens = Array.from({ length: r.k }, () => []);
  S.labels.forEach((l, i) => l >= 0 && lens[l].push(S.samples[i].n));
  const med = (a) => (a.length ? a.sort((x, y) => x - y)[a.length >> 1] : 0);
  const order = r.sizes.map((s, i) => i).sort((a, b) => r.sizes[b] - r.sizes[a]);
  $('clusterTable').tBodies[0].innerHTML = order.map((c) => {
    const m = S.samples[r.medoids[c]];
    const medoidLabel = m ? routeLabel(m) : '';
    return `<tr data-c="${c}"><td><span class="dot" style="background:${color(c)}"></span></td><td>${c + 1}</td><td class="num">${r.sizes[c]}</td><td class="num">${fmt(r.silhouetteByCluster[c], 2)}</td><td>${m ? `<button class="route-link" title="${esc(medoidLabel)}" data-sample-index="${r.medoids[c]}">${esc(medoidLabel)}</button>` : ''}</td><td class="num">${med(lens[c])}</td></tr>`;
  }).join('') + (r.noise ? `<tr data-c="-1"><td><span class="dot" style="background:${color(-1)}"></span></td><td>רעש</td><td>${r.noise}</td><td></td><td></td><td></td></tr>` : '');
  $('clusterTable').querySelectorAll('tbody tr').forEach((tr) => (tr.onclick = () => selectCluster(+tr.dataset.c)));
  $('clusterTable').querySelectorAll('.route-link').forEach((button) => {
    button.onclick = (event) => {
      event.stopPropagation();
      selectPoint(Number(button.dataset.sampleIndex));
    };
  });
  $('silLine').textContent = `· silhouette ממוצע ${fmt(r.silhouette, 3)}`;
  drawSilCurve();
  drawCorrelationPlots();
  drawDendrogram();
  syncAlgoUi();
  renderMapLegend();
  if (!$('tab-map').hidden) refreshMap();
}

function selectCluster(c) {
  S.activeCluster = c;
  document.querySelectorAll('#clusterTable tbody tr').forEach((tr) => tr.classList.toggle('sel', +tr.dataset.c === c));
  renderMapLegend();
  draw();
  if (S.map) applyMapFilter();
  activateTab('profiles');
}

async function refreshClusterProfiles() {
  if (!S.result || !S.labels) return;
  if (S.profiles) {
    renderClusterFacets();
    return;
  }
  const requestId = (S.profileRequest || 0) + 1;
  S.profileRequest = requestId;
  $('clusterFacets').innerHTML = '<div class="card muted">טוען את כל הווקטורים מ-DuckDB…</div>';
  try {
    const rows = await api('/api/vectors', { ids: S.samples.map((sample) => sample.sample_id) });
    if (requestId !== S.profileRequest) return;
    if (rows.length !== S.samples.length) throw new Error(`נטענו ${rows.length.toLocaleString()} וקטורים מתוך ${S.samples.length.toLocaleString()}`);
    S.profiles = new Map(rows.map((row) => [row.sample_id, row]));
    renderClusterFacets();
  } catch (e) {
    if (requestId === S.profileRequest) $('clusterFacets').innerHTML = `<div class="card">שגיאה בטעינת הווקטורים: ${esc(e.message)}</div>`;
  }
}

const PROFILE_VIEW_SUBTITLES = {
  spacing: 'כל קו מוצג כפרופיל מרווחים מקומי במטרים: מיקום לאורך המסלול (m_k) בציר X מול מרווח בין תחנות (s_k) בציר Y — יחידות אחידות וללא הזזת אינדקס.',
  sawtooth: 'כל קו מוצג כפונקציית מרחק לתחנה הקרובה R(x) במטרים לאורך המסלול (שיא כל משולש הוא s_k / 2 במטרים) — יחידות אחידות.',
  norm2d: 'כל קו מוצג כעקומת ריכוז תחנות מנורמלת ב-[0,1]²: אחוז מרחק מצטבר (d_i / L) בציר X מול אחוז תחנות (i / (n-1)) בציר Y.',
  cumulative: 'מרחק מצטבר מראשית התבנית (מ׳) מול אינדקס תחנה; בשוליים מוצגות התפלגויות אורך המסלול ומספר התחנות לכל תבנית.',
};

function parseLengths(val, fallbackLen) {
  let arr = val;
  if (typeof arr === 'string') {
    try { arr = JSON.parse(arr); } catch { arr = null; }
  }
  return Array.isArray(arr) && arr.length ? arr.map((x) => Math.max(0, Number(x) || 0)) : [fallbackLen];
}

function buildProfileParts(profile, viewMode, fallbackFeature) {
  const parts = [];
  if (!profile) return parts;

  if (viewMode === 'spacing' || viewMode === 'sawtooth') {
    const seg = Array.isArray(profile.seg) ? profile.seg : profile.vec || [];
    const lengths = parseLengths(profile.seg_lengths ?? profile.pattern_lengths, seg.length);
    let offset = 0;
    for (const length of lengths) {
      if (length <= 0) continue;
      const points = [];
      let dist = 0;
      if (viewMode === 'spacing') {
        for (let i = 0; i < length; i++) {
          const s = Math.max(0, Number(seg[offset + i]) || 0);
          const m = dist + 0.5 * s;
          if (i === 0) points.push([0, s]);
          points.push([m, s]);
          dist += s;
          if (i === length - 1) points.push([dist, s]);
        }
      } else {
        points.push([0, 0]);
        for (let i = 0; i < length; i++) {
          const s = Math.max(0, Number(seg[offset + i]) || 0);
          points.push([dist + 0.5 * s, 0.5 * s]);
          dist += s;
          points.push([dist, 0]);
        }
      }
      if (points.length > 1) parts.push(points);
      offset += length;
    }
    return parts;
  }

  if (viewMode === 'norm2d') {
    const cum = Array.isArray(profile.cum) ? profile.cum : profile.vec || [];
    const lengths = parseLengths(profile.cum_lengths ?? profile.pattern_lengths, cum.length);
    let offset = 0;
    for (const length of lengths) {
      if (length <= 1) {
        offset += length;
        continue;
      }
      const origin = Number(cum[offset]) || 0;
      const total = Math.max(1e-9, (Number(cum[offset + length - 1]) || 0) - origin);
      const denom = Math.max(1, length - 1);
      const points = [];
      for (let i = 0; i < length; i++) {
        const x = Math.min(1, Math.max(0, ((Number(cum[offset + i]) || 0) - origin) / total));
        const y = i / denom;
        points.push([x, y]);
      }
      if (points.length > 1) parts.push(points);
      offset += length;
    }
    return parts;
  }

  // cumulative: (distance_m, stop_index)
  const useCum = Array.isArray(profile.cum) && profile.cum.length > 0;
  const vec = useCum ? profile.cum : profile.vec || [];
  const lengths = parseLengths(useCum ? profile.cum_lengths : profile.pattern_lengths, vec.length);
  let offset = 0;
  for (const length of lengths) {
    const points = [];
    let distance = 0;
    if (useCum || fallbackFeature === 'cum') {
      const origin = Number(vec[offset]) || 0;
      for (let i = 0; i < length; i++) {
        const x = Math.max(0, (Number(vec[offset + i]) || 0) - origin);
        points.push([x, i]);
      }
    } else {
      points.push([0, 0]);
      for (let i = 0; i < length; i++) {
        distance += Number(vec[offset + i]) || 0;
        points.push([distance, i + 1]);
      }
    }
    if (points.length > 1) parts.push(points);
    offset += length;
  }
  return parts;
}

function renderClusterFacets() {
  if (!S.profiles || !S.result) return;
  const viewMode = $('profileViewMode') ? $('profileViewMode').value : 'spacing';
  if ($('profilesSubtitle')) $('profilesSubtitle').textContent = PROFILE_VIEW_SUBTITLES[viewMode] || '';
  if ($('profileClipWrap')) $('profileClipWrap').hidden = viewMode !== 'spacing' && viewMode !== 'sawtooth';
  const groups = new Map();
  S.labels.forEach((cluster, index) => {
    if (!groups.has(cluster)) groups.set(cluster, []);
    const sample = S.samples[index];
    groups.get(cluster).push({ index, sample, profile: S.profiles.get(sample.sample_id) });
  });
  const ordered = [...groups].sort((a, b) => {
    if (a[0] < 0) return 1;
    if (b[0] < 0) return -1;
    return b[1].length - a[1].length;
  });
  $('clusterFacets').innerHTML = ordered.map(([cluster, members]) => {
    const medoidIndex = cluster < 0 ? -1 : S.result.medoids[cluster];
    const medoid = members.find((member) => member.index === medoidIndex);
    return `<article class="card cluster-facet ${S.activeCluster === cluster ? 'active' : ''}">
      <header class="facet-header"><h3>${cluster < 0 ? 'רעש' : `אשכול ${cluster + 1}`}</h3><span>${members.length.toLocaleString()} וקטורים</span></header>
      <div class="facet-legend"><span class="facet-swatch" style="background:${color(cluster)}"></span>כל הפרופילים (${members.length}) <span class="facet-swatch representative-swatch"></span>
        ${medoid ? `נציג: <button class="route-link" data-sample-index="${medoid.index}">${esc(routeLabel(medoid.sample))}</button>` : 'אין נציג לאשכול זה'}</div>
      <canvas class="profile-plot" width="980" height="360" aria-label="פרופילי ${cluster < 0 ? 'רעש' : `אשכול ${cluster + 1}`}"></canvas>
    </article>`;
  }).join('');
  $('clusterFacets').querySelectorAll('.profile-plot').forEach((canvas, index) => {
    const [cluster, members] = ordered[index];
    drawDistanceFacet(canvas, members, cluster < 0 ? -1 : S.result.medoids[cluster], viewMode);
  });
  $('clusterFacets').querySelectorAll('.route-link').forEach((button) => {
    button.onclick = () => selectPoint(Number(button.dataset.sampleIndex));
  });
}

function drawDistanceFacet(canvas, members, medoidIndex, viewMode = 'spacing', interactive = true) {
  const g = canvas.getContext('2d');
  const cumulative = viewMode === 'cumulative';
  const L = 76, R = cumulative ? 96 : 18, T = cumulative ? 62 : 18, B = 52;
  g.clearRect(0, 0, canvas.width, canvas.height);
  const lines = [];
  let maxX = 0, maxY = 0;
  const ySamples = [];
  for (const member of members) {
    const parts = buildProfileParts(member.profile, viewMode, S.config?.feature);
    if (!parts.length) continue;
    for (const pts of parts) {
      for (const [x, y] of pts) {
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        if (y > 0) ySamples.push(y);
      }
    }
    lines.push({ index: member.index, parts, representative: member.index === medoidIndex });
  }
  if (!lines.length) {
    g.fillStyle = '#6b7280';
    g.fillText('אין וקטורים להצגה', L, T + 16);
    return;
  }
  const clipOutliers = $('profileClipOutliers') ? $('profileClipOutliers').checked : true;
  if ((viewMode === 'spacing' || viewMode === 'sawtooth') && clipOutliers && ySamples.length > 10) {
    ySamples.sort((a, b) => a - b);
    const q98 = ySamples[Math.floor(ySamples.length * 0.98)] * 1.1;
    if (q98 > 0) maxY = Math.min(maxY, q98);
  }
  if (viewMode === 'norm2d') {
    maxX = 1;
    maxY = 1;
  } else {
    maxX = Math.max(1, maxX);
    maxY = Math.max(1, maxY);
  }
  const X = (x) => L + (Math.min(x, maxX) / maxX) * (canvas.width - L - R);
  const Y = (y) => canvas.height - B - (Math.min(y, maxY) / maxY) * (canvas.height - T - B);
  const fmtTick = (val) => (viewMode === 'norm2d' ? `${Math.round(val * 100)}%` : Math.round(val).toLocaleString());
  g.font = '600 16px "Segoe UI", sans-serif';
  g.textAlign = 'right';
  g.textBaseline = 'middle';
  for (let tick = 0; tick <= 4; tick++) {
    const y = maxY * tick / 4;
    g.strokeStyle = '#e5e8ee';
    g.beginPath();
    g.moveTo(L, Y(y));
    g.lineTo(canvas.width - R, Y(y));
    g.stroke();
    g.fillStyle = '#374151';
    g.fillText(fmtTick(y), L - 8, Y(y));
  }
  g.textAlign = 'center';
  g.textBaseline = 'top';
  for (let tick = 0; tick <= 4; tick++) {
    const x = maxX * tick / 4;
    g.strokeStyle = '#e5e8ee';
    g.beginPath();
    g.moveTo(X(x), T);
    g.lineTo(X(x), canvas.height - B);
    g.stroke();
    g.fillStyle = '#374151';
    g.fillText(fmtTick(x), X(x), canvas.height - B + 7);
  }
  const axisLabels = {
    spacing: ['מיקום לאורך המסלול m_k (מ׳)', 'מרווח בין תחנות s_k (מ׳)'],
    sawtooth: ['מרחק לאורך המסלול x (מ׳)', 'מרחק לתחנה קרובה R(x) (מ׳)'],
    norm2d: ['אחוז מרחק מצטבר (d_i / L)', 'אחוז תחנות מצטבר (i / (n-1))'],
    cumulative: ['מרחק מראשית התבנית (מ׳)', 'אינדקס תחנה'],
  }[viewMode] || ['מרחק מראשית התבנית (מ׳)', 'אינדקס תחנה'];

  g.fillStyle = '#374151';
  g.font = '14px "Segoe UI", sans-serif';
  g.textAlign = 'center';
  g.fillText(axisLabels[0], (L + canvas.width - R) / 2, canvas.height - 18);
  g.save();
  g.translate(16, (T + canvas.height - B) / 2);
  g.rotate(-Math.PI / 2);
  g.fillText(axisLabels[1], 0, 0);
  g.restore();

  const orderedLines = [...lines.filter((line) => !line.representative), ...lines.filter((line) => line.representative)];
  const profileAlpha = Math.min(0.55, Math.max(0.06, 1.2 / Math.sqrt(lines.length)));
  for (const line of orderedLines) {
    g.globalAlpha = line.representative ? 1 : profileAlpha;
    const strokeColor = line.representative
      ? (interactive ? '#111827' : (S.labels && line.index >= 0 ? color(S.labels[line.index]) : '#1f6feb'))
      : (S.labels ? color(S.labels[line.index]) : '#1f6feb');
    g.strokeStyle = strokeColor;
    g.lineWidth = line.representative ? 2.6 : (cumulative ? 1.4 : 1);
    for (const points of line.parts) {
      g.beginPath();
      points.forEach(([x, y], i) => (i ? g.lineTo(X(x), Y(y)) : g.moveTo(X(x), Y(y))));
      g.stroke();
    }
  }
  if (cumulative) {
    const routeLengths = [];
    const stopCounts = [];
    for (const line of lines) {
      for (const part of line.parts) {
        if (part.length < 2) continue;
        routeLengths.push(part[part.length - 1][0]);
        stopCounts.push(part.length);
      }
    }
    const binCount = 12;
    const histogram = (values, max, offset = 0) => {
      const bins = Array(binCount).fill(0);
      for (const value of values) {
        const index = Math.min(binCount - 1, Math.floor(((value - offset) / max) * binCount));
        bins[Math.max(0, index)]++;
      }
      return bins;
    };
    const routeBins = histogram(routeLengths, maxX);
    const stopBins = histogram(stopCounts, maxY, 1);
    const plotWidth = canvas.width - L - R;
    const plotHeight = canvas.height - T - B;
    const topHeight = 27;
    const routeMax = Math.max(1, ...routeBins);
    const stopMax = Math.max(1, ...stopBins);

    g.globalAlpha = 1;
    g.fillStyle = '#64748b';
    g.font = '14px "Segoe UI", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('התפלגות אורך מסלול (מ׳)', L + plotWidth / 2, 12);
    g.fillStyle = '#cbd5e1';
    routeBins.forEach((count, index) => {
      const binWidth = plotWidth / binCount;
      const barHeight = (count / routeMax) * topHeight;
      g.fillRect(L + index * binWidth + 1, T - topHeight + (topHeight - barHeight), Math.max(1, binWidth - 2), barHeight);
    });

    const sideX = canvas.width - R + 8;
    const sideWidth = 44;
    g.fillStyle = '#cbd5e1';
    stopBins.forEach((count, index) => {
      const yTop = T + (1 - (index + 1) / binCount) * plotHeight;
      const yBottom = T + (1 - index / binCount) * plotHeight;
      const barWidth = (count / stopMax) * sideWidth;
      g.fillRect(sideX, yTop + 1, barWidth, Math.max(1, yBottom - yTop - 2));
    });
    g.save();
    g.translate(canvas.width - 12, T + plotHeight / 2);
    g.rotate(-Math.PI / 2);
    g.fillStyle = '#64748b';
    g.fillText('מספר תחנות', 0, 0);
    g.restore();
  }
  g.globalAlpha = 1;
  g.lineWidth = 1;
  if (!interactive) return;
  profileHitTargets.set(canvas, orderedLines.map((line) => ({ index: line.index, parts: line.parts.map((part) => part.map(([x, y]) => [X(x), Y(y)])) })));
  canvas.onclick = (event) => {
    const rect = canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) * canvas.width / rect.width;
    const y = (event.clientY - rect.top) * canvas.height / rect.height;
    if (cumulative && (x < L || x > canvas.width - R || y < T || y > canvas.height - B)) return;
    let nearestIndex = -1, nearestDistance = 100;
    for (const target of profileHitTargets.get(canvas) || []) {
      for (const part of target.parts) {
        for (let i = 1; i < part.length; i++) {
          const [x1, y1] = part[i - 1], [x2, y2] = part[i];
          const dx = x2 - x1, dy = y2 - y1;
          const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy || 1)));
          const distance = (x - x1 - t * dx) ** 2 + (y - y1 - t * dy) ** 2;
          if (distance < nearestDistance) {
            nearestDistance = distance;
            nearestIndex = target.index;
          }
        }
      }
    }
    if (nearestIndex >= 0) selectPoint(nearestIndex);
  };
}

async function selectPoint(i) {
  S.selected = i;
  draw();
  $('tabButton-investigation').disabled = false;
  activateTab('investigation');
  $('detailPanel').innerHTML = '<div class="detail-empty">טוען פרטי קו…</div>';
  const s = S.samples[i];
  try {
    const d = await api(`/api/sample?unit=${encodeURIComponent(S.config.unit)}&feature=${encodeURIComponent(S.config.feature)}&id=${encodeURIComponent(s.sample_id)}`);
    renderRouteDetail(d, i, S.config);
    renderMapRouteDetail(d, i);
  } catch (e) {
    $('detailPanel').innerHTML = `<div class="detail-empty">${esc(e.message)}</div>`;
  }
}

async function investigateSample(sampleId) {
  const index = S.samples.findIndex((sample) => sample.sample_id === sampleId);
  if (index >= 0 && S.config) {
    selectPoint(index);
    return;
  }
  const config = readConfig();
  $('tabButton-investigation').disabled = false;
  activateTab('investigation');
  $('detailPanel').innerHTML = '<div class="detail-empty">טוען פרטי קו…</div>';
  try {
    const d = await api(`/api/sample?unit=${encodeURIComponent(config.unit)}&feature=${encodeURIComponent(config.feature)}&id=${encodeURIComponent(sampleId)}`);
    renderRouteDetail(d, -1, config);
  } catch (e) {
    $('detailPanel').innerHTML = `<div class="detail-empty">${esc(e.message)}</div>`;
  }
}

function renderRouteDetail(d, i, config) {
  const cluster = S.labels && i >= 0 ? S.labels[i] : null;
  const clusterText = cluster == null ? 'טרם קובץ' : cluster < 0 ? 'רעש' : `אשכול ${cluster + 1}`;
  const patterns = d.patterns || [];
  const first = patterns[0];
  const patternCards = patterns.map((p) => `
    <article class="pattern-card">
      <header><strong>תבנית ${p.rank}</strong><span class="muted">${p.trips} נסיעות</span></header>
      <div class="pattern-route"><bdi>${esc(p.first_stop || 'לא ידוע')}</bdi> ← <bdi>${esc(p.last_stop || 'לא ידוע')}</bdi></div>
      <div class="pattern-metrics"><span>${p.n_stops} תחנות</span><span>${Math.round(p.total_m || 0).toLocaleString()} מ׳</span></div>
    </article>`).join('');
  $('detailPanel').classList.remove('empty-detail');
  $('detailPanel').innerHTML = `
    <div class="detail-hero"><div>
      <div class="muted">פרטי קו · מזהה ${esc(d.route_id)}</div>
      <h2 class="detail-title"><bdi>${esc(d.route_short_name)}</bdi> · <bdi>${esc(d.route_long_name)}</bdi>${d.route_desc ? ` (${esc(d.route_desc)})` : ''}</h2>
      ${d.route_desc ? `<div class="detail-desc">${esc(d.route_desc)}</div>` : '<div class="detail-desc muted">אין תיאור route_desc בנתוני GTFS לקו זה.</div>'}
    </div><div class="detail-badge"><span class="dot" style="background:${cluster == null ? '#9aa1ab' : color(cluster)}"></span><strong>${esc(clusterText)}</strong></div></div>
    <div class="detail-stats">
      <div class="detail-stat"><strong>${esc(d.agency_name)}</strong><span>מפעיל</span></div>
      <div class="detail-stat"><strong>${esc(typeName(d.route_type))}</strong><span>סוג שירות</span></div>
      <div class="detail-stat"><strong>${Number(d.n_trips).toLocaleString()}</strong><span>נסיעות בתבניות הנכללות</span></div>
      <div class="detail-stat"><strong>${d.n_patterns}</strong><span>תבניות נסיעה ייחודיות</span></div>
    </div>
    <div class="detail-ends">
      <div class="detail-end"><span class="muted">תחנת התחלה</span><strong><bdi>${esc(first?.first_stop || d.first_stop || 'לא ידוע')}</bdi></strong></div>
      <div class="detail-arrow">←</div>
      <div class="detail-end"><span class="muted">תחנת סיום</span><strong><bdi>${esc(first?.last_stop || d.last_stop || 'לא ידוע')}</bdi></strong></div>
    </div>
    <div class="detail-content">
      <div><h3>תבניות נסיעה בקו</h3><div class="pattern-list">${patternCards || '<div class="muted">לא נמצאו פרטי תבנית להצגה.</div>'}</div></div>
      <div class="detail-charts">
        <div class="vector-card"><h3>פרופיל מרווחים מרחבי (m_k, s_k) במטרים (יחידות אחידות)</h3>
          <div class="vector-caption">ציר X: מיקום לאורך המסלול (מ׳) · ציר Y: מרווח בין תחנות (מ׳)</div>
          <canvas id="spacingplot" width="760" height="260"></canvas>
        </div>
        <div class="vector-card"><h3>וקטור ${config.feature === 'cum' ? 'מרחק מצטבר' : 'מרחק בין תחנות'} לפי אינדקס</h3>
          <div class="vector-caption">${d.vec.length} ערכים · ${config.normalize === 'none' ? 'ללא נרמול' : `נרמול ${config.normalize}`} · קו מפריד בין תבניות</div>
          <canvas id="vecplot" width="760" height="240"></canvas>
        </div>
      </div>
    </div>`;
  const breaks = d.n_patterns > 1 ? patterns.map((p) => p.n_stops - (config.feature === 'seg' ? 1 : 0)) : null;
  drawLines($('vecplot'), [{ vec: d.vec, color: cluster == null ? '#1f6feb' : color(cluster), alpha: 1, w: 2 }], breaks);
  if ($('spacingplot')) {
    drawDistanceFacet(
      $('spacingplot'),
      [{ index: i, profile: d }],
      i,
      'spacing',
      false
    );
  }
}

function initializeRouteMap() {
  if (S.map) return;
  S.map = L.map('routeMap', { preferCanvas: true }).setView([31.7, 35.0], 7);
  S.mapRenderer = L.canvas({ padding: 0.2 });
  const failedTiles = new Set();
  const tileLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  });
  const updateTileStatus = () => {
    $('mapTileStatus').textContent = failedTiles.size
      ? 'אין גישה לאריחי מפת הרקע. קווי ה-GTFS נטענים בנפרד ויוצגו ללא רקע.'
      : '';
  };
  tileLayer.on('tileerror', (event) => {
    if (event.tile?.src) failedTiles.add(event.tile.src);
    updateTileStatus();
  });
  tileLayer.on('tileload', (event) => {
    if (event.tile?.src) failedTiles.delete(event.tile.src);
    updateTileStatus();
  });
  S.map.addLayer(tileLayer);
}

function renderMapLegend() {
  if (!S.result) return;
  const labels = new Map();
  S.labels.forEach((c) => labels.set(c, (labels.get(c) || 0) + 1));
  const items = [...labels].sort(([left], [right]) => {
    if (left < 0) return 1;
    if (right < 0) return -1;
    return left - right;
  });
  $('mapLegend').innerHTML = `<button class="legend-item ${S.activeCluster == null ? 'active' : ''}" data-cluster="all"><span class="legend-swatch" style="background:#334155"></span>כל הקווים (${S.samples.length.toLocaleString()})</button>` +
    items.map(([c, n]) => `<button class="legend-item ${S.activeCluster === c ? 'active' : ''}" data-cluster="${c}"><span class="legend-swatch" style="background:${color(c)}"></span>${c < 0 ? 'רעש' : `אשכול ${c + 1}`} (${n})</button>`).join('');
  $('mapLegend').querySelectorAll('[data-cluster]').forEach((b) => (b.onclick = () => {
    S.activeCluster = b.dataset.cluster === 'all' ? null : Number(b.dataset.cluster);
    renderMapLegend();
    applyMapFilter();
  }));
}

function applyMapFilter() {
  const index = new Map(S.samples.map((s, i) => [s.sample_id, i]));
  for (const item of S.mapLayers) {
    const i = index.get(item.sample_id);
    const active = S.activeCluster == null || S.labels[i] === S.activeCluster;
    item.layer.setStyle({ opacity: active ? 0.92 : 0.04, weight: active ? 4.5 : 1.5 });
  }
}

function renderMapRouteDetail(d, i) {
  const c = S.labels ? S.labels[i] : null;
  $('mapRouteDetail').innerHTML = `<strong><bdi>${esc(d.route_short_name)}</bdi> · <bdi>${esc(d.route_long_name)}</bdi>${d.route_desc ? ` (${esc(d.route_desc)})` : ''}</strong>
    <div class="route-desc">${d.route_desc ? esc(d.route_desc) : 'אין route_desc זמין.'}</div>
    ${esc(d.agency_name)} · ${esc(typeName(d.route_type))} · ${d.n_patterns} תבניות · ${Number(d.n_trips).toLocaleString()} נסיעות<br>
    ${c == null ? 'טרם קובץ' : c < 0 ? 'רעש' : `אשכול ${c + 1}`}`;
}

async function refreshMap() {
  if (!S.result || !S.labels) return;
  initializeRouteMap();
  const requestId = (S.mapRequest || 0) + 1;
  S.mapRequest = requestId;
  $('mapInfo').textContent = 'טוען גיאומטריות מסלולים מ-DuckDB…';
  try {
    const selected = S.samples.map((s, i) => ({ sample_id: s.sample_id, cluster: S.labels[i] }));
    const rows = await api('/api/map-lines', { samples: selected });
    if (requestId !== S.mapRequest) return;
    for (const item of S.mapLayers) item.layer.remove();
    S.mapLayers = [];
    const sampleIndex = new Map(S.samples.map((s, i) => [s.sample_id, i]));
    for (const row of rows) {
      const coords = (typeof row.points === 'string' ? JSON.parse(row.points) : row.points).map(([lon, lat]) => [Number(lat), Number(lon)]);
      if (coords.length < 2) continue;
      const sample = S.samples[sampleIndex.get(row.sample_id)];
      const layer = L.polyline(coords, { color: color(row.cluster_id), weight: 4.5, opacity: 0.92, className: 'map-line', renderer: S.mapRenderer }).addTo(S.map);
      layer.on('click', () => {
        const i = sampleIndex.get(row.sample_id);
        if (i == null) return;
        renderMapRouteDetail(sample, i);
        selectPoint(i);
        const popup = document.createElement('div');
        popup.innerHTML = `<strong>${esc(routeLabel(sample))}</strong><br>${esc(sample.agency_name)} · ${row.cluster_id < 0 ? 'רעש' : `אשכול ${row.cluster_id + 1}`}`;
        layer.bindPopup(popup).openPopup();
      });
      S.mapLayers.push({ sample_id: row.sample_id, layer });
    }
    if (S.mapLayers.length) {
      const group = L.featureGroup(S.mapLayers.map((x) => x.layer));
      S.map.fitBounds(group.getBounds().pad(0.04), { animate: false });
    }
    applyMapFilter();
    $('mapInfo').textContent = `${S.mapLayers.length.toLocaleString()} מקטעי מסלול · צבע לפי אשכול · לחצו על מסלול לפרטים. רק מסלולים הזמינים ב-shapes מוצגים.`;
  } catch (e) {
    if (requestId === S.mapRequest) $('mapInfo').textContent = `לא ניתן לטעון את המפה: ${e.message}`;
  }
}

function activateClusterView(name) {
  const buttons = [...document.querySelectorAll('.cluster-view-tabs [data-cluster-view]')];
  const selected = buttons.find((button) => button.dataset.clusterView === name);
  if (!selected || selected.hidden) return;
  buttons.forEach((button) => {
    const active = button === selected;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  document.querySelectorAll('.cluster-view-panel').forEach((panel) => {
    panel.hidden = panel.id !== `cluster-view-${name}`;
  });
}

function syncClusterViewTabs() {
  const dendrogramButton = $('clusterViewDendrogram');
  if (!dendrogramButton) return;
  const available = $('algo').value === 'hierarchical' && Boolean(S.result?.merges);
  const wasActive = dendrogramButton.classList.contains('active');
  dendrogramButton.hidden = !available;
  if (!available && wasActive) activateClusterView('overview');
}

document.querySelectorAll('.cluster-view-tabs [data-cluster-view]').forEach((button) => {
  button.onclick = () => activateClusterView(button.dataset.clusterView);
});

function activateTab(name) {
  document.querySelectorAll('.tabs button').forEach((button) => button.classList.toggle('active', button.dataset.tab === name));
  $('tab-clusters').hidden = name !== 'clusters';
  $('tab-methodology-notes').hidden = name !== 'methodology-notes';
  if ($('tab-methodology')) $('tab-methodology').hidden = name !== 'methodology';
  $('tab-map').hidden = name !== 'map';
  $('tab-data').hidden = name !== 'data';
  $('tab-profiles').hidden = name !== 'profiles';
  $('tab-investigation').hidden = name !== 'investigation';
  if (name === 'map') {
    initializeRouteMap();
    if (S.result) refreshMap();
    setTimeout(() => S.map?.invalidateSize(), 0);
  } else if (name === 'profiles') {
    refreshClusterProfiles();
  } else if (name === 'methodology') {
    initMethodologyTab();
  }
}
document.querySelectorAll('.tabs button').forEach((button) => (button.onclick = () => activateTab(button.dataset.tab)));
$('fitMap').onclick = () => {
  if (S.mapLayers.length) {
    const index = new Map(S.samples.map((s, i) => [s.sample_id, i]));
    const visible = S.mapLayers.filter((x) => S.activeCluster == null || S.labels[index.get(x.sample_id)] === S.activeCluster);
    const group = L.featureGroup(visible.map((x) => x.layer));
    if (group.getLayers().length) S.map.fitBounds(group.getBounds().pad(0.04));
  } else {
    S.map?.setView([31.7, 35.0], 7);
  }
};

async function refreshDataTab() {
  const requestId = (S.dataRequest || 0) + 1;
  S.dataRequest = requestId;
  try {
    const r = await api('/api/samples', { ...readConfig(), search: $('search').value, limit: 300 });
    if (requestId !== S.dataRequest) return;
    $('dataInfo').textContent = `${r.total.toLocaleString()} דגימות תואמות לסינון (מוצגות ${r.rows.length})`;
    $('sampleInfo').textContent = `${r.total.toLocaleString()} דגימות עומדות בסינון`;
    $('dataTable').tBodies[0].innerHTML = r.rows.map((x) =>
      `<tr data-sample-id="${esc(x.sample_id)}"><td><bdi>${esc(x.route_short_name)}${x.route_desc ? ` (${esc(x.route_desc)})` : ''}</bdi></td><td><bdi>${esc(x.route_long_name)}</bdi></td><td>${esc(x.agency_name)}</td><td>${esc(typeName(x.route_type))}</td><td>${x.n_patterns}</td><td>${x.n_trips}</td><td>${x.n}</td><td>${x.total_m}</td></tr>`
    ).join('');
    $('dataTable').tBodies[0].querySelectorAll('tr[data-sample-id]').forEach((row) => {
      row.onclick = () => investigateSample(row.dataset.sampleId);
    });
    populateMethGtfsOptions(r.rows);
  } catch (e) {
    if (requestId === S.dataRequest) $('dataInfo').textContent = `שגיאה בטעינת נתונים: ${e.message}`;
  }
}

// ---------- Interactive Methodology Visualizer Tab ----------
const METH_PRESETS = {
  drift: {
    nameA: 'קו א׳ (יוצא ישירות מהמסוף ואז עוצר כל 1,000 מ׳)',
    nameB: 'קו ב׳ (6 תחנות איסוף צפופות ב-1.5 ק״מ הראשונים, וזהה לקו א׳ בהמשך)',
    cumA: [0, 750, 1500, 2500, 3500, 4500, 5500, 6500, 7500, 8500, 9500, 10500, 11500],
    cumB: [0, 220, 450, 680, 920, 1150, 1340, 1500, 2500, 3500, 4500, 5500, 6500, 7500, 8500, 9500, 10500, 11500],
  },
  express: {
    nameA: 'קו א׳ (מאסף עירוני ← כביש מהיר 6.5 ק״מ ← פיזור)',
    nameB: 'קו ב׳ (מאסף ארוך ב-600 מ׳ ← כביש מהיר 6.3 ק״מ ← פיזור עם דילוג תחנה)',
    cumA: [0, 350, 700, 1050, 1400, 1800, 8300, 8700, 9100, 9500, 9900, 10300, 10700],
    cumB: [0, 320, 650, 980, 1320, 1680, 2040, 2400, 8700, 9500, 9900, 10300, 10700],
  },
  outlier: {
    nameA: 'קו א׳ (קו עירוני אחיד, מרווחים ~400–500 מ׳)',
    nameB: 'קו ב׳ (אותו קו עירוני + תחנת קצה תפעולית מרוחקת ב-3.8 ק״מ)',
    cumA: [0, 420, 850, 1300, 1720, 2150, 2600, 3050, 3500, 3950, 4400, 4850],
    cumB: [0, 420, 850, 1300, 1720, 2150, 2600, 3050, 3500, 3950, 4400, 4850, 8650],
  },
  scale: {
    nameA: 'קו א׳ (אורך 6 ק״מ: איסוף ← מקטע מהיר ← פיזור)',
    nameB: 'קו ב׳ (אורך 12 ק״מ: אותה צורת פיזור תחנות בדיוק בקנה מידה כפול ×2)',
    cumA: [0, 300, 600, 900, 1200, 4500, 4850, 5200, 5600, 6000],
    cumB: [0, 600, 1200, 1800, 2400, 9000, 9700, 10400, 11200, 12000],
  },
};

const M = {
  initialized: false,
  methodIdx: 0, // 0..5 (which of the 6 distance methods is being explained)
  step: 0,      // 0..3 (which step inside the chosen method)
  prevCoord: 'cum',
  morph: 1,
  animFrame: null,
  gtfsRows: [],
  customPair: null,
  pairRequest: 0,
  gtfsSearchRequest: 0,
  gtfsSearchTimer: null,
};

function buildProfileObj(name, rawCum) {
  const cum = rawCum.map(Number).filter((x) => Number.isFinite(x));
  if (cum.length < 2) cum.push(0, 1000);
  const c0 = cum[0];
  const zeroCum = cum.map((x) => Math.max(0, x - c0));
  const seg = [];
  const mid = [];
  for (let i = 1; i < zeroCum.length; i++) {
    const s = Math.max(0, zeroCum[i] - zeroCum[i - 1]);
    seg.push(s);
    mid.push(zeroCum[i - 1] + 0.5 * s);
  }
  const totalLen = Math.max(1, zeroCum[zeroCum.length - 1]);
  const weights = seg.map((s) => s / totalLen);
  return { name, cum: zeroCum, seg, mid, totalLen, weights, nStops: zeroCum.length, nSeg: seg.length };
}

function getActiveMethPair() {
  const preset = $('methPreset')?.value || 'drift';
  if (preset === 'gtfs' && M.customPair) {
    return M.customPair;
  }
  const p = METH_PRESETS[preset] || METH_PRESETS.drift;
  return {
    A: buildProfileObj(p.nameA, p.cumA),
    B: buildProfileObj(p.nameB, p.cumB),
  };
}

function populateMethGtfsOptions(rows) {
  if (!Array.isArray(rows) || !$('methSampleA')) return;
  const prevA = $('methSampleA').value;
  const prevB = $('methSampleB').value;
  const known = new Map(M.gtfsRows.map((row) => [String(row.sample_id), row]));
  rows.forEach((row) => known.set(String(row.sample_id), row));
  M.gtfsRows = [...known.values()];
  const visible = new Map(rows.map((row) => [String(row.sample_id), row]));
  for (const id of [prevA, prevB]) {
    if (id && known.has(id)) visible.set(id, known.get(id));
  }
  const options = [...visible.values()]
    .sort((a, b) => String(a.route_short_name).localeCompare(String(b.route_short_name), 'he', { numeric: true })
      || String(a.sample_id).localeCompare(String(b.sample_id), 'en', { numeric: true }));
  const html = options
    .map((r) => `<option value="${esc(r.sample_id)}">${esc(r.route_short_name)} · ${esc(r.route_long_name || '')} (${esc(r.agency_name)}, ${r.n} איברים)</option>`)
    .join('');
  const emptyOption = '<option value="">אין קווים תואמים</option>';
  $('methSampleA').innerHTML = html || emptyOption;
  $('methSampleB').innerHTML = html || emptyOption;
  if (prevA && [...$('methSampleA').options].some((o) => o.value === prevA)) $('methSampleA').value = prevA;
  else if ($('methSampleA').options.length) $('methSampleA').selectedIndex = 0;
  if (prevB && [...$('methSampleB').options].some((o) => o.value === prevB)) $('methSampleB').value = prevB;
  else if (options.length > 1) $('methSampleB').selectedIndex = 1;
  else if (options.length) $('methSampleB').selectedIndex = 0;
}

function searchMethGtfsOptions() {
  const requestId = ++M.gtfsSearchRequest;
  if (M.gtfsSearchTimer) clearTimeout(M.gtfsSearchTimer);
  const search = $('methRouteSearch').value.trim();
  $('methRouteSearchInfo').textContent = 'מחפש קווים לפי מספר...';
  M.gtfsSearchTimer = setTimeout(async () => {
    try {
      const result = await api('/api/samples', {
        ...readConfig(),
        routeNameSearch: search,
        limit: 1000,
      });
      if (requestId !== M.gtfsSearchRequest) return;
      populateMethGtfsOptions(result.rows);
      const shown = result.rows.length.toLocaleString();
      const total = result.total.toLocaleString();
      $('methRouteSearchInfo').textContent = search
        ? `נמצאו ${total} קווים שמספרם מכיל "${search}" (מוצגים עד ${shown}).`
        : `מוצגים ${shown} מתוך ${total} קווים; הזינו מספר קו לחיפוש ממוקד.`;
    } catch (error) {
      if (requestId !== M.gtfsSearchRequest) return;
      $('methRouteSearchInfo').textContent = `שגיאה בחיפוש קווים: ${error.message}`;
    }
  }, 220);
}

async function loadMethGtfsPair(idA, idB) {
  const requestId = ++M.pairRequest;
  const unit = $('unit')?.value || 'route';
  try {
    const [dA, dB] = await Promise.all([
      api(`/api/sample?unit=${encodeURIComponent(unit)}&feature=cum&id=${encodeURIComponent(idA)}`),
      api(`/api/sample?unit=${encodeURIComponent(unit)}&feature=cum&id=${encodeURIComponent(idB)}`),
    ]);
    if (requestId !== M.pairRequest) return;
    const sliceFirstPattern = (d) => {
      const cum = Array.isArray(d.cum) ? d.cum : d.vec || [];
      const lens = parseLengths(d.cum_lengths, cum.length);
      return cum.slice(0, lens[0] || cum.length);
    };
    M.customPair = {
      A: buildProfileObj(`קו ${dA.route_short_name} (${dA.agency_name})`, sliceFirstPattern(dA)),
      B: buildProfileObj(`קו ${dB.route_short_name} (${dB.agency_name})`, sliceFirstPattern(dB)),
    };
    renderMethodology();
  } catch (e) {
    console.error(e);
  }
}

// Compute all 6 distance families + visual matching vectors for pair (A, B)
function analyzeMethPair(A, B, lambda, q) {
  // 1. Naive 2D cumulative (d_i, i) vertical index drift at shared distances
  const driftPairs = [];
  let maxIndexDiff = 0;
  for (let i = 0; i < A.nStops; i++) {
    const da = A.cum[i];
    let bestJ = 0;
    let bestDist = Infinity;
    for (let j = 0; j < B.nStops; j++) {
      const d = Math.abs(da - B.cum[j]);
      if (d < bestDist) {
        bestDist = d;
        bestJ = j;
      }
    }
    const idxDiff = Math.abs(i - bestJ);
    if (idxDiff > maxIndexDiff) maxIndexDiff = idxDiff;
    driftPairs.push({ i, j: bestJ, da, db: B.cum[bestJ], idxDiff, distDiff: bestDist });
  }

  // 2. Exact DTW and Discrete Fréchet with backtracking on cumulative distances (or segment lengths)
  const n = A.nStops, m = B.nStops;
  const dpDtw = Array.from({ length: n + 1 }, () => new Float64Array(m + 1).fill(Infinity));
  const dpFre = Array.from({ length: n + 1 }, () => new Float64Array(m + 1).fill(Infinity));
  dpDtw[0][0] = 0;
  dpFre[0][0] = 0;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const c = Math.abs(A.cum[i - 1] - B.cum[j - 1]);
      dpDtw[i][j] = c + Math.min(dpDtw[i - 1][j], dpDtw[i][j - 1], dpDtw[i - 1][j - 1]);
      dpFre[i][j] = Math.max(c, Math.min(dpFre[i - 1][j], dpFre[i][j - 1], dpFre[i - 1][j - 1]));
    }
  }
  const tracePath = (dp) => {
    const path = [];
    let i = n, j = m;
    while (i > 0 && j > 0) {
      const cost = Math.abs(A.cum[i - 1] - B.cum[j - 1]);
      path.push({ i: i - 1, j: j - 1, cost });
      if (i === 1 && j === 1) break;
      const dDiag = i > 1 && j > 1 ? dp[i - 1][j - 1] : Infinity;
      const dUp = i > 1 ? dp[i - 1][j] : Infinity;
      const dLeft = j > 1 ? dp[i][j - 1] : Infinity;
      if (dDiag <= dUp && dDiag <= dLeft) { i--; j--; }
      else if (dUp <= dLeft) i--;
      else j--;
    }
    return path.reverse();
  };
  const dtwPath = tracePath(dpDtw);
  const frePath = tracePath(dpFre);
  const dtwRaw = dpDtw[n][m];
  const dtwNorm = dtwRaw / (n + m);
  const frechetVal = dpFre[n][m];
  let freMaxLink = frePath[0] || { i: 0, j: 0, cost: 0 };
  for (const lk of frePath) if (lk.cost > freMaxLink.cost) freMaxLink = lk;

  // Also compute DTW & Frechet on segments (`seg`)
  const ns = A.nSeg, ms = B.nSeg;
  const segDtw = Array.from({ length: ns + 1 }, () => new Float64Array(ms + 1).fill(Infinity));
  const segFre = Array.from({ length: ns + 1 }, () => new Float64Array(ms + 1).fill(Infinity));
  segDtw[0][0] = 0;
  segFre[0][0] = 0;
  for (let i = 1; i <= ns; i++) {
    for (let j = 1; j <= ms; j++) {
      const c = Math.abs(A.seg[i - 1] - B.seg[j - 1]);
      segDtw[i][j] = c + Math.min(segDtw[i - 1][j], segDtw[i][j - 1], segDtw[i - 1][j - 1]);
      segFre[i][j] = Math.max(c, Math.min(segFre[i - 1][j], segFre[i][j - 1], segFre[i - 1][j - 1]));
    }
  }
  const dtwSegNorm = segDtw[ns][ms] / (ns + ms);
  const frechetSegVal = segFre[ns][ms];

  // 3. Normalized 2D [0,1]^2 Hausdorff (Lévy / Lorenz concentration curve)
  const normA = A.cum.map((d, i) => [d / A.totalLen, i / Math.max(1, A.nStops - 1)]);
  const normB = B.cum.map((d, j) => [d / B.totalLen, j / Math.max(1, B.nStops - 1)]);
  const normLinks = [];
  for (let i = 0; i < normA.length; i++) {
    let bestJ = 0, bestD = Infinity;
    for (let j = 0; j < normB.length; j++) {
      const d = Math.hypot(normA[i][0] - normB[j][0], normA[i][1] - normB[j][1]);
      if (d < bestD) { bestD = d; bestJ = j; }
    }
    normLinks.push({ from: 'A', i, j: bestJ, ax: normA[i][0], ay: normA[i][1], bx: normB[bestJ][0], by: normB[bestJ][1], dist: bestD });
  }
  for (let j = 0; j < normB.length; j++) {
    let bestI = 0, bestD = Infinity;
    for (let i = 0; i < normA.length; i++) {
      const d = Math.hypot(normB[j][0] - normA[i][0], normB[j][1] - normA[i][1]);
      if (d < bestD) { bestD = d; bestI = i; }
    }
    normLinks.push({ from: 'B', i: bestI, j, ax: normA[bestI][0], ay: normA[bestI][1], bx: normB[j][0], by: normB[j][1], dist: bestD });
  }
  const sortedNorm = [...normLinks].sort((a, b) => a.dist - b.dist);
  const norm2dMax = sortedNorm[sortedNorm.length - 1] || { dist: 0 };
  const norm2dQuant = sortedNorm[Math.min(sortedNorm.length - 1, Math.floor(q * (sortedNorm.length - 1)))] || norm2dMax;

  // 4. 1D Point-Set Hausdorff on cumulative distances in meters
  const links1D = [];
  for (let i = 0; i < A.nStops; i++) {
    let bestJ = 0, bestD = Infinity;
    for (let j = 0; j < B.nStops; j++) {
      const d = Math.abs(A.cum[i] - B.cum[j]);
      if (d < bestD) { bestD = d; bestJ = j; }
    }
    links1D.push({ from: 'A', i, j: bestJ, a: A.cum[i], b: B.cum[bestJ], dist: bestD });
  }
  for (let j = 0; j < B.nStops; j++) {
    let bestI = 0, bestD = Infinity;
    for (let i = 0; i < A.nStops; i++) {
      const d = Math.abs(B.cum[j] - A.cum[i]);
      if (d < bestD) { bestD = d; bestI = i; }
    }
    links1D.push({ from: 'B', i: bestI, j, a: A.cum[bestI], b: B.cum[j], dist: bestD });
  }
  const sorted1D = [...links1D].sort((a, b) => a.dist - b.dist);
  const h1dMaxLink = sorted1D[sorted1D.length - 1] || { dist: 0 };
  const h1dQuantLink = sorted1D[Math.min(sorted1D.length - 1, Math.floor(q * (sorted1D.length - 1)))] || h1dMaxLink;

  // 5. Sawtooth R(x) = min_i |x - d_i| in meters
  const maxRouteX = Math.max(A.totalLen, B.totalLen, 1);
  const evalR = (P, x) => {
    let best = Infinity;
    for (let i = 0; i < P.nStops; i++) {
      const d = Math.abs(x - P.cum[i]);
      if (d < best) best = d;
    }
    return best;
  };
  let sawMaxDiff = 0, sawMaxX = 0, sawL1Sum = 0;
  const gridN = 300;
  for (let g = 0; g <= gridN; g++) {
    const x = (maxRouteX * g) / gridN;
    const ra = evalR(A, x);
    const rb = evalR(B, x);
    const diff = Math.abs(ra - rb);
    sawL1Sum += diff;
    if (diff > sawMaxDiff) {
      sawMaxDiff = diff;
      sawMaxX = x;
    }
  }
  for (const x of [...A.cum, ...B.cum, ...A.mid, ...B.mid]) {
    const diff = Math.abs(evalR(A, x) - evalR(B, x));
    if (diff > sawMaxDiff) {
      sawMaxDiff = diff;
      sawMaxX = x;
    }
  }
  const sawL1 = sawL1Sum / (gridN + 1);

  // 6. 2D Spacing Profile (m_k, s_k) in uniform meters
  const spacingAB = [];
  let wmhdAB = 0;
  for (let i = 0; i < A.nSeg; i++) {
    let bestJ = 0, bestD = Infinity;
    for (let j = 0; j < B.nSeg; j++) {
      const dx = lambda * Math.abs(A.mid[i] - B.mid[j]);
      const dy = Math.abs(A.seg[i] - B.seg[j]);
      const d = Math.max(dx, dy);
      if (d < bestD) { bestD = d; bestJ = j; }
    }
    wmhdAB += A.weights[i] * bestD;
    spacingAB.push({ from: 'A', i, j: bestJ, ma: A.mid[i], sa: A.seg[i], mb: B.mid[bestJ], sb: B.seg[bestJ], dist: bestD, weight: A.weights[i] });
  }
  const spacingBA = [];
  let wmhdBA = 0;
  for (let j = 0; j < B.nSeg; j++) {
    let bestI = 0, bestD = Infinity;
    for (let i = 0; i < A.nSeg; i++) {
      const dx = lambda * Math.abs(B.mid[j] - A.mid[i]);
      const dy = Math.abs(B.seg[j] - A.seg[i]);
      const d = Math.max(dx, dy);
      if (d < bestD) { bestD = d; bestI = i; }
    }
    wmhdBA += B.weights[j] * bestD;
    spacingBA.push({ from: 'B', i: bestI, j, ma: A.mid[bestI], sa: A.seg[bestI], mb: B.mid[j], sb: B.seg[j], dist: bestD, weight: B.weights[j] });
  }
  const allSpacingLinks = [...spacingAB, ...spacingBA].sort((a, b) => a.dist - b.dist);
  const spacingMaxLink = allSpacingLinks[allSpacingLinks.length - 1] || { dist: 0 };
  const wQuantDir = (arr) => {
    const s = [...arr].sort((a, b) => a.dist - b.dist);
    let acc = 0;
    for (const item of s) {
      acc += item.weight;
      if (acc >= q) return item;
    }
    return s[s.length - 1] || { dist: 0 };
  };
  const qA = wQuantDir(spacingAB);
  const qB = wQuantDir(spacingBA);
  const spacingQuantLink = qA.dist >= qB.dist ? qA : qB;
  const lenPenalty = lambda * Math.abs(A.totalLen - B.totalLen);
  const wmhdVal = Math.max(wmhdAB, wmhdBA, lenPenalty);
  const spacingQuantVal = Math.max(spacingQuantLink.dist, lenPenalty);
  const spacingMaxVal = Math.max(spacingMaxLink.dist, lenPenalty);

  return {
    driftPairs,
    maxIndexDiff,
    dtwPath,
    frePath,
    dtwNorm,
    dtwSegNorm,
    frechetVal,
    frechetSegVal,
    freMaxLink,
    normA,
    normB,
    normLinks,
    norm2dMax,
    norm2dQuant,
    links1D,
    h1dMaxLink,
    h1dQuantLink,
    evalR,
    sawMaxDiff,
    sawMaxX,
    sawL1,
    spacingAB,
    spacingBA,
    spacingMaxLink,
    spacingQuantLink,
    wmhdVal,
    spacingQuantVal,
    spacingMaxVal,
  };
}

function getPointsForCoordMode(P, coordMode, maxX, maxStops, maxSpacing) {
  // coordMode: 'cum' | 'spacing' | '1d' | 'sawtooth' | 'norm2d' | 'seq_seg'
  const pts = [];
  for (let i = 0; i < P.nStops; i++) {
    const d = P.cum[i];
    const k = Math.min(P.nSeg - 1, Math.max(0, i - 1));
    const s = P.seg[k] || 0;
    const m = P.mid[k] || 0;
    if (coordMode === 'cum') {
      pts.push([d / maxX, i / maxStops]);
    } else if (coordMode === 'spacing') {
      pts.push([m / maxX, s / maxSpacing]);
    } else if (coordMode === '1d') {
      pts.push([d / maxX, P.isB ? 0.34 : 0.66]);
    } else if (coordMode === 'sawtooth') {
      pts.push([d / maxX, 0]);
    } else if (coordMode === 'norm2d') {
      pts.push([d / P.totalLen, i / Math.max(1, P.nStops - 1)]);
    } else if (coordMode === 'seq_seg') {
      pts.push([k / Math.max(1, maxStops - 1), s / maxSpacing]);
    }
  }
  return pts;
}

// Detailed 4-step definition for EACH of the 6 methods separately
function getMethodsCatalog(pair, analysis, lambda, qPct) {
  const { A, B } = pair;
  return [
    {
      id: 'spacing_wmhd',
      tag: 'שיטה 1 מתוך 6 · השיטה המומלצת',
      name: '1. האוסדורף פרופיל מרווחים (mₖ, sₖ) במטרים (WMHD / H_q)',
      shortVal: `WMHD = ${Math.round(analysis.wmhdVal).toLocaleString()} מ׳ | H_${qPct}% = ${Math.round(analysis.spacingQuantVal).toLocaleString()} מ׳`,
      units: 'יחידות אחידות: מטרים × מטרים · ללא הזזת אינדקס · משוקלל לפי אורך מקטע',
      finalBanner: `מרחק סופי: WMHD = ${Math.round(analysis.wmhdVal).toLocaleString()} מ׳ | H_${qPct}% = ${Math.round(analysis.spacingQuantVal).toLocaleString()} מ׳ | Max = ${Math.round(analysis.spacingMaxVal).toLocaleString()} מ׳`,
      miniCoord: 'spacing',
      steps: [
        {
          stepLabel: 'שלב 1: הפרופיל המצטבר (dᵢ, i)',
          coord: 'cum',
          overlay: 'drift',
          badge: 'שיטה 1 · שלב 1 מתוך 4 — נקודת המוצא',
          title: 'מתחילים בגרף הפשוט: הפרופיל המצטבר (מרחק dᵢ מול אינדקס תחנה i)',
          axes: 'ציר X: מרחק מצטבר (מטרים) · ציר Y: אינדקס תחנה סידורי i (0, 1, 2, …)',
          body: `<ul>
            <li><strong>מה רואים בגרף:</strong> כל תחנה משורטטת לפי המרחק שלה מראשית הקו במטרים (X) ומספרה הסידורי ברצף התחנות (Y).</li>
            <li><strong>למה אי אפשר לחשב כאן מרחק האוסדורף ישירות?</strong>
              <br>1. <em>חוסר אחידות יחידות:</em> ציר X במטרים (אלפים) וציר Y במספרי תחנות (בודדים).
              <br>2. <em>הזזת אינדקס מצטברת:</em> תוספת תחנות בתחילת קו ב׳ יוצרת פער אנכי קבוע (<strong>Δi = ${analysis.maxIndexDiff} תחנות</strong>) שנמשך לאורך כל שאר המסלול גם כשהתחנות זהות!</li>
          </ul>`,
          calcHtml: `<div>פער אינדקס קבוע בקטע המשותף: <span class="big-val">Δi = ${analysis.maxIndexDiff} תחנות</span></div>
            <div class="muted">בשלב הבא נבצע מניפולציה על ציר Y כדי להעביר אותו ליחידות של מטרים ולבטל את ההזזה המצטברת.</div>`,
        },
        {
          stepLabel: 'שלב 2: מניפולציה לציר מרווחים (mₖ, sₖ)',
          coord: 'spacing',
          overlay: 'spacing_bars',
          badge: 'שיטה 1 · שלב 2 מתוך 4 — מניפולציה על הצירים',
          title: 'מניפולציה על ציר Y: מאינדקס תחנה מצטבר i ← למרווח מקומי בין תחנות sₖ במטרים',
          axes: 'מניפולציה: ציר X = מיקום אמצע המקטע mₖ (מטרים) · ציר Y = אורך המקטע sₖ = dₖ − dₖ₋₁ (מטרים)',
          body: `<ul>
            <li><strong>המניפולציה המתמטית:</strong> במקום לספור כמה תחנות עברנו עד כה (אינטגרל מצטבר i), גוזרים את ההפרש בין כל שתי תחנות עוקבות: <strong>sₖ = dₖ − dₖ₋₁ (במטרים)</strong> ומציבים אותו במיקום המקטע <strong>mₖ = (dₖ₋₁ + dₖ)/2 (במטרים)</strong>.</li>
            <li><strong>שימו לב מה קרה בגרף:</strong> שני הצירים כעת ב<strong>מטרים</strong>! וברגע ששני הקווים עוברים לעצור באותן תחנות, שתי העקומות <strong>מתלכדות ב-100%</strong> ללא שום שארית של הזזת אינדקס!</li>
          </ul>`,
          calcHtml: `<div>יחידות חדשות: <span class="big-val">מטרים × מטרים</span></div>
            <div class="muted">בקטע המשותף שתי העקומות יושבות בדיוק על אותו גובה — ההפרש המקומי ביניהן שם הוא 0 מ׳.</div>`,
        },
        {
          stepLabel: 'שלב 3: שידוך מקטעים קרובים במטרים',
          coord: 'spacing',
          overlay: 'spacing_links',
          badge: 'שיטה 1 · שלב 3 מתוך 4 — שידוך האוסדורף דו-ממדי',
          title: 'מציאת המקטע הקרוב ביותר לכל מקטע במישור המטרים (mₖ, sₖ)',
          axes: 'מרחק בין מקטעים במטרים: d_λ = max( λ·|mₖ − m′ⱼ|, |sₖ − s′ⱼ| ) עם λ = ' + lambda.toFixed(2),
          body: `<ul>
            <li><strong>איך עובד השידוך (הקווים האפורים בגרף):</strong> לכל מקטע (mₖ, sₖ) בקו א׳ מחפשים את המקטע (m′ⱼ, s′ⱼ) בקו ב׳ שהמרחק אליו במטרים הוא הקטן ביותר — ולהיפך (מכל מקטע בקו ב׳ לקו א׳).</li>
            <li><strong>תפקיד הפרמטר λ = ${lambda.toFixed(2)}:</strong> מאפשר גמישות במיקום לאורך הקו — אם מקטע דומה מופיע 400 מ׳ קדימה, העלות של ההזזה לאורך המסלול מוכפלת ב-λ ונמדדת אף היא במטרים.</li>
          </ul>`,
          calcHtml: `<div>נבדקו <span class="big-val">${A.nSeg}</span> מקטעים בקו א׳ ו-<span class="big-val">${B.nSeg}</span> מקטעים בקו ב׳</div>
            <div class="muted">כל מקטע זהה מקבל מרחק שידוך של 0 מ׳; רק המקטעים השונים באמת מייצרים חיצי שגיאה.</div>`,
        },
        {
          stepLabel: 'שלב 4: שקלול אורך וחישוב המרחק',
          coord: 'spacing',
          overlay: 'spacing_final',
          badge: 'שיטה 1 · שלב 4 מתוך 4 — חישוב המרחק הסופי',
          title: 'אגרגציה למרחק סופי במטרים: WMHD משוקלל-אורך מול אחוזון H_q ומקסימום',
          axes: 'שקלול לפי חלקו של כל מקטע באורך הקו: wₖ = sₖ / L (רוחב המדרגה בציר X)',
          body: `<ul>
            <li><strong>הקו האדום (H_max = ${Math.round(analysis.spacingMaxVal).toLocaleString()} מ׳):</strong> מרחק האוסדורף הקלאסי — לוקח את המקטע הבודד הגרוע ביותר.</li>
            <li><strong>הקו הכתום (H_${qPct}% = ${Math.round(analysis.spacingQuantVal).toLocaleString()} מ׳):</strong> אחוזון ${qPct}% משוקלל-אורך — מתעלם מ-${100 - qPct}% של חריגי קצה.</li>
            <li><strong>WMHD משוקלל-אורך (${Math.round(analysis.wmhdVal).toLocaleString()} מ׳ — מומלץ):</strong> כופל את שגיאת כל מקטע ברוחבו היחסי במסלול <strong>wₖ = sₖ / L</strong>, כך שכל קילומטר של מסלול מקבל משקל שווה בדיוק!</li>
          </ul>`,
          calcHtml: `<div><strong>WMHD משוקלל-אורך:</strong> <span class="big-val">${Math.round(analysis.wmhdVal).toLocaleString()} מ׳</span></div>
            <div>אחוזון H_${qPct}%: <span class="big-val">${Math.round(analysis.spacingQuantVal).toLocaleString()} מ׳</span> · קלאסי Max: <span class="big-val">${Math.round(analysis.spacingMaxVal).toLocaleString()} מ׳</span></div>`,
        },
      ],
    },
    {
      id: 'hausdorff_1d',
      tag: 'שיטה 2 מתוך 6 · מהירה במיוחד O(n+m)',
      name: '2. האוסדורף חד-ממדי (1D Hausdorff) על מיקומי תחנות במטרים',
      shortVal: `H_1D = ${Math.round(analysis.h1dMaxLink.dist).toLocaleString()} מ׳ | H_${qPct}% = ${Math.round(analysis.h1dQuantLink.dist).toLocaleString()} מ׳`,
      units: 'יחידות: מטרים בלבד על ציר אורך המסלול · סיבוכיות לינארית O(n+m)',
      finalBanner: `מרחק סופי: H_1D (Max) = ${Math.round(analysis.h1dMaxLink.dist).toLocaleString()} מ׳ | אחוזון H_${qPct}% = ${Math.round(analysis.h1dQuantLink.dist).toLocaleString()} מ׳`,
      miniCoord: '1d',
      steps: [
        {
          stepLabel: 'שלב 1: הפרופיל המצטבר (dᵢ, i)',
          coord: 'cum',
          overlay: 'drift',
          badge: 'שיטה 2 · שלב 1 מתוך 4 — נקודת המוצא',
          title: 'מתחילים בגרף הפשוט: הפרופיל המצטבר (מרחק dᵢ מול אינדקס תחנה i)',
          axes: 'ציר X: מרחק מצטבר (מטרים) · ציר Y: אינדקס תחנה סידורי i',
          body: `<ul>
            <li><strong>התובנה של שיטה 2:</strong> בגרף המצטבר, מה שמפריד בין שתי העקומות בהמשך המסלול הוא אך ורק <strong>ציר Y (אינדקס התחנה i)</strong>.</li>
            <li>אם השאלה המעניינת אותנו היא: <em>"האם בכל מיקום שבו קו א׳ עוצר, יש תחנה קרובה של קו ב׳ (ולהיפך)?"</em> — אינדקס התחנה הסידורי כלל אינו נחוץ!</li>
          </ul>`,
          calcHtml: `<div>מספר תחנות: קו א׳ = <span class="big-val">${A.nStops}</span> · קו ב׳ = <span class="big-val">${B.nStops}</span></div>
            <div class="muted">בשלב הבא נבטל לחלוטין את ציר Y ונפיל את כל התחנות אל ציר המרחק במטרים.</div>`,
        },
        {
          stepLabel: 'שלב 2: קריסת ציר Y ל-1D במטרים',
          coord: '1d',
          overlay: '1d_points_only',
          badge: 'שיטה 2 · שלב 2 מתוך 4 — מניפולציה על הצירים',
          title: 'מניפולציה על הצירים: מחיקת ציר אינדקס התחנה והטלת הנקודות לציר מרחק 1D במטרים',
          axes: 'מניפולציה: השמטת הקואורדינטה i ← קבוצות נקודות חד-ממדיות A = {dᵢ} ו-B = {d′ⱼ} במטרים',
          body: `<ul>
            <li><strong>מה קרה באנימציה:</strong> כל התחנות נפלו מהעקומה הדו-ממדית אל שני פסים מקבילים המייצגים את אותו ציר מרחק חד-ממדי במטרים.</li>
            <li><strong>תוצאה מיידית:</strong> כל התחנות שהיו מופרדות אנכית בגלל Δi = ${analysis.maxIndexDiff} עומדות כעת <strong>בדיוק באותו מיקום אופקי במטרים</strong> זו מול זו!</li>
          </ul>`,
          calcHtml: `<div>יחידות הציר היחיד: <span class="big-val">מטרים בלבד</span></div>
            <div class="muted">כעת כל קו הוא פשוט קבוצה ממוינת של מיקומי תחנות במטרים מראשית המסלול.</div>`,
        },
        {
          stepLabel: 'שלב 3: שידוך לתחנה הקרובה ביותר',
          coord: '1d',
          overlay: '1d_all_links',
          badge: 'שיטה 2 · שלב 3 מתוך 4 — שידוך שכן קרוב ב-1D',
          title: 'מציאת התחנה הקרובה ביותר לכל תחנה בשני הכיוונים בזמן O(n+m)',
          axes: 'לכל תחנה dᵢ בקו א׳ מחשבים min_j |dᵢ − d′ⱼ|, ולכל תחנה d′ⱼ בקו ב׳ מחשבים min_i |d′ⱼ − dᵢ|',
          body: `<ul>
            <li><strong>קווי השידוך בגרף:</strong> כל קו מחבר תחנה בקו אחד לתחנה הקרובה ביותר אליה בקו השני.</li>
            <li><strong>קווים אנכיים ירוקים:</strong> תחנות שנמצאות באותו מרחק בדיוק — מרחק ההתאמה שלהן הוא <strong>0 מטרים</strong>!</li>
            <li><strong>קווים אלכסוניים:</strong> מופיעים רק באזורים שבהם לקו אחד יש תחנת ביניים שאין לקו השני. מאחר שהתחנות ממוינות, סריקת שני מצביעים מוצאת את כל השידוכים בזמן לינארי <strong>O(n+m)</strong>.</li>
          </ul>`,
          calcHtml: `<div>סה״כ בדיקות שכן קרוב: <span class="big-val">${A.nStops + B.nStops} תחנות</span></div>
            <div class="muted">מהיר פי ~50 מ-DTW כי אין צורך במטריצת תכנון דינמי דו-ממדית.</div>`,
        },
        {
          stepLabel: 'שלב 4: בחירת הפער המקסימלי (H_1D)',
          coord: '1d',
          overlay: '1d_final',
          badge: 'שיטה 2 · שלב 4 מתוך 4 — חישוב המרחק הסופי',
          title: 'גזירת מרחק האוסדורף החד-ממדי הסופי במטרים (Max מול אחוזון H_q)',
          axes: 'H_1D(A, B) = max( max_a min_b |a − b|, max_b min_a |b − a| ) במטרים',
          body: `<ul>
            <li><strong>הקו האדום העבה (H_1D = ${Math.round(analysis.h1dMaxLink.dist).toLocaleString()} מ׳):</strong> התחנה הבודדת שהתחנה הקרובה ביותר אליה בקו השני היא הרחוקה ביותר במטרים.</li>
            <li><strong>אחוזון ${qPct}% (H_${qPct}% = ${Math.round(analysis.h1dQuantLink.dist).toLocaleString()} מ׳):</strong> לוקח את האלמנט באחוזון ה-${qPct}% של מרחקי ההתאמה כדי להתעלם מתחנת קצה בודדת חריגה.</li>
            <li><strong>מתי להשתמש בשיטה 2:</strong> כשרוצים מדד מהיר במיוחד (O(n+m)) ביחידות מטרים שבודק חפיפת מיקומי עצירה.</li>
          </ul>`,
          calcHtml: `<div><strong>מרחק האוסדורף 1D (Max):</strong> <span class="big-val">${Math.round(analysis.h1dMaxLink.dist).toLocaleString()} מ׳</span></div>
            <div>האוסדורף 1D אחוזון ${qPct}%: <span class="big-val">${Math.round(analysis.h1dQuantLink.dist).toLocaleString()} מ׳</span></div>`,
        },
      ],
    },
    {
      id: 'sawtooth',
      tag: 'שיטה 3 מתוך 6 · פרופיל נגישות רציף',
      name: '3. פרופיל שיני מסור R(x) — מרחק לתחנה הקרובה במטרים',
      shortVal: `L∞ = ${Math.round(analysis.sawMaxDiff).toLocaleString()} מ׳ | L₁ = ${Math.round(analysis.sawL1).toLocaleString()} מ׳`,
      units: 'יחידות אחידות: מטרים × מטרים · שקול מתמטית ל-H_1D במדד המקסימום',
      finalBanner: `מרחק סופי: מקסימום L∞ = ${Math.round(analysis.sawMaxDiff).toLocaleString()} מ׳ (= H_1D) | ממוצע L₁ = ${Math.round(analysis.sawL1).toLocaleString()} מ׳`,
      miniCoord: 'sawtooth',
      steps: [
        {
          stepLabel: 'שלב 1: הפרופיל המצטבר (dᵢ, i)',
          coord: 'cum',
          overlay: 'drift',
          badge: 'שיטה 3 · שלב 1 מתוך 4 — נקודת המוצא',
          title: 'מתחילים בגרף הפשוט: הפרופיל המצטבר (מרחק dᵢ מול אינדקס תחנה i)',
          axes: 'ציר X: מרחק מצטבר (מטרים) · ציר Y: אינדקס תחנה סידורי i',
          body: `<ul>
            <li><strong>הרעיון של שיטה 3:</strong> במקום למדוד כמה תחנות עברנו (אינדקס i), נשאל שאלה פיזיקלית במטרים בכל נקודה x לאורך המסלול: <em>"אם נוסע עומד בנקודה x לאורך הקו, כמה מטרים עליו ללכת עד לתחנה הקרובה ביותר?"</em></li>
          </ul>`,
          calcHtml: `<div>אורך מסלול מקסימלי להשוואה: <span class="big-val">${Math.round(Math.max(A.totalLen, B.totalLen)).toLocaleString()} מ׳</span></div>
            <div class="muted">בשלב הבא נטיל תחילה את התחנות לציר המרחק x במטרים.</div>`,
        },
        {
          stepLabel: 'שלב 2: הטלת התחנות לציר x (R=0)',
          coord: 'sawtooth',
          overlay: 'saw_zeros',
          badge: 'שיטה 3 · שלב 2 מתוך 4 — מניפולציה 1 על הצירים',
          title: 'מניפולציה 1: הורדת כל התחנות אל ציר המרחק בגובה R(dᵢ) = 0 מטרים',
          axes: 'מניפולציה: בכל מיקום של תחנה x = dᵢ, המרחק לתחנה הקרובה ביותר הוא 0 מטרים!',
          body: `<ul>
            <li><strong>מה רואים באנימציה:</strong> אינדקס התחנה i נמחק, וכל תחנה dᵢ יורדת לגובה y = 0 מ׳ על ציר המרחק האופקי.</li>
            <li>הנקודות על ציר X הן בדיוק נקודות האפס שבהן מרחק ההליכה לתחנה מתאפס.</li>
          </ul>`,
          calcHtml: `<div>בכל תחנה x = dᵢ: <span class="big-val">R(dᵢ) = 0 מ׳</span></div>
            <div class="muted">בשלב הבא נצמיח מתוך נקודות האפס הללו את משולשי המרחק לתחנה הקרובה בין התחנות.</div>`,
        },
        {
          stepLabel: 'שלב 3: הצמחת משולשי שיני המסור R(x)',
          coord: 'sawtooth',
          overlay: 'saw_curves',
          badge: 'שיטה 3 · שלב 3 מתוך 4 — מניפולציה 2 על הצירים',
          title: 'מניפולציה 2: בניית פונקציית שיני המסור R(x) = min_i |x − dᵢ| במטרים',
          axes: 'ציר X: מיקום לאורך הקו x (מטרים) · ציר Y: מרחק לתחנה הקרובה R(x) (מטרים)',
          body: `<ul>
            <li><strong>איך צומח הגרף:</strong> כשמתרחקים מתחנה dₖ₋₁ לעבר התחנה הבאה dₖ, המרחק לתחנה הקרובה עולה בשיפוע של 1 עד אמצע המקטע mₖ, שם הוא מגיע לשיא של <strong>sₖ / 2 מטרים</strong>, ואז יורד חזרה ל-0 בתחנה dₖ.</li>
            <li><strong>אחידות יחידות מלאה:</strong> גם ציר X וגם ציר Y נמדדים במטרים, וכל החלקים הזהים של שני הקווים מתלכדים לחלוטין!</li>
          </ul>`,
          calcHtml: `<div>שיא משולש במקטע באורך sₖ: <span class="big-val">R_max = sₖ / 2 מ׳</span></div>
            <div class="muted">מקטע צפוף יוצר שיניים נמוכות; מקטע מהיר ארוך יוצר משולש גבוה.</div>`,
        },
        {
          stepLabel: 'שלב 4: הפרש הפונקציות = מרחק האוסדורף',
          coord: 'sawtooth',
          overlay: 'saw_final',
          badge: 'שיטה 3 · שלב 4 מתוך 4 — חישוב המרחק הסופי',
          title: 'חישוב המרחק בין שתי הפונקציות במטרים: שיא ההפרש (L∞ = H_1D) והשטח הממוצע (L₁)',
          axes: 'משפט מתמטי: sup_x |R_A(x) − R_B(x)| = H_1D(A, B) במטרים בדיוק!',
          body: `<ul>
            <li><strong>הקו האדום האנכי (L∞ = ${Math.round(analysis.sawMaxDiff).toLocaleString()} מ׳):</strong> הפער האנכי הגדול ביותר בין שתי פונקציות שיני המסור — <strong>שווה מתמטית בדיוק למרחק האוסדורף החד-ממדי H_1D!</strong></li>
            <li><strong>השטח הצבוע ביניהן (L₁ = ${Math.round(analysis.sawL1).toLocaleString()} מ׳):</strong> הממוצע האינטגרלי של |R_A(x) − R_B(x)| לאורך המסלול כולו — מדד יציב במטרים שאינו רגיש לחריג בודד.</li>
          </ul>`,
          calcHtml: `<div><strong>מקסימום הפרש L∞ (= H_1D):</strong> <span class="big-val">${Math.round(analysis.sawMaxDiff).toLocaleString()} מ׳</span></div>
            <div>הפרש נגישות ממוצע לאורך הקו (L₁): <span class="big-val">${Math.round(analysis.sawL1).toLocaleString()} מ׳</span></div>`,
        },
      ],
    },
    {
      id: 'norm2d',
      tag: 'שיטה 4 מתוך 6 · השוואת צורה טהורה',
      name: '4. האוסדורף דו-ממדי מנורמל ב-[0,1]² (עקומת ריכוז תחנות / Lévy)',
      shortVal: `H = ${analysis.norm2dMax.dist.toFixed(3)} | H_${qPct}% = ${analysis.norm2dQuant.dist.toFixed(3)}`,
      units: 'יחידות אחידות חסרות-ממד: [0,1] × [0,1] · משווה את צורת התפלגות התחנות ללא תלות באורך הקו',
      finalBanner: `מרחק סופי ב-[0,1]²: Max = ${analysis.norm2dMax.dist.toFixed(3)} (${(analysis.norm2dMax.dist * 100).toFixed(1)}%) | אחוזון H_${qPct}% = ${analysis.norm2dQuant.dist.toFixed(3)}`,
      miniCoord: 'norm2d',
      steps: [
        {
          stepLabel: 'שלב 1: הפרופיל המצטבר (dᵢ, i)',
          coord: 'cum',
          overlay: 'drift',
          badge: 'שיטה 4 · שלב 1 מתוך 4 — נקודת המוצא',
          title: 'מתחילים בגרף הפשוט: הפרופיל המצטבר (מרחק dᵢ מול אינדקס תחנה i)',
          axes: 'ציר X: מרחק מצטבר (0 עד ' + Math.round( Math.max(A.totalLen, B.totalLen) ).toLocaleString() + ' מ׳) · ציר Y: אינדקס תחנה (0 עד ' + Math.max(A.nStops - 1, B.nStops - 1) + ')',
          body: `<ul>
            <li><strong>המטרה של שיטה 4:</strong> לשמור על העקומה המונוטונית העולה של הפרופיל המצטבר, אך לתקן את חוסר האחידות ביחידות בין ציר המרחק (אלפי מטרים) לציר התחנות (עשרות תחנות).</li>
            <li>בנוסף, לעיתים נרצה לשאול: <em>"האם שני קווים באורכים שונים מתאפיינים באותה צורת פיזור תחנות יחסית (למשל איסוף צפוף ב-20% הראשונים ואז נסיעה מהירה)?"</em></li>
          </ul>`,
          calcHtml: `<div>קו א׳: <span class="big-val">${Math.round(A.totalLen).toLocaleString()} מ׳, ${A.nStops} תחנות</span> · קו ב׳: <span class="big-val">${Math.round(B.totalLen).toLocaleString()} מ׳, ${B.nStops} תחנות</span></div>`,
        },
        {
          stepLabel: 'שלב 2: נרמול שני הצירים ל-[0,1]²',
          coord: 'norm2d',
          overlay: 'norm_only',
          badge: 'שיטה 4 · שלב 2 מתוך 4 — מניפולציה על הצירים',
          title: 'מניפולציה על שני הצירים: חלוקת ציר X באורך הקו L וחלוקת ציר Y ב-(n−1)',
          axes: 'מניפולציה: x̃ᵢ = dᵢ / L ∈ [0, 1] (אחוז מרחק) · ỹᵢ = i / (n − 1) ∈ [0, 1] (אחוז תחנות)',
          body: `<ul>
            <li><strong>מה קרה באנימציה:</strong> כל עקומה נמתחה/התכווצה בנפרד כך ששתיהן מתחילות ב-<strong>(0%, 0%)</strong> ומסתיימות ב-<strong>(100%, 100%)</strong> בתוך ריבוע היחידה [0,1]².</li>
            <li><strong>אחידות יחידות מלאה:</strong> שני הצירים הם כעת שברים חסרי-ממד ב-[0,1] (בדומה לעקומת לורנץ / פונקציית התפלגות מצטברת CDF).</li>
          </ul>`,
          calcHtml: `<div>טווח שני הצירים כעת: <span class="big-val">[0, 1] × [0, 1]</span></div>
            <div class="muted">קו עירוני אחיד יישב על האלכסון הראשי; קו מאסף-מהיר ייראה כמדרגה חדה.</div>`,
        },
        {
          stepLabel: 'שלב 3: שידוך שכן קרוב ב-[0,1]²',
          coord: 'norm2d',
          overlay: 'norm_links',
          badge: 'שיטה 4 · שלב 3 מתוך 4 — שידוך אוקלידי בריבוע היחידה',
          title: 'חישוב מרחק אוקלידי דו-ממדי לכל נקודה מול הנקודה הקרובה ביותר בעקומה השנייה',
          axes: 'מרחק אוקלידי ב-[0,1]²: dist((x̃ᵢ, ỹᵢ), (x̃′ⱼ, ỹ′ⱼ)) = √( (x̃ᵢ − x̃′ⱼ)² + (ỹᵢ − ỹ′ⱼ)² )',
          body: `<ul>
            <li>מאחר ששני הצירים נמדדים באותן יחידות (אחוזים מ-0 עד 1), המרחק האוקלידי האלכסוני בין הנקודות (הקווים האפורים בגרף) הוא חוקי ובעל משמעות גיאומטרית מדויקת!</li>
            <li>שימו לב שהשידוך מבוצע גם אופקית (הבדל באחוז המרחק) וגם אנכית (הבדל באחוז התחנות), בדומה למרחק <strong>Lévy–Prokhorov</strong> בסטטיסטיקה.</li>
          </ul>`,
          calcHtml: `<div>שידוכים דו-כיווניים בריבוע היחידה: <span class="big-val">${analysis.normLinks.length} וקטורים</span></div>`,
        },
        {
          stepLabel: 'שלב 4: מרחק האוסדורף המנורמל הסופי',
          coord: 'norm2d',
          overlay: 'norm_final',
          badge: 'שיטה 4 · שלב 4 מתוך 4 — חישוב המרחק הסופי',
          title: 'מציאת וקטור השגיאה המקסימלי (ומעגל הרדיוס H) בריבוע היחידה [0,1]²',
          axes: 'H_[0,1]² = max( max_a min_b ||a − b||₂, max_b min_a ||b − a||₂ )',
          body: `<ul>
            <li><strong>החץ האדום ומעגל הרדיוס (H = ${analysis.norm2dMax.dist.toFixed(3)}):</strong> מראים את הנקודה שבה שתי עקומות הריכוז רחוקות ביותר זו מזו ב-[0,1]².</li>
            <li><strong>יתרון:</strong> מזהה קווים בעלי אותה "טופולוגיית עצירות" גם אם אורכם הכולל שונה (נסו לבחור למעלה את <em>תרחיש 4 — הבדל קנה-מידה</em> ותראו שהמרחק מתאפס!).</li>
            <li><strong>מגבלה:</strong> ריכוז תחנות בקצה אחד של הקו משנה את המכנה (n−1) ולכן עדיין מטה את העקומה כולה.</li>
          </ul>`,
          calcHtml: `<div><strong>האוסדורף מנורמל [0,1]² (Max):</strong> <span class="big-val">${analysis.norm2dMax.dist.toFixed(3)} (${(analysis.norm2dMax.dist * 100).toFixed(1)}%)</span></div>
            <div>האוסדורף מנורמל אחוזון ${qPct}%: <span class="big-val">${analysis.norm2dQuant.dist.toFixed(3)} (${(analysis.norm2dQuant.dist * 100).toFixed(1)}%)</span></div>`,
        },
      ],
    },
    {
      id: 'frechet',
      tag: 'שיטה 5 מתוך 6 · האוסדורף שומר-סדר',
      name: '5. מרחק Fréchet בדיד (Discrete Fréchet — מינימקס סדרתי)',
      shortVal: `Fréchet (מקטעים) = ${Math.round(analysis.frechetSegVal).toLocaleString()} מ׳ | (מצטבר) = ${Math.round(analysis.frechetVal).toLocaleString()} מ׳`,
      units: 'יחידות: מטרים · שידוך מונוטוני לפי סדר האינדקסים תוך לקיחת המקסימום (L∞) במקום סכום',
      finalBanner: `מרחק סופי: Fréchet על מקטעים = ${Math.round(analysis.frechetSegVal).toLocaleString()} מ׳ | Fréchet על מרחק מצטבר = ${Math.round(analysis.frechetVal).toLocaleString()} מ׳`,
      miniCoord: 'cum',
      steps: [
        {
          stepLabel: 'שלב 1: הפרופיל המצטבר (dᵢ, i)',
          coord: 'cum',
          overlay: 'drift',
          badge: 'שיטה 5 · שלב 1 מתוך 4 — נקודת המוצא',
          title: 'מתחילים בגרף הפשוט: הפרופיל המצטבר (מרחק dᵢ מול אינדקס תחנה i)',
          axes: 'ציר X: מרחק מצטבר (מטרים) · ציר Y: אינדקס תחנה סידורי i',
          body: `<ul>
            <li><strong>הרעיון של מרחק Fréchet:</strong> מה אם נרצה למדוד מרחק בסגנון האוסדורף (כלומר הקו הגרוע ביותר — <strong>מקסימום</strong> במקום סכום), אך נדרוש שהשידוך בין התחנות ישמור בקפדנות על סדר הנסיעה מהתחלה לסוף?</li>
            <li>זוהי בעיית <strong>"האדם והכלב"</strong>: אדם הולך על עקומה א׳ וכלבו על עקומה ב׳ (מותר להם להאט או לחכות, אך אסור ללכת אחורה). מהו אורך הרצועה הקצר ביותר שמאפשר לשניהם להגיע מראשית הקו לסופו?</li>
          </ul>`,
          calcHtml: `<div>אורכי הסדרות לשידוך: <span class="big-val">n = ${A.nStops}, m = ${B.nStops}</span></div>`,
        },
        {
          stepLabel: 'שלב 2: מעבר לווקטור מרווחים לפי אינדקס',
          coord: 'seq_seg',
          overlay: 'seq_only',
          badge: 'שיטה 5 · שלב 2 מתוך 4 — מניפולציה על הצירים',
          title: 'הצגת אורך כל מקטע sₖ (במטרים) כפונקציה של אינדקס המקטע k',
          axes: 'מניפולציה: ציר X = אינדקס המקטע k · ציר Y = אורך המקטע sₖ = dₖ − dₖ₋₁ (מטרים)',
          body: `<ul>
            <li>כאשר משווים את וקטורי המקטעים ` + '`seg`' + `, ציר X הוא אינדקס המקטע הסידורי וציר Y הוא אורך המקטע במטרים.</li>
            <li>שימו לב כיצד תוספת התחנות בתחילת קו ב׳ גורמת לכך שהעלייה של קו ב׳ ל-1,000 מ׳ <strong>מוזזת ימינה בציר האינדקס</strong>! לכן שידוך אינדקס-לאינדקס ישיר (k ↔ k) ייכשל, ויש צורך במתיחה גמישה של ציר האינדקס.</li>
          </ul>`,
          calcHtml: `<div>מרווח מקסימלי: קו א׳ = <span class="big-val">${Math.round(Math.max(...A.seg)).toLocaleString()} מ׳</span> · קו ב׳ = <span class="big-val">${Math.round(Math.max(...B.seg)).toLocaleString()} מ׳</span></div>`,
        },
        {
          stepLabel: 'שלב 3: בניית נתיב השידוך המונוטוני',
          coord: 'cum',
          overlay: 'frechet_path',
          badge: 'שיטה 5 · שלב 3 מתוך 4 — שידוך מונוטוני (תכנון דינמי)',
          title: 'מציאת נתיב השידוך האופטימלי (i ↔ j) באמצעות נוסחת הנסיגה של Fréchet',
          axes: 'F(i, j) = max( |aᵢ − bⱼ|, min( F(i−1, j), F(i, j−1), F(i−1, j−1) ) )',
          body: `<ul>
            <li><strong>הקווים המקווקווים בגרף:</strong> מראים אילו תחנות בקו א׳ שודכו לאילו תחנות בקו ב׳ לאורך הנתיב האופטימלי.</li>
            <li>תחנה אחת בקו א׳ יכולה להתאים למספר תחנות עוקבות בקו ב׳ ("עצירה במקום" של האדם בזמן שהכלב מתקדם), כדי לספוג את הבדל מספר התחנות בתחילת המסלול.</li>
          </ul>`,
          calcHtml: `<div>אורך נתיב השידוך: <span class="big-val">${analysis.frePath.length} צעדים מונוטוניים</span></div>`,
        },
        {
          stepLabel: 'שלב 4: צוואר הבקבוק המקסימלי (L∞)',
          coord: 'cum',
          overlay: 'frechet_final',
          badge: 'שיטה 5 · שלב 4 מתוך 4 — חישוב המרחק הסופי',
          title: 'בחירת הקו הארוך ביותר בנתיב (צוואר הבקבוק) כמרחק Fréchet הסופי במטרים',
          axes: 'במקום לסכום את כל הקווים בנתיב, לוקחים את ה-Max (הקו האדום העבה)',
          body: `<ul>
            <li><strong>הקו האדום העבה:</strong> מציג את הזוג (i, j) בנתיב השידוך שבו הפער במטרים הוא הגדול ביותר.</li>
            <li><strong>למה זה עדיף על DTW?</strong> כי לא סוכמים שגיאות לאורך המסלול! לכן אין צורך בחלוקה מלאכותית ב-(n+m) (` + '`lenNorm`' + `), והתוצאה נשארת תמיד ביחידות פיזיקליות של מטרים.</li>
          </ul>`,
          calcHtml: `<div><strong>Fréchet על מקטעים (seg):</strong> <span class="big-val">${Math.round(analysis.frechetSegVal).toLocaleString()} מ׳</span></div>
            <div>Fréchet על מיקומים מצטברים (cum): <span class="big-val">${Math.round(analysis.frechetVal).toLocaleString()} מ׳</span></div>`,
        },
      ],
    },
    {
      id: 'dtw',
      tag: 'שיטה 6 מתוך 6 · המתודולוגיה המקורית',
      name: '6. DTW (Dynamic Time Warping — סכימת עלויות לאורך נתיב יישור)',
      shortVal: `DTW (מקטעים) = ${Math.round(analysis.dtwSegNorm).toLocaleString()} מ׳ | (מצטבר) = ${Math.round(analysis.dtwNorm).toLocaleString()} מ׳`,
      units: 'יחידות: סכום הפרשים במטרים מחולק ב-(n+m) · רגיש לדילוג תחנות ולהבדל במספר התחנות',
      finalBanner: `מרחק סופי (מנורמל ב-n+m): DTW מקטעים = ${Math.round(analysis.dtwSegNorm).toLocaleString()} מ׳ | DTW מצטבר = ${Math.round(analysis.dtwNorm).toLocaleString()} מ׳`,
      miniCoord: 'seq_seg',
      steps: [
        {
          stepLabel: 'שלב 1: הפרופיל המצטבר (dᵢ, i)',
          coord: 'cum',
          overlay: 'drift',
          badge: 'שיטה 6 · שלב 1 מתוך 4 — נקודת המוצא',
          title: 'מתחילים בגרף הפשוט: הפרופיל המצטבר (מרחק dᵢ מול אינדקס תחנה i)',
          axes: 'ציר X: מרחק מצטבר (מטרים) · ציר Y: אינדקס תחנה סידורי i',
          body: `<ul>
            <li><strong>איך DTW מסתכל על הקו:</strong> DTW מתייחס לאינדקס התחנה i כאל "ציר זמן" חד-ממדי, ואל המרחק dᵢ (או אורך המקטע sₖ) כאל ערך האות בזמן i.</li>
            <li>כפי שרואים בגרף, תוספת של ${Math.abs(B.nStops - A.nStops)} תחנות בתחילת קו ב׳ משנה את אורכי הווקטורים (n = ${A.nStops} מול m = ${B.nStops}).</li>
          </ul>`,
          calcHtml: `<div>אורך סדרה א׳: <span class="big-val">${A.nSeg} מקטעים</span> · אורך סדרה ב׳: <span class="big-val">${B.nSeg} מקטעים</span></div>`,
        },
        {
          stepLabel: 'שלב 2: וקטור המקטעים מול אינדקס התחנה',
          coord: 'seq_seg',
          overlay: 'seq_only',
          badge: 'שיטה 6 · שלב 2 מתוך 4 — מניפולציה על הצירים',
          title: 'הצגת וקטור המקטעים sₖ מול אינדקס התחנה k (הקלט הישיר לפונקציית DTW)',
          axes: 'ציר X: אינדקס המקטע k · ציר Y: אורך המקטע sₖ (מטרים)',
          body: `<ul>
            <li>כאשר קו א׳ מדלג על תחנות (למשל מקטע אחד של 750 מ׳ במקום 3 מקטעים של 250 מ׳), בייצוג לפי אינדקס מתקבל ערך גבוה (750) מול שלושה ערכים נמוכים ([250, 250, 250]).</li>
            <li><strong>הכשל הפיזיקלי של DTW על מקטעים:</strong> DTW לא יודע ש-250+250+250 = 750! במקום לחבר את שלושת המקטעים הקצרים, הוא משכפל את האיבר 750 שלוש פעמים ומשלם שגיאה של |750 − 250| = 500 מ׳ בכל אחת משלוש ההתאמות!</li>
          </ul>`,
          calcHtml: `<div>הפרש סכום אורכים פיזיקלי: <span class="big-val">${Math.round(Math.abs(A.totalLen - B.totalLen)).toLocaleString()} מ׳</span> (אך ב-DTW כל פיצול תחנה עולה ביוקר!)</div>`,
        },
        {
          stepLabel: 'שלב 3: שידוך חד-לרבים בנתיב ה-Warping',
          coord: 'cum',
          overlay: 'dtw_path',
          badge: 'שיטה 6 · שלב 3 מתוך 4 — נתיב היישור של DTW',
          title: 'מתיחת אינדקסים (Warping Path) שבה איבר אחד משודך למספר איברים',
          axes: 'DTW(i, j) = |aᵢ − bⱼ| + min( DTW(i−1, j), DTW(i, j−1), DTW(i−1, j−1) )',
          body: `<ul>
            <li><strong>הקווים המקווקווים בגרף:</strong> מציגים את כל זוגות השידוך (i, j) לאורך נתיב ה-DTW.</li>
            <li>שימו לב ל"מניפה" בתחילת הקו: כדי להתאים ${B.nStops} תחנות ל-${A.nStops} תחנות, תחנות בקו א׳ משודכות למספר תחנות בקו ב׳, ו<strong>כל קו במניפה מתווסף לסכום הכולל</strong>!</li>
          </ul>`,
          calcHtml: `<div>מספר קווי שידוך שנסכמים בנתיב: <span class="big-val">${analysis.dtwPath.length} קווים</span></div>`,
        },
        {
          stepLabel: 'שלב 4: סכימת כל הקווים וחלוקה ב-(n+m)',
          coord: 'cum',
          overlay: 'dtw_final',
          badge: 'שיטה 6 · שלב 4 מתוך 4 — חישוב המרחק הסופי',
          title: 'סכימת אורכי כל קווי השידוך בנתיב וחלוקה ב-(n + m)',
          axes: 'DTW_norm(A, B) = ( Σ_{(i,j) ∈ Path} |aᵢ − bⱼ| ) / (n + m)',
          body: `<ul>
            <li><strong>חישוב הסכום:</strong> DTW מחבר את אורכי כל ${analysis.dtwPath.length} קווי השידוך ומחלק ב-(n+m) (` + '`lenNorm`' + `).</li>
            <li><strong>סיכום ההשוואה מול האוסדורף פרופיל מרווחים (שיטה 1):</strong> ב-DTW דילוג על תחנת ביניים מנפח את הסכום המצטבר, בעוד שבשיטה 1 (WMHD על (mₖ, sₖ) במטרים) ההבדל נשאר מקומי לחלוטין ובודק את פרופיל המרווחים האמיתי במטרים.</li>
          </ul>`,
          calcHtml: `<div><strong>DTW מנורמל על מקטעים (seg):</strong> <span class="big-val">${Math.round(analysis.dtwSegNorm).toLocaleString()} מ׳</span></div>
            <div>DTW מנורמל על מיקומים (cum): <span class="big-val">${Math.round(analysis.dtwNorm).toLocaleString()} מ׳</span></div>`,
        },
      ],
    },
  ];
}

function drawMethMainCanvas(pair, analysis, stepDef, prevCoord, morph, lambda) {
  const cv = $('methMainCanvas');
  if (!cv) return;
  const g = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  g.clearRect(0, 0, W, H);

  const { A, B } = pair;
  A.isB = false;
  B.isB = true;
  const L = 74, R = 24, T = 26, Btm = 50;
  const plotW = W - L - R;
  const plotH = H - T - Btm;
  const X = (nx) => L + Math.max(0, Math.min(1, nx)) * plotW;
  const Y = (ny) => H - Btm - Math.max(0, Math.min(1, ny)) * plotH;

  const maxX = Math.max(A.totalLen, B.totalLen, 1);
  const maxStops = Math.max(A.nStops - 1, B.nStops - 1, 1);
  const maxSpacing = Math.max(...A.seg, ...B.seg, 1) * 1.18;
  const maxSaw = maxSpacing * 0.5;
  const coord = stepDef.coord;
  const ov = stepDef.overlay;

  // Draw grid and axes for current target coordinate system
  g.font = '11px "Segoe UI", sans-serif';
  g.strokeStyle = '#e5e8ee';
  g.lineWidth = 1;

  if (coord === '1d') {
    const yA = Y(0.66), yB = Y(0.34);
    for (let t = 0; t <= 4; t++) {
      const xVal = (maxX * t) / 4;
      const px = X(t / 4);
      g.beginPath();
      g.moveTo(px, T + 20);
      g.lineTo(px, H - Btm);
      g.stroke();
      g.fillStyle = '#6b7280';
      g.textAlign = 'center';
      g.fillText(`${Math.round(xVal).toLocaleString()} מ׳`, px, H - Btm + 16);
    }
    g.strokeStyle = '#94a3b8';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(L, yA); g.lineTo(W - R, yA);
    g.moveTo(L, yB); g.lineTo(W - R, yB);
    g.stroke();
    g.fillStyle = '#1f6feb';
    g.textAlign = 'right';
    g.fillText('קו א׳ (מ׳)', L - 10, yA + 4);
    g.fillStyle = '#e11d48';
    g.fillText('קו ב׳ (מ׳)', L - 10, yB + 4);
  } else {
    const xMaxLabel = coord === 'norm2d' ? 1 : coord === 'seq_seg' ? Math.max(1, maxStops - 1) : maxX;
    const yMaxLabel = coord === 'cum' ? maxStops : coord === 'norm2d' ? 1 : coord === 'sawtooth' ? maxSaw : maxSpacing;
    const fmtX = (v) => (coord === 'norm2d' ? `${Math.round(v * 100)}%` : `${Math.round(v).toLocaleString()}`);
    const fmtY = (v) => (coord === 'norm2d' ? `${Math.round(v * 100)}%` : `${Math.round(v).toLocaleString()}`);
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    for (let t = 0; t <= 4; t++) {
      const ny = t / 4;
      g.strokeStyle = '#e5e8ee';
      g.beginPath();
      g.moveTo(L, Y(ny));
      g.lineTo(W - R, Y(ny));
      g.stroke();
      g.fillStyle = '#6b7280';
      g.fillText(fmtY(yMaxLabel * ny), L - 8, Y(ny));
    }
    g.textAlign = 'center';
    g.textBaseline = 'top';
    for (let t = 0; t <= 4; t++) {
      const nx = t / 4;
      g.strokeStyle = '#e5e8ee';
      g.beginPath();
      g.moveTo(X(nx), T);
      g.lineTo(X(nx), H - Btm);
      g.stroke();
      g.fillStyle = '#6b7280';
      g.fillText(fmtX(xMaxLabel * nx), X(nx), H - Btm + 8);
    }
  }

  // Axis titles by coordinate mode
  const axisTitles = {
    cum: ['מרחק מצטבר מראשית הקו dᵢ (מטרים)', 'אינדקס תחנה סידורי i (חסר יחידות אורך)'],
    spacing: ['מיקום המקטע לאורך המסלול mₖ (מטרים)', 'מרווח בין תחנות sₖ = dₖ − dₖ₋₁ (מטרים)'],
    '1d': ['ציר מרחק חד-ממדי לאורך המסלול (מטרים בלבד — ציר אינדקס התחנה בוטל)', ''],
    sawtooth: ['מיקום לאורך המסלול x (מטרים)', 'מרחק לתחנה הקרובה R(x) (מטרים)'],
    norm2d: ['אחוז מרחק מצטבר dᵢ / L ∈ [0,1]', 'אחוז תחנות מצטבר i / (n−1) ∈ [0,1]'],
    seq_seg: ['אינדקס המקטע הסידורי k (0, 1, 2, …)', 'אורך המקטע sₖ (מטרים)'],
  }[coord] || ['ציר X', 'ציר Y'];

  g.fillStyle = '#1e293b';
  g.font = 'bold 12px "Segoe UI", sans-serif';
  g.textAlign = 'center';
  g.fillText(axisTitles[0], L + plotW / 2, H - 16);
  if (axisTitles[1]) {
    g.save();
    g.translate(16, T + plotH / 2);
    g.rotate(-Math.PI / 2);
    g.fillText(axisTitles[1], 0, 0);
    g.restore();
  }

  const ease = morph < 1 ? 0.5 - 0.5 * Math.cos(Math.PI * morph) : 1;
  const ptsA0 = getPointsForCoordMode(A, prevCoord, maxX, maxStops, maxSpacing);
  const ptsA1 = getPointsForCoordMode(A, coord, maxX, maxStops, maxSpacing);
  const ptsB0 = getPointsForCoordMode(B, prevCoord, maxX, maxStops, maxSpacing);
  const ptsB1 = getPointsForCoordMode(B, coord, maxX, maxStops, maxSpacing);
  const lerpPts = (p0, p1) => p1.map(([x1, y1], i) => {
    const [x0, y0] = p0[i] || [x1, y1];
    return [x0 + (x1 - x0) * ease, y0 + (y1 - y0) * ease];
  });
  const curA = lerpPts(ptsA0, ptsA1);
  const curB = lerpPts(ptsB0, ptsB1);

  const overlayAlpha = Math.max(0, (ease - 0.65) / 0.35);
  if (overlayAlpha > 0) {
    g.save();
    g.globalAlpha = overlayAlpha;

    if (ov === 'drift') {
      g.strokeStyle = 'rgba(225, 29, 72, 0.55)';
      g.setLineDash([4, 4]);
      for (const dp of analysis.driftPairs) {
        if (dp.distDiff <= maxX * 0.03 && dp.idxDiff > 0) {
          const x = X(dp.da / maxX);
          g.beginPath();
          g.moveTo(x, Y(dp.i / maxStops));
          g.lineTo(x, Y(dp.j / maxStops));
          g.stroke();
        }
      }
      g.setLineDash([]);
      const maxDiffVal = Math.max(...analysis.driftPairs.map((p) => p.idxDiff), 0);
      const candidates = analysis.driftPairs.filter((p) => p.idxDiff === maxDiffVal && p.distDiff <= maxX * 0.03);
      const worst = candidates[Math.floor(candidates.length / 2)] || analysis.driftPairs[0];
      if (worst && worst.idxDiff > 0) {
        const wx = X(worst.da / maxX);
        const wya = Y(worst.i / maxStops);
        const wyb = Y(worst.j / maxStops);
        g.strokeStyle = '#d97706';
        g.lineWidth = 2.8;
        g.beginPath();
        g.moveTo(wx, wya);
        g.lineTo(wx, wyb);
        g.stroke();
        g.fillStyle = '#92400e';
        g.font = 'bold 12px "Segoe UI", sans-serif';
        const placeRight = wx < L + 210;
        g.textAlign = placeRight ? 'left' : 'right';
        g.fillText(`הזזת אינדקס קבועה: Δi = ${worst.idxDiff} תחנות!`, placeRight ? wx + 10 : wx - 10, (wya + wyb) / 2);
      }
    } else if (ov === 'spacing_bars' || ov === 'spacing_links' || ov === 'spacing_final') {
      const drawStepBars = (P, col) => {
        g.fillStyle = col;
        for (let k = 0; k < P.nSeg; k++) {
          const x0 = X(P.cum[k] / maxX);
          const x1 = X(P.cum[k + 1] / maxX);
          const y = Y(P.seg[k] / maxSpacing);
          g.fillRect(x0, y - 2.5, Math.max(2, x1 - x0), 5);
        }
      };
      drawStepBars(A, 'rgba(31, 111, 235, 0.25)');
      drawStepBars(B, 'rgba(225, 29, 72, 0.25)');

      if (ov === 'spacing_links' || ov === 'spacing_final') {
        for (const lk of [...analysis.spacingAB, ...analysis.spacingBA]) {
          if (lk.dist <= 1) continue;
          g.strokeStyle = 'rgba(100, 116, 139, 0.42)';
          g.lineWidth = 1.2;
          g.beginPath();
          g.moveTo(X(lk.ma / maxX), Y(lk.sa / maxSpacing));
          g.lineTo(X(lk.mb / maxX), Y(lk.sb / maxSpacing));
          g.stroke();
        }
      }
      if (ov === 'spacing_final') {
        const qLk = analysis.spacingQuantLink;
        if (qLk && qLk.dist > 0) {
          g.strokeStyle = '#d97706';
          g.lineWidth = 2.6;
          g.beginPath();
          g.moveTo(X(qLk.ma / maxX), Y(qLk.sa / maxSpacing));
          g.lineTo(X(qLk.mb / maxX), Y(qLk.sb / maxSpacing));
          g.stroke();
        }
        const mLk = analysis.spacingMaxLink;
        if (mLk && mLk.dist > 0) {
          const ax = X(mLk.ma / maxX), ay = Y(mLk.sa / maxSpacing);
          const bx = X(mLk.mb / maxX), by = Y(mLk.sb / maxSpacing);
          g.strokeStyle = '#dc2626';
          g.lineWidth = 3.2;
          g.beginPath();
          g.moveTo(ax, ay);
          g.lineTo(bx, by);
          g.stroke();
          g.fillStyle = '#dc2626';
          g.font = 'bold 11px "Segoe UI", sans-serif';
          g.textAlign = 'center';
          const labelY = Math.min(ay, by) > T + 22 ? Math.min(ay, by) - 10 : Math.max(ay, by) + 16;
          g.fillText(`H_max = ${Math.round(mLk.dist).toLocaleString()} מ׳ | WMHD = ${Math.round(analysis.wmhdVal).toLocaleString()} מ׳`, Math.min(W - R - 130, Math.max(L + 130, (ax + bx) / 2)), labelY);
        }
      }
    } else if (ov === '1d_all_links' || ov === '1d_final') {
      const yA = Y(0.66), yB = Y(0.34);
      for (const lk of analysis.links1D) {
        const xa = X(lk.a / maxX), xb = X(lk.b / maxX);
        g.strokeStyle = lk.dist < 1 ? 'rgba(22, 163, 74, 0.45)' : 'rgba(100, 116, 139, 0.4)';
        g.lineWidth = lk.dist < 1 ? 1.8 : 1.1;
        g.beginPath();
        g.moveTo(xa, yA);
        g.lineTo(xb, yB);
        g.stroke();
      }
      if (ov === '1d_final' && analysis.h1dMaxLink) {
        const mx = analysis.h1dMaxLink;
        const xa = X(mx.a / maxX), xb = X(mx.b / maxX);
        const yMid = (yA + yB) / 2;
        g.strokeStyle = '#dc2626';
        g.lineWidth = 3.2;
        g.beginPath();
        g.moveTo(xa, yA);
        g.lineTo(xb, yB);
        g.stroke();
        g.fillStyle = '#dc2626';
        g.font = 'bold 12px "Segoe UI", sans-serif';
        g.textAlign = 'center';
        g.fillText(`H_1D = ${Math.round(mx.dist).toLocaleString()} מ׳`, (xa + xb) / 2, yMid - 10);
      }
    } else if (ov === 'saw_final') {
      // Shade area between R_A(x) and R_B(x)
      const stepsN = 180;
      g.fillStyle = 'rgba(220, 38, 38, 0.10)';
      g.beginPath();
      for (let s = 0; s <= stepsN; s++) {
        const x = (maxX * s) / stepsN;
        const py = Y(analysis.evalR(A, x) / maxSaw);
        if (s === 0) g.moveTo(X(s / stepsN), py);
        else g.lineTo(X(s / stepsN), py);
      }
      for (let s = stepsN; s >= 0; s--) {
        const x = (maxX * s) / stepsN;
        const py = Y(analysis.evalR(B, x) / maxSaw);
        g.lineTo(X(s / stepsN), py);
      }
      g.closePath();
      g.fill();

      const sx = analysis.sawMaxX;
      const ra = analysis.evalR(A, sx);
      const rb = analysis.evalR(B, sx);
      const px = X(sx / maxX);
      const pya = Y(ra / maxSaw);
      const pyb = Y(rb / maxSaw);
      g.strokeStyle = '#dc2626';
      g.lineWidth = 3.2;
      g.beginPath();
      g.moveTo(px, pya);
      g.lineTo(px, pyb);
      g.stroke();
      g.fillStyle = '#dc2626';
      g.font = 'bold 12px "Segoe UI", sans-serif';
      g.textAlign = 'center';
      g.fillText(`max |R_A(x) − R_B(x)| = ${Math.round(analysis.sawMaxDiff).toLocaleString()} מ׳ (= H_1D)`, Math.min(W - R - 120, Math.max(L + 120, px)), Math.min(pya, pyb) - 12);
    } else if (ov === 'norm_links' || ov === 'norm_final') {
      g.strokeStyle = 'rgba(100, 116, 139, 0.38)';
      g.lineWidth = 1.1;
      for (const lk of analysis.normLinks) {
        g.beginPath();
        g.moveTo(X(lk.ax), Y(lk.ay));
        g.lineTo(X(lk.bx), Y(lk.by));
        g.stroke();
      }
      if (ov === 'norm_final' && analysis.norm2dMax && analysis.norm2dMax.dist > 0) {
        const best = analysis.norm2dMax;
        const ax = X(best.ax), ay = Y(best.ay), bx = X(best.bx), by = Y(best.by);
        const rad = Math.hypot(ax - bx, ay - by);
        g.fillStyle = 'rgba(220, 38, 38, 0.08)';
        g.strokeStyle = 'rgba(220, 38, 38, 0.45)';
        g.lineWidth = 1.5;
        g.beginPath();
        g.arc(best.from === 'A' ? ax : bx, best.from === 'A' ? ay : by, rad, 0, Math.PI * 2);
        g.fill();
        g.stroke();
        g.strokeStyle = '#dc2626';
        g.lineWidth = 3.2;
        g.beginPath();
        g.moveTo(ax, ay);
        g.lineTo(bx, by);
        g.stroke();
        g.fillStyle = '#dc2626';
        g.font = 'bold 11px "Segoe UI", sans-serif';
        g.fillText(`H_[0,1]² = ${best.dist.toFixed(3)}`, (ax + bx) / 2 + 6, (ay + by) / 2 - 8);
      }
    } else if (ov === 'frechet_path' || ov === 'frechet_final' || ov === 'dtw_path' || ov === 'dtw_final') {
      const path = ov.startsWith('dtw') ? analysis.dtwPath : analysis.frePath;
      g.strokeStyle = ov === 'dtw_final' ? 'rgba(217, 119, 6, 0.65)' : 'rgba(100, 116, 139, 0.48)';
      g.lineWidth = ov === 'dtw_final' ? 1.8 : 1.2;
      g.setLineDash([3, 3]);
      for (const lk of path) {
        g.beginPath();
        g.moveTo(X(A.cum[lk.i] / maxX), Y(lk.i / maxStops));
        g.lineTo(X(B.cum[lk.j] / maxX), Y(lk.j / maxStops));
        g.stroke();
      }
      g.setLineDash([]);
      if (ov === 'frechet_final' && analysis.freMaxLink) {
        const mx = analysis.freMaxLink;
        const ax = X(A.cum[mx.i] / maxX), ay = Y(mx.i / maxStops);
        const bx = X(B.cum[mx.j] / maxX), by = Y(mx.j / maxStops);
        g.strokeStyle = '#dc2626';
        g.lineWidth = 3.2;
        g.beginPath();
        g.moveTo(ax, ay);
        g.lineTo(bx, by);
        g.stroke();
        g.fillStyle = '#dc2626';
        g.font = 'bold 11px "Segoe UI", sans-serif';
        g.fillText(`צוואר בקבוק Fréchet = ${Math.round(mx.cost).toLocaleString()} מ׳`, (ax + bx) / 2, Math.min(ay, by) - 10);
      }
    }

    g.restore();
  }

  // Draw curves & points for A and B
  const drawProfileCurve = (P, pts, col) => {
    g.strokeStyle = col;
    g.fillStyle = col;
    g.lineWidth = 2.4;

    if (coord === 'sawtooth' && (ov === 'saw_curves' || ov === 'saw_final') && ease > 0.3) {
      g.beginPath();
      for (let k = 0; k < P.nSeg; k++) {
        const x0 = X(P.cum[k] / maxX);
        const xm = X(P.mid[k] / maxX);
        const x1 = X(P.cum[k + 1] / maxX);
        const y0 = Y(0);
        const ym = Y(((0.5 * P.seg[k]) / maxSaw) * ease);
        if (k === 0) g.moveTo(x0, y0);
        g.lineTo(xm, ym);
        g.lineTo(x1, y0);
      }
      g.stroke();
    } else if (coord !== '1d' && !(coord === 'sawtooth' && ov === 'saw_zeros' && ease > 0.9)) {
      const startIdx = (coord === 'spacing' || coord === 'seq_seg') && ease > 0.8 ? 1 : 0;
      g.beginPath();
      for (let i = startIdx; i < pts.length; i++) {
        const px = X(pts[i][0]), py = Y(pts[i][1]);
        if (i === startIdx) g.moveTo(px, py);
        else g.lineTo(px, py);
      }
      g.stroke();
    }

    const startIdx = (coord === 'spacing' || coord === 'seq_seg') && ease > 0.8 ? 1 : 0;
    for (let i = startIdx; i < pts.length; i++) {
      const px = X(pts[i][0]), py = Y(pts[i][1]);
      g.beginPath();
      g.arc(px, py, 3.6, 0, Math.PI * 2);
      g.fill();
    }
  };

  drawProfileCurve(A, curA, '#1f6feb');
  drawProfileCurve(B, curB, '#e11d48');
}

function drawMiniCardCanvas(cv, pair, analysis, miniCoord, methodId) {
  const g = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  g.clearRect(0, 0, W, H);
  const { A, B } = pair;
  A.isB = false;
  B.isB = true;
  const pad = 10;
  const X = (nx) => pad + Math.max(0, Math.min(1, nx)) * (W - 2 * pad);
  const Y = (ny) => H - pad - Math.max(0, Math.min(1, ny)) * (H - 2 * pad);
  const maxX = Math.max(A.totalLen, B.totalLen, 1);
  const maxStops = Math.max(A.nStops - 1, B.nStops - 1, 1);
  const maxSpacing = Math.max(...A.seg, ...B.seg, 1) * 1.18;
  const maxSaw = maxSpacing * 0.5;

  if (miniCoord === '1d') {
    const yA = Y(0.68), yB = Y(0.32);
    g.strokeStyle = '#cbd5e1';
    g.beginPath(); g.moveTo(pad, yA); g.lineTo(W - pad, yA); g.moveTo(pad, yB); g.lineTo(W - pad, yB); g.stroke();
    for (const lk of analysis.links1D) {
      g.strokeStyle = 'rgba(100,116,139,0.32)';
      g.beginPath(); g.moveTo(X(lk.a / maxX), yA); g.lineTo(X(lk.b / maxX), yB); g.stroke();
    }
    if (analysis.h1dMaxLink) {
      g.strokeStyle = '#dc2626';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(X(analysis.h1dMaxLink.a / maxX), yA);
      g.lineTo(X(analysis.h1dMaxLink.b / maxX), yB);
      g.stroke();
    }
    for (const d of A.cum) { g.fillStyle = '#1f6feb'; g.beginPath(); g.arc(X(d / maxX), yA, 2.5, 0, 7); g.fill(); }
    for (const d of B.cum) { g.fillStyle = '#e11d48'; g.beginPath(); g.arc(X(d / maxX), yB, 2.5, 0, 7); g.fill(); }
    return;
  }

  if (miniCoord === 'sawtooth') {
    const drawSaw = (P, col) => {
      g.strokeStyle = col;
      g.lineWidth = 1.6;
      g.beginPath();
      for (let k = 0; k < P.nSeg; k++) {
        if (k === 0) g.moveTo(X(P.cum[k] / maxX), Y(0));
        g.lineTo(X(P.mid[k] / maxX), Y((0.5 * P.seg[k]) / maxSaw));
        g.lineTo(X(P.cum[k + 1] / maxX), Y(0));
      }
      g.stroke();
    };
    drawSaw(A, '#1f6feb');
    drawSaw(B, '#e11d48');
    return;
  }

  const ptsA = getPointsForCoordMode(A, miniCoord, maxX, maxStops, maxSpacing);
  const ptsB = getPointsForCoordMode(B, miniCoord, maxX, maxStops, maxSpacing);
  if (methodId === 'frechet') {
    g.strokeStyle = 'rgba(100,116,139,0.35)';
    g.lineWidth = 1;
    g.setLineDash([2, 2]);
    for (const lk of analysis.frePath) {
      g.beginPath();
      g.moveTo(X(A.cum[lk.i] / maxX), Y(lk.i / maxStops));
      g.lineTo(X(B.cum[lk.j] / maxX), Y(lk.j / maxStops));
      g.stroke();
    }
    g.setLineDash([]);
    if (analysis.freMaxLink) {
      const mx = analysis.freMaxLink;
      g.strokeStyle = '#dc2626';
      g.lineWidth = 2.2;
      g.beginPath();
      g.moveTo(X(A.cum[mx.i] / maxX), Y(mx.i / maxStops));
      g.lineTo(X(B.cum[mx.j] / maxX), Y(mx.j / maxStops));
      g.stroke();
    }
  } else if (methodId === 'norm2d' && analysis.norm2dMax) {
    const mx = analysis.norm2dMax;
    g.strokeStyle = '#dc2626';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(X(mx.ax), Y(mx.ay));
    g.lineTo(X(mx.bx), Y(mx.by));
    g.stroke();
  }
  const drawPts = (pts, col) => {
    const sIdx = miniCoord === 'spacing' || miniCoord === 'seq_seg' ? 1 : 0;
    g.strokeStyle = col;
    g.lineWidth = 1.8;
    g.beginPath();
    for (let i = sIdx; i < pts.length; i++) {
      if (i === sIdx) g.moveTo(X(pts[i][0]), Y(pts[i][1]));
      else g.lineTo(X(pts[i][0]), Y(pts[i][1]));
    }
    g.stroke();
  };
  drawPts(ptsA, '#1f6feb');
  drawPts(ptsB, '#e11d48');
}

function renderMethodology() {
  if (!$('tab-methodology') || $('tab-methodology').hidden) return;
  const lambda = +($('methLambda')?.value ?? 0.25);
  const qPct = +($('methQuantile')?.value ?? 90);
  const q = qPct / 100;
  $('methLambdaVal').textContent = lambda.toFixed(2);
  $('methQuantileVal').textContent = `${qPct}%`;

  const pair = getActiveMethPair();
  $('methLabelA').textContent = `${pair.A.name} (${pair.A.nStops} תחנות, ${Math.round(pair.A.totalLen).toLocaleString()} מ׳)`;
  $('methLabelB').textContent = `${pair.B.name} (${pair.B.nStops} תחנות, ${Math.round(pair.B.totalLen).toLocaleString()} מ׳)`;

  const analysis = analyzeMethPair(pair.A, pair.B, lambda, q);
  const methods = getMethodsCatalog(pair, analysis, lambda, qPct);
  const activeMethod = methods[M.methodIdx] || methods[0];
  const stepDef = activeMethod.steps[M.step] || activeMethod.steps[0];

  // Render the 6 method cards at top
  $('methSummaryGrid').innerHTML = methods.map((m, idx) => `
    <article class="meth-card ${M.methodIdx === idx ? 'active' : ''}" data-method-idx="${idx}">
      <div class="meth-card-head">
        <strong>${esc(m.name)}</strong>
      </div>
      <div class="meth-card-val">${esc(m.shortVal)}</div>
      <div class="meth-card-units">${esc(m.units)}</div>
      <canvas width="280" height="96"></canvas>
    </article>
  `).join('');

  $('methSummaryGrid').querySelectorAll('.meth-card').forEach((card) => {
    const idx = Number(card.dataset.methodIdx);
    const m = methods[idx];
    drawMiniCardCanvas(card.querySelector('canvas'), pair, analysis, m.miniCoord, m.id);
    card.onclick = () => selectMethMethod(idx);
  });

  // Render active method header & 4-step buttons
  $('methMethodTag').textContent = activeMethod.tag;
  $('methMethodHeaderTitle').textContent = `ב. שלבי הפעולה של ${activeMethod.name}`;
  $('methFinalScorePill').textContent = activeMethod.finalBanner;

  $('methStepper').innerHTML = activeMethod.steps.map((s, idx) => `
    <button type="button" class="meth-step-btn ${M.step === idx ? 'active' : ''}" data-step="${idx}">
      <span class="step-num">${idx + 1}</span>${esc(s.stepLabel)}
    </button>
  `).join('');
  $('methStepper').querySelectorAll('.meth-step-btn').forEach((btn) => {
    btn.onclick = () => transitionToMethStep(Number(btn.dataset.step));
  });

  $('methStepBadge').textContent = stepDef.badge;
  $('methStepTitle').textContent = stepDef.title;
  $('methAxisBadge').textContent = stepDef.axes;
  $('methStepBody').innerHTML = stepDef.body;
  $('methStepMetricBox').innerHTML = stepDef.calcHtml;

  $('methPrevBtn').disabled = M.step === 0;
  $('methNextBtn').disabled = M.step === activeMethod.steps.length - 1;

  drawMethMainCanvas(pair, analysis, stepDef, M.prevCoord, M.morph, lambda);
}

function selectMethMethod(newMethodIdx) {
  if (M.animFrame) cancelAnimationFrame(M.animFrame);
  M.methodIdx = Math.max(0, Math.min(5, newMethodIdx));
  M.step = 0;
  M.prevCoord = 'cum';
  M.morph = 1;
  $('methMorph').value = 100;
  $('methMorphPct').textContent = '100%';
  renderMethodology();
  document.querySelector('.meth-stage-card')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function transitionToMethStep(targetStep, forceReplay = false) {
  const pair = getActiveMethPair();
  const lambda = +($('methLambda')?.value ?? 0.25);
  const qPct = +($('methQuantile')?.value ?? 90);
  const analysis = analyzeMethPair(pair.A, pair.B, lambda, qPct / 100);
  const methods = getMethodsCatalog(pair, analysis, lambda, qPct);
  const activeMethod = methods[M.methodIdx] || methods[0];
  const clamped = Math.max(0, Math.min(activeMethod.steps.length - 1, targetStep));
  if (M.animFrame) cancelAnimationFrame(M.animFrame);
  const fromStepIdx = forceReplay ? Math.max(0, clamped - 1) : M.step;
  M.prevCoord = activeMethod.steps[fromStepIdx]?.coord || 'cum';
  M.step = clamped;

  if (fromStepIdx === M.step && !forceReplay) {
    M.morph = 1;
    $('methMorph').value = 100;
    $('methMorphPct').textContent = '100%';
    renderMethodology();
    return;
  }
  M.morph = 0;
  const start = performance.now();
  const duration = 680;
  const tick = (now) => {
    const t = Math.min(1, (now - start) / duration);
    M.morph = t;
    $('methMorph').value = Math.round(t * 100);
    $('methMorphPct').textContent = `${Math.round(t * 100)}%`;
    renderMethodology();
    if (t < 1) M.animFrame = requestAnimationFrame(tick);
  };
  M.animFrame = requestAnimationFrame(tick);
}

function initMethodologyTab() {
  if (!M.initialized) {
    M.initialized = true;
    $('methPreset').onchange = () => {
      const isGtfs = $('methPreset').value === 'gtfs';
      $('methGtfsPickers').hidden = !isGtfs;
      if (isGtfs) {
        if ($('methSampleA').value && $('methSampleB').value) {
          loadMethGtfsPair($('methSampleA').value, $('methSampleB').value);
        }
        searchMethGtfsOptions();
      } else {
        renderMethodology();
      }
    };
    $('methRouteSearch').oninput = searchMethGtfsOptions;
    $('methLambda').oninput = renderMethodology;
    $('methQuantile').oninput = renderMethodology;
    $('methMorph').oninput = () => {
      if (M.animFrame) cancelAnimationFrame(M.animFrame);
      M.morph = (+$('methMorph').value) / 100;
      $('methMorphPct').textContent = `${Math.round(M.morph * 100)}%`;
      renderMethodology();
    };
    $('methPrevBtn').onclick = () => transitionToMethStep(M.step - 1);
    $('methNextBtn').onclick = () => transitionToMethStep(M.step + 1);
    $('methReplayBtn').onclick = () => transitionToMethStep(M.step, true);
    $('methSampleA').onchange = () => {
      if ($('methSampleA').value && $('methSampleB').value) loadMethGtfsPair($('methSampleA').value, $('methSampleB').value);
    };
    $('methSampleB').onchange = () => {
      if ($('methSampleA').value && $('methSampleB').value) loadMethGtfsPair($('methSampleA').value, $('methSampleB').value);
    };
    $('methUseSelectedCluster').onclick = () => {
      if (S.selected >= 0 && S.result && S.labels) {
        const cl = S.labels[S.selected];
        const medIdx = cl >= 0 ? S.result.medoids[cl] : 0;
        const idA = S.samples[S.selected]?.sample_id;
        const idB = S.samples[medIdx >= 0 ? medIdx : 0]?.sample_id;
        if (idA && idB) {
          $('methPreset').value = 'gtfs';
          $('methGtfsPickers').hidden = false;
          loadMethGtfsPair(idA, idB);
          return;
        }
      }
      if ($('methSampleA').value && $('methSampleB').value) {
        loadMethGtfsPair($('methSampleA').value, $('methSampleB').value);
      }
    };
  }
  renderMethodology();
}
