export const SHARE_CONFIG_VERSION = '1';
export const MAX_SHARE_URL_LENGTH = 2048;

const METRICS = new Set([
  'hausdorff_profile_wmhd',
  'hausdorff_profile_quantile',
  'hausdorff_profile_max',
  'hausdorff_1d',
  'hausdorff_norm2d',
  'frechet',
  'dtw',
]);
const UNITS = new Set(['route', 'pattern']);
const FEATURES = new Set(['seg', 'cum']);
const NORMALIZATIONS = new Set(['none', 'log', 'zscore']);
const COMPUTE_BACKENDS = new Set(['cpu', 'webgpu']);
const ALGORITHMS = new Set(['kmedoids', 'hierarchical', 'dbscan']);
const LINKAGES = new Set(['average', 'complete', 'single']);
const CUT_MODES = new Set(['k', 'h', 'info-k', 'info-tau', 'info-frac']);
const SINGLE_PARAMS = new Set([
  'v', 'unit', 'feature', 'metric', 'lambda', 'quantilePct', 'normalize',
  'minLen', 'windowPct', 'workers', 'backend', 'lenNorm', 'search', 'algo', 'linkage',
  'auto', 'k', 'kMin', 'kMax', 'eps', 'minPts', 'mdsDims', 'cutMode', 'cutH', 'cutTau', 'cutFrac',
]);
const ARRAY_PARAMS = new Set(['agency', 'routeType']);
const ALL_PARAMS = new Set([...SINGLE_PARAMS, ...ARRAY_PARAMS]);

const copyConfig = (config) => ({
  ...config,
  agencyIds: [...(config.agencyIds || [])],
  routeTypes: [...(config.routeTypes || [])],
});

