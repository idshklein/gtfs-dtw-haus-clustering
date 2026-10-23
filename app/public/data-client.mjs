import * as duckdb from '@duckdb/duckdb-wasm';

const CORE_FILES = ['agency', 'routes', 'stops', 'stop_times', 'trips'];
const REQUIRED_FILES = [...CORE_FILES, 'shapes'];
const CACHE_PREFIX = 'gtfs-dtw-parquet-v1-';

const escapeString = (value) => `'${String(value).replaceAll("'", "''")}'`;
const plainValue = (value) => {
  if (value === null || typeof value !== 'object') return value;
  if (
    Array.isArray(value)
    || ArrayBuffer.isView(value)
    || typeof value[Symbol.iterator] === 'function'
    || typeof value.length === 'number'
  ) {
    return Array.from(value, plainValue);
  }
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, plainValue(nested)]));
};
const intValue = (value, fallback = 0) => {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) ? Math.max(0, number) : fallback;
};

export class BrowserGtfsData {
  constructor({ manifestUrl, onProgress = () => {} }) {
    if (!manifestUrl) throw new TypeError('manifestUrl is required');
    this.manifestUrl = new URL(manifestUrl, globalThis.location.href).toString();
    this.onProgress = onProgress;
    this.db = null;
    this.conn = null;
    this.meta = null;
    this.manifest = null;
    this.mapTablesPromise = null;
    this.cache = null;
  }

  async init() {
    try {
      this.onProgress({ phase: 'manifest', progress: 0 });
      const response = await fetch(this.manifestUrl, { mode: 'cors', cache: 'no-cache' });
      if (!response.ok) throw new Error(`GTFS manifest request failed (${response.status} ${response.statusText})`);
      this.manifest = await response.json();
      if (!this.manifest || typeof this.manifest !== 'object' || typeof this.manifest.version !== 'string' || !this.manifest.version) {
        throw new TypeError('GTFS manifest must include a non-empty version string');
      }
      if (!this.manifest.files || typeof this.manifest.files !== 'object') {
        throw new TypeError('GTFS manifest must include a files object');
      }
      for (const name of REQUIRED_FILES) {
        if (typeof this.manifest.files[name] !== 'string' || !this.manifest.files[name]) {
          throw new TypeError(`GTFS manifest is missing files.${name}`);
        }
      }
      if (!globalThis.caches) throw new Error('Cache Storage is unavailable; serve the app over HTTPS or localhost');
      this.cache = await globalThis.caches.open(`${CACHE_PREFIX}${encodeURIComponent(this.manifest.version)}`);

      const bundles = {
        mvp: {
          mainModule: new URL('/vendor/duckdb/duckdb-mvp.wasm', globalThis.location.href).toString(),
          mainWorker: new URL('/vendor/duckdb/duckdb-browser-mvp.worker.js', globalThis.location.href).toString(),
        },
        eh: {
          mainModule: new URL('/vendor/duckdb/duckdb-eh.wasm', globalThis.location.href).toString(),
          mainWorker: new URL('/vendor/duckdb/duckdb-browser-eh.worker.js', globalThis.location.href).toString(),
        },
      };
      const bundle = await duckdb.selectBundle(bundles);
      const worker = new Worker(bundle.mainWorker);
      this.db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), worker);
      await this.db.instantiate(bundle.mainModule, bundle.pthreadWorker);
      this.conn = await this.db.connect();

      for (const name of CORE_FILES) await this.registerCachedFile(name);