export function parseShareConfig(search, {
  defaults,
  agencyIds = [],
  routeTypes = [],
  maxWorkers = defaults.workers,
}, fullUrlLength = String(search || '').length) {
  const config = copyConfig(defaults);
  const warnings = [];
  const query = String(search || '').replace(/^\?/, '');
  if (!query) return { config, warnings, hasConfig: false };
  if (query.length > MAX_SHARE_URL_LENGTH || fullUrlLength > MAX_SHARE_URL_LENGTH) {
    return {
      config,
      warnings: [`קישור התצורה ארוך מהמותר (${MAX_SHARE_URL_LENGTH} תווים); התצורה לא נטענה.`],
      hasConfig: true,
    };
  }

  const params = new URLSearchParams(query);
  const unknown = [...new Set([...params.keys()].filter((key) => !ALL_PARAMS.has(key)))];
  if (unknown.length) warnings.push(`פרמטרים לא נתמכים התעלמו: ${unknown.slice(0, 5).join(', ')}.`);

  const versions = params.getAll('v');
  if (versions.length > 1 || (versions.length === 1 && versions[0] !== SHARE_CONFIG_VERSION)) {
    warnings.push(`גרסת קישור לא נתמכת; נטענה תצורת ברירת המחדל.`);
    return { config, warnings, hasConfig: true };
  }

  const readOne = (key) => {
    const values = params.getAll(key);
    if (values.length > 1) {
      warnings.push(`הפרמטר ${key} מופיע יותר מפעם אחת; נעשה שימוש בברירת המחדל שלו.`);
      return { present: true, valid: false };
    }
    return values.length ? { present: true, valid: true, value: values[0] } : { present: false, valid: true };
  };
  const setEnum = (key, allowed, property, label = key) => {
    const entry = readOne(key);
    if (!entry.present) return;
    if (!entry.valid || !allowed.has(entry.value)) {
      if (entry.valid) warnings.push(`ערך לא תקין לפרמטר ${label}; נעשה שימוש בברירת המחדל.`);
      return;
    }
    config[property] = entry.value;
  };
  const setNumber = (key, property, min, max, integer = false) => {
    const entry = readOne(key);
    if (!entry.present) return;
    const value = Number(entry.value);
    if (!entry.valid || !entry.value.trim() || !Number.isFinite(value) || value < min || value > max
      || (integer && !Number.isSafeInteger(value))) {
      if (entry.valid) warnings.push(`ערך לא תקין לפרמטר ${key}; נעשה שימוש בברירת המחדל.`);
      return;
    }
    config[property] = value;
  };
  const setBoolean = (key, property) => {
    const entry = readOne(key);
    if (!entry.present) return;
    if (!entry.valid || !['0', '1'].includes(entry.value)) {
      if (entry.valid) warnings.push(`ערך לא תקין לפרמטר ${key}; נעשה שימוש בברירת המחדל.`);
      return;
    }
    config[property] = entry.value === '1';
  };

  setEnum('unit', UNITS, 'unit');
  setEnum('feature', FEATURES, 'feature');
  setEnum('metric', METRICS, 'metric');
  setEnum('normalize', NORMALIZATIONS, 'normalize');
  setNumber('lambda', 'posWeight', 0, 2);
  setNumber('quantilePct', 'quantilePct', 50, 100);
  setNumber('minLen', 'minLen', 0, 1_000_000, true);
  setNumber('windowPct', 'windowPct', 0, 100);
  setNumber('workers', 'workers', 1, maxWorkers, true);
  setEnum('backend', COMPUTE_BACKENDS, 'computeBackend', 'backend');
  setBoolean('lenNorm', 'lenNorm');
  setEnum('algo', ALGORITHMS, 'algo');
  setEnum('linkage', LINKAGES, 'linkage');
  setBoolean('auto', 'auto');
  setNumber('k', 'k', 1, 10_000, true);
  setNumber('kMin', 'kMin', 2, 10_000, true);
  setNumber('kMax', 'kMax', 2, 10_000, true);
  setNumber('minPts', 'minPts', 1, 10_000, true);
  setNumber('mdsDims', 'mdsDims', 2, 10, true);
  setEnum('cutMode', CUT_MODES, 'cutMode');
  setNumber('cutH', 'cutH', 0, 1_000_000);
  setNumber('cutTau', 'cutTau', 0, 1_000_000);
  setNumber('cutFrac', 'cutFrac', 0, 1);

  const eps = readOne('eps');
  if (eps.present) {
    if (eps.valid && eps.value.trim() === '') {
      config.eps = '';
    } else {
      const value = Number(eps.value);
      if (!eps.valid || !Number.isFinite(value) || value < 0 || value > 1_000_000) {
        if (eps.valid) warnings.push('ערך לא תקין לפרמטר eps; נעשה שימוש בברירת המחדל.');
      } else {
        config.eps = value;
      }
    }
  }

  const searchEntry = readOne('search');
  if (searchEntry.present) {
    if (searchEntry.valid && searchEntry.value.length <= 160) {
      config.search = searchEntry.value;
    } else if (searchEntry.valid) {
      warnings.push('החיפוש ארוך מהמותר (160 תווים); נעשה שימוש בחיפוש ריק.');
    }
  }

  const knownAgencies = new Set(agencyIds.map(String));
  const agencyValues = params.getAll('agency');
  if (agencyValues.length) {
    const invalid = agencyValues.filter((value) => !knownAgencies.has(value));
    if (invalid.length) {
      warnings.push('קישור התצורה כולל מזהי סוכנות לא מוכרים; מסנן הסוכנויות הושאר כברירת מחדל.');
    } else {
      config.agencyIds = [...new Set(agencyValues)];
    }
  }

  const knownRouteTypes = new Set(routeTypes.map(String));
  const routeTypeValues = params.getAll('routeType');
  if (routeTypeValues.length) {
    const invalid = routeTypeValues.filter((value) => !knownRouteTypes.has(value));
    if (invalid.length) {
      warnings.push('קישור התצורה כולל סוגי קו לא מוכרים; מסנן סוגי הקו הושאר כברירת מחדל.');
    } else {
      config.routeTypes = [...new Set(routeTypeValues)];
    }
  }

  if (config.kMin > config.kMax) {
    warnings.push('טווח k אינו תקין; נעשה שימוש בטווח ברירת המחדל.');
    config.kMin = defaults.kMin;
    config.kMax = defaults.kMax;
  }

  return { config, warnings, hasConfig: true };
}

export function createShareUrl(baseUrl, config) {
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new TypeError('כתובת הבסיס חייבת להיות כתובת HTTP(S) ללא פרטי התחברות.');
  }
  const validNumber = (value, min, max, integer = false) => Number.isFinite(value)
    && value >= min
    && value <= max
    && (!integer || Number.isSafeInteger(value));
  if (!UNITS.has(config.unit) || !FEATURES.has(config.feature) || !METRICS.has(config.metric)
    || !NORMALIZATIONS.has(config.normalize) || !COMPUTE_BACKENDS.has(config.computeBackend)
    || !ALGORITHMS.has(config.algo) || !LINKAGES.has(config.linkage) || !CUT_MODES.has(config.cutMode)) {
    throw new TypeError('התצורה כוללת בחירה לא נתמכת.');
  }
  if (!validNumber(config.posWeight, 0, 2) || !validNumber(config.quantilePct, 50, 100)
    || !validNumber(config.minLen, 0, 1_000_000, true) || !validNumber(config.windowPct, 0, 100)
    || !validNumber(config.workers, 1, 10_000, true) || !validNumber(config.k, 1, 10_000, true)
    || !validNumber(config.kMin, 2, 10_000, true) || !validNumber(config.kMax, 2, 10_000, true)
    || !validNumber(config.minPts, 1, 10_000, true) || !validNumber(config.mdsDims, 2, 10, true)
    || !validNumber(config.cutH, 0, 1_000_000) || !validNumber(config.cutTau, 0, 1_000_000)
    || !validNumber(config.cutFrac, 0, 1)
    || (config.eps !== '' && config.eps != null && !validNumber(config.eps, 0, 1_000_000))
    || config.kMin > config.kMax) {
    throw new RangeError('התצורה כוללת ערך מספרי לא תקין או מחוץ לטווח.');
  }
  if (typeof config.lenNorm !== 'boolean' || typeof config.auto !== 'boolean'
    || !Array.isArray(config.agencyIds) || !Array.isArray(config.routeTypes)
    || config.agencyIds.some((value) => !String(value))
    || config.routeTypes.some((value) => !String(value))
    || typeof config.search !== 'string' || config.search.length > 160) {
    throw new TypeError('התצורה כוללת ערך בפורמט לא תקין.');
  }

  const params = new URLSearchParams();
  params.set('v', SHARE_CONFIG_VERSION);
  params.set('unit', config.unit);
  params.set('feature', config.feature);
  params.set('metric', config.metric);
  params.set('lambda', String(config.posWeight));
  params.set('quantilePct', String(config.quantilePct));
  params.set('normalize', config.normalize);
  for (const agencyId of config.agencyIds) params.append('agency', String(agencyId));
  for (const routeType of config.routeTypes) params.append('routeType', String(routeType));
  params.set('minLen', String(config.minLen));
  params.set('windowPct', String(config.windowPct));
  params.set('workers', String(config.workers));
  params.set('backend', config.computeBackend);
  params.set('lenNorm', config.lenNorm ? '1' : '0');
  if (config.search) params.set('search', config.search);
  params.set('algo', config.algo);
  params.set('linkage', config.linkage);
  params.set('auto', config.auto ? '1' : '0');
  params.set('k', String(config.k));
  params.set('kMin', String(config.kMin));
  params.set('kMax', String(config.kMax));
  if (config.eps !== '' && config.eps != null) params.set('eps', String(config.eps));
  params.set('minPts', String(config.minPts));
  params.set('mdsDims', String(config.mdsDims));
  params.set('cutMode', config.cutMode);
  params.set('cutH', String(config.cutH));
  params.set('cutTau', String(config.cutTau));
  params.set('cutFrac', String(config.cutFrac));

  url.search = params.toString();
  url.hash = '';
  if (url.href.length > MAX_SHARE_URL_LENGTH) {
    throw new RangeError(`קישור התצורה ארוך מדי (${url.href.length} תווים; המגבלה ${MAX_SHARE_URL_LENGTH}).`);
  }
  return url.href;
}