      await this.buildTables();
      this.meta = await this.getMeta();
      this.onProgress({ phase: 'ready', progress: 1, version: this.manifest.version });
      return { version: this.manifest.version, meta: this.meta };
    } catch (error) {
      try {
        await this.close();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'GTFS initialization failed and DuckDB cleanup also failed');
      }
      throw error;
    }
  }

  async query(sql) {
    if (!this.conn) throw new Error('GTFS data client has not been initialized');
    const table = await this.conn.query(sql);
    return table.toArray().map((row) => plainValue(row.toJSON()));
  }

  async queryInChunks(sql, batchSize = 256) {
    if (!this.conn) throw new Error('GTFS data client has not been initialized');
    if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
      throw new RangeError('batchSize must be a positive safe integer');
    }
    const table = await this.conn.query(sql);
    const rows = [];
    for (let start = 0; start < table.numRows; start += batchSize) {
      const end = Math.min(start + batchSize, table.numRows);
      rows.push(...table.slice(start, end).toArray().map((row) => plainValue(row.toJSON())));
      if (end < table.numRows) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return rows;
  }

  async registerCachedFile(name) {
    if (!this.db || !this.cache || !this.manifest) throw new Error('GTFS data client is not ready to register files');
    const cacheKey = new URL(
      `/__gtfs_cache__/${encodeURIComponent(this.manifest.version)}/${name}.parquet`,
      globalThis.location.origin
    ).toString();
    let cached = await this.cache.match(cacheKey);
    let bytes;
    if (cached) {
      this.onProgress({ phase: `cache:${name}`, cached: true });
      bytes = new Uint8Array(await cached.arrayBuffer());
    } else {
      this.onProgress({ phase: `download:${name}`, cached: false });
      const fileUrl = new URL(this.manifest.files[name], this.manifestUrl).toString();
      const response = await fetch(fileUrl, { mode: 'cors', cache: 'no-store' });
      if (!response.ok) throw new Error(`GTFS ${name}.parquet request failed (${response.status} ${response.statusText})`);
      bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength === 0) throw new Error(`GTFS ${name}.parquet is empty`);
      cached = new Response(bytes.slice(), {
        headers: {
          'Content-Type': response.headers.get('content-type') || 'application/octet-stream',
          'X-GTFS-Manifest-Version': this.manifest.version,
        },
      });
      await this.cache.put(cacheKey, cached);
    }
    await this.db.registerFileBuffer(`${name}.parquet`, bytes);
    this.onProgress({ phase: `registered:${name}`, bytes: bytes.byteLength });
  }

  async buildTables() {
    const steps = [
      ['stop_times', `CREATE TEMP TABLE st AS
        SELECT trip_id, stop_id, TRY_CAST(stop_sequence AS INT) seq, TRY_CAST(shape_dist_traveled AS DOUBLE) dist
        FROM 'stop_times.parquet'`],
      ['trip signatures', `CREATE TEMP TABLE tsig AS
        SELECT trip_id, count(*) n, count(dist) nd, sum(hash(stop_id, seq)::HUGEINT) sig
        FROM st GROUP BY trip_id`],
      ['patterns', `CREATE TABLE pat AS
        SELECT t.route_id, s.sig::VARCHAR sig, count(*) trips_cnt,
               min(t.trip_id) FILTER (s.nd = s.n AND s.n >= 2) rep_trip,
               min(t.direction_id) direction_id
        FROM tsig s JOIN 'trips.parquet' t USING (trip_id)
        GROUP BY t.route_id, s.sig`],
      ['representative trips', `CREATE TEMP TABLE rep AS
        SELECT trip_id, list(dist ORDER BY seq) cum, list(stop_id ORDER BY seq) stops
        FROM st WHERE trip_id IN (SELECT rep_trip FROM pat WHERE rep_trip IS NOT NULL)
        GROUP BY trip_id`],
      ['stops', `CREATE TABLE stops_t AS SELECT stop_id, stop_name FROM 'stops.parquet'`],
      ['pattern vectors', `CREATE TABLE pat_vec AS
        SELECT p.route_id, p.sig, p.trips_cnt, p.direction_id, p.rep_trip,
               row_number() OVER (PARTITION BY p.route_id ORDER BY p.trips_cnt DESC, p.sig) pat_rank,
               r.stops,
               list_transform(r.cum, x -> greatest(x - r.cum[1], 0)) cum,
               list_transform(range(2, len(r.cum) + 1), i -> greatest(r.cum[i] - r.cum[i - 1], 0)) seg,
               list_transform(range(2, len(r.cum) + 1), i -> greatest((r.cum[i] + r.cum[i - 1]) / 2.0 - r.cum[1], 0)) mid
        FROM pat p JOIN rep r ON r.trip_id = p.rep_trip`],
      ['routes', `CREATE TABLE routes_t AS
        SELECT r.route_id, r.route_short_name, r.route_long_name, r.route_desc, r.agency_id,
               coalesce(a.agency_name, r.agency_id) agency_name, r.route_type
        FROM 'routes.parquet' r LEFT JOIN 'agency.parquet' a USING (agency_id)`],
      ['route samples', `CREATE TABLE samples_route AS
        SELECT pv.route_id sample_id, pv.route_id, any_value(r.route_short_name) route_short_name,
               any_value(r.route_long_name) route_long_name, any_value(r.route_desc) route_desc,
               any_value(r.agency_id) agency_id, any_value(r.agency_name) agency_name,
               any_value(r.route_type) route_type, count(*)::INT n_patterns, sum(pv.trips_cnt)::INT n_trips,
               flatten(list(pv.seg ORDER BY pv.pat_rank)) seg,
               flatten(list(pv.cum ORDER BY pv.pat_rank)) cum,
               flatten(list(pv.mid ORDER BY pv.pat_rank)) mid,
               list(len(pv.seg)::INT ORDER BY pat_rank) seg_lengths,
               list(len(pv.cum)::INT ORDER BY pat_rank) cum_lengths,
               any_value(pv.stops[1]) FILTER (pv.pat_rank = 1) first_stop_id,
               any_value(pv.stops[-1]) FILTER (pv.pat_rank = 1) last_stop_id
        FROM pat_vec pv JOIN routes_t r USING (route_id) GROUP BY pv.route_id`],
      ['pattern samples', `CREATE TABLE samples_pattern AS
        SELECT pv.route_id || '#' || pv.pat_rank sample_id, pv.route_id, r.route_short_name,
               r.route_long_name, r.route_desc, r.agency_id, r.agency_name, r.route_type,
               1 n_patterns, pv.trips_cnt::INT n_trips, pv.seg, pv.cum, pv.mid,
               [len(pv.seg)::INT] seg_lengths, [len(pv.cum)::INT] cum_lengths,
               pv.stops[1] first_stop_id, pv.stops[-1] last_stop_id
        FROM pat_vec pv JOIN routes_t r USING (route_id)`],
    ];

    for (let i = 0; i < steps.length; i++) {
      const [phase, sql] = steps[i];
      this.onProgress({ phase, progress: i / steps.length });
      await this.conn.query(sql);
    }
    for (const name of ['st', 'tsig', 'rep']) await this.conn.query(`DROP TABLE ${name}`);
    this.onProgress({ phase: 'tables-ready', progress: 1 });
  }

  async ensureMapTables() {
    if (this.mapTablesPromise) return this.mapTablesPromise;
    this.mapTablesPromise = (async () => {
      await this.registerCachedFile('shapes');
      this.onProgress({ phase: 'map-shapes', progress: 0 });
      await this.conn.query(`
        CREATE TABLE shape_lines AS
        WITH raw AS (
          SELECT shape_id, TRY_CAST(shape_pt_sequence AS INT) seq,
                 TRY_CAST(shape_pt_lat AS DOUBLE) lat, TRY_CAST(shape_pt_lon AS DOUBLE) lon
          FROM 'shapes.parquet'
          WHERE TRY_CAST(shape_pt_lat AS DOUBLE) BETWEEN 29 AND 34
            AND TRY_CAST(shape_pt_lon AS DOUBLE) BETWEEN 34 AND 36
        ), ranked AS (
          SELECT *, row_number() OVER (PARTITION BY shape_id ORDER BY seq) rn,
                 count(*) OVER (PARTITION BY shape_id) n
          FROM raw
        )
        SELECT shape_id,
               list([lon, lat] ORDER BY seq)
                 FILTER (rn = 1 OR rn = n OR (rn - 1) % greatest(1, ceil(n / 100.0)::INT) = 0) points
        FROM ranked GROUP BY shape_id`);
      await this.conn.query(`
        CREATE TABLE sample_shapes AS
        SELECT pv.route_id || '#' || pv.pat_rank sample_id, pv.route_id, pv.pat_rank, t.shape_id
        FROM pat_vec pv JOIN 'trips.parquet' t ON t.trip_id = pv.rep_trip
        WHERE t.shape_id IS NOT NULL`);
      this.onProgress({ phase: 'map-shapes', progress: 1 });
    })().catch((error) => {
      this.mapTablesPromise = null;
      throw error;
    });
    return this.mapTablesPromise;
  }

  async getMeta() {
    const [counts] = await this.query(`
      SELECT (SELECT count(*) FROM routes_t)::INT routes,
             (SELECT count(*) FROM pat)::INT patterns,
             (SELECT count(*) FROM pat WHERE rep_trip IS NULL)::INT patterns_without_dist,
             (SELECT count(*) FROM samples_route)::INT route_samples,
             (SELECT count(*) FROM samples_pattern)::INT pattern_samples,
             (SELECT median(len(seg)) FROM samples_route) median_route_len,
             (SELECT max(len(seg)) FROM samples_route)::INT max_route_len,
             (SELECT median(len(seg)) FROM samples_pattern) median_pattern_len,
             (SELECT max(len(seg)) FROM samples_pattern)::INT max_pattern_len`);
    const agencies = await this.query(`
      SELECT agency_id, agency_name, count(*)::INT n
      FROM samples_route GROUP BY ALL ORDER BY n DESC`);
    const routeTypes = await this.query(`
      SELECT route_type, count(*)::INT n
      FROM samples_route GROUP BY ALL ORDER BY n DESC`);
    return { counts, agencies, routeTypes };
  }

  whereClause(filters = {}) {
    const conditions = [];
    const addList = (column, values) => {
      if (Array.isArray(values) && values.length) {
        conditions.push(`${column} IN (${values.map(escapeString).join(',')})`);
      }
    };
    addList('agency_id', filters.agencyIds);
    addList('route_type', filters.routeTypes);
    const feature = filters.feature === 'cum' ? 'cum' : 'seg';
    conditions.push(`len(${feature}) >= ${intValue(filters.minLen)}`);
    if (filters.search) {
      const search = escapeString(`%${filters.search}%`);
      conditions.push(`(route_short_name ILIKE ${search} OR route_long_name ILIKE ${search} OR route_desc ILIKE ${search})`);
    }
    if (filters.routeNameSearch) {
      conditions.push(`route_short_name ILIKE ${escapeString(`%${filters.routeNameSearch}%`)}`);
    }
    return conditions.join(' AND ');
  }

  async loadSamples(filters = {}) {
    const table = filters.unit === 'pattern' ? 'samples_pattern' : 'samples_route';
    const col = filters.feature === 'cum' ? 'cum' : 'seg';
    return this.queryInChunks(`
      SELECT sample_id, route_id, route_short_name, route_long_name, route_desc, agency_name, route_type,
             n_patterns, n_trips, len(${col})::INT n, ${col} vec, seg, cum, mid, seg_lengths, cum_lengths
      FROM ${table} WHERE ${this.whereClause(filters)} ORDER BY sample_id`);
  }

  async listSamples(filters = {}) {
    const table = filters.unit === 'pattern' ? 'samples_pattern' : 'samples_route';
    const col = filters.feature === 'cum' ? 'cum' : 'seg';
    const limit = Math.min(1000, Math.max(1, intValue(filters.limit, 200) || 200));
    const where = this.whereClause(filters);
    const rows = await this.query(`
      SELECT sample_id, route_short_name, route_long_name, route_desc, agency_name, route_type,
             n_patterns, n_trips, len(${col})::INT n, round(list_sum(seg)) total_m
      FROM ${table} WHERE ${where}
      ORDER BY route_short_name, sample_id LIMIT ${limit}`);
    const [{ c }] = await this.query(`SELECT count(*)::INT c FROM ${table} WHERE ${where}`);
    return { total: Number(c), rows };
  }

  async getSample(unit, feature, id) {
    const table = unit === 'pattern' ? 'samples_pattern' : 'samples_route';
    const col = feature === 'cum' ? 'cum' : 'seg';
    const [row] = await this.query(`
      SELECT s.sample_id, s.route_id, s.route_short_name, s.route_long_name, s.route_desc,
             s.agency_name, s.route_type, s.n_patterns, s.n_trips,
             s.${col} vec, s.seg, s.cum, s.mid, s.seg_lengths, s.cum_lengths,
             (SELECT stop_name FROM stops_t WHERE stop_id = s.first_stop_id) first_stop,
             (SELECT stop_name FROM stops_t WHERE stop_id = s.last_stop_id) last_stop
      FROM ${table} s WHERE s.sample_id = ${escapeString(id)}`);
    if (!row) return null;
    row.patterns = await this.query(`
      SELECT pat_rank::INT rank, trips_cnt::INT trips, len(stops)::INT n_stops, cum[-1] total_m,
             (SELECT stop_name FROM stops_t WHERE stop_id = stops[1]) first_stop,
             (SELECT stop_name FROM stops_t WHERE stop_id = stops[-1]) last_stop
      FROM pat_vec WHERE route_id = ${escapeString(row.route_id)} ORDER BY pat_rank`);
    return row;
  }

  async getVectors(unit, feature, ids) {
    const table = unit === 'pattern' ? 'samples_pattern' : 'samples_route';
    const col = feature === 'cum' ? 'cum' : 'seg';
    const patternLengthsCol = feature === 'cum' ? 'cum_lengths' : 'seg_lengths';
    const results = [];
    for (let offset = 0; offset < ids.length; offset += 500) {
      const batch = ids.slice(offset, offset + 500);
      if (!batch.length) continue;
      results.push(...await this.query(`
        SELECT s.sample_id, s.${col} vec, s.seg, s.cum, s.mid,
               s.${patternLengthsCol} pattern_lengths, s.seg_lengths, s.cum_lengths
        FROM ${table} s WHERE s.sample_id IN (${batch.map(escapeString).join(',')})`));
    }
    return results;
  }

  async getMapLines(unit, samples) {
    const selected = samples.slice(0, 12000);
    if (!selected.length) return [];
    await this.ensureMapTables();
    const values = selected.map((sample) => `(${escapeString(sample.sample_id)}, ${Math.trunc(Number(sample.cluster))})`).join(',');
    const mapTable = unit === 'pattern'
      ? 'sample_shapes'
      : '(SELECT route_id sample_id, route_id, shape_id FROM sample_shapes GROUP BY ALL)';
    return this.query(`
      WITH selected(sample_id, cluster_id) AS (VALUES ${values})
      SELECT s.sample_id, s.cluster_id, sh.shape_id, sh.points
      FROM selected s
      JOIN ${mapTable} ss USING (sample_id)
      JOIN shape_lines sh USING (shape_id)
      ORDER BY s.sample_id, sh.shape_id`);
  }

  async close() {
    if (this.conn) {
      await this.conn.close();
      this.conn = null;
    }
    if (this.db) {
      await this.db.terminate();
      this.db = null;
    }
    this.cache = null;
  }
}
