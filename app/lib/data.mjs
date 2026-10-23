import { DuckDBInstance } from '@duckdb/node-api';
import path from 'node:path';

let conn;
let parquetDir;

const q = (p) => `'${path.join(parquetDir, p).replaceAll('\\', '/').replaceAll("'", "''")}'`;

async function all(sql, params) {
  const r = params ? await conn.runAndReadAll(sql, params) : await conn.runAndReadAll(sql);
  return r.getRowObjectsJson();
}

export async function initData(dir) {
  parquetDir = dir;
  const inst = await DuckDBInstance.create(':memory:');
  conn = await inst.connect();
  await conn.run('SET threads=8');
  const t0 = Date.now();

  // stop_times, typed once; the temp tables are dropped at the end of the build
  await conn.run(`
    CREATE TEMP TABLE st AS
    SELECT trip_id, stop_id, TRY_CAST(stop_sequence AS INT) seq, TRY_CAST(shape_dist_traveled AS DOUBLE) dist
    FROM ${q('stop_times.parquet')}`);

  // one signature per trip = order-sensitive hash of its (stop_id, stop_sequence) pairs
  await conn.run(`
    CREATE TEMP TABLE tsig AS
    SELECT trip_id, count(*) n, count(dist) nd, sum(hash(stop_id, seq)::HUGEINT) sig
    FROM st GROUP BY trip_id`);

  // unique trip patterns per route; the representative trip must have complete shape_dist_traveled
  await conn.run(`
    CREATE TABLE pat AS
    SELECT t.route_id, s.sig::VARCHAR sig, count(*) trips_cnt,
           min(t.trip_id) FILTER (s.nd = s.n AND s.n >= 2) rep_trip,
           min(t.direction_id) direction_id
    FROM tsig s JOIN ${q('trips.parquet')} t USING (trip_id)
    GROUP BY t.route_id, s.sig`);

  await conn.run(`
    CREATE TEMP TABLE rep AS
    SELECT trip_id, list(dist ORDER BY seq) cum, list(stop_id ORDER BY seq) stops
    FROM st WHERE trip_id IN (SELECT rep_trip FROM pat WHERE rep_trip IS NOT NULL)
    GROUP BY trip_id`);

  await conn.run(`
    CREATE TABLE stops_t AS
    SELECT stop_id, stop_name FROM ${q('stops.parquet')}`);

  // pattern vectors:
  // cum = zero-anchored cumulative distance at each stop (m)
  // seg = distance between consecutive stops (m)
  // mid = midpoint distance from start of pattern for each segment (m)
  await conn.run(`
    CREATE TABLE pat_vec AS
    SELECT p.route_id, p.sig, p.trips_cnt, p.direction_id, p.rep_trip,
           row_number() OVER (PARTITION BY p.route_id ORDER BY p.trips_cnt DESC, p.sig) pat_rank,
           r.stops,
           list_transform(r.cum, x -> greatest(x - r.cum[1], 0)) cum,
           list_transform(range(2, len(r.cum) + 1), i -> greatest(r.cum[i] - r.cum[i - 1], 0)) seg,
           list_transform(range(2, len(r.cum) + 1), i -> greatest((r.cum[i] + r.cum[i - 1]) / 2.0 - r.cum[1], 0)) mid
    FROM pat p JOIN rep r ON r.trip_id = p.rep_trip`);

  await conn.run(`
    CREATE TABLE routes_t AS
    SELECT r.route_id, r.route_short_name, r.route_long_name, r.route_desc, r.agency_id,
           coalesce(a.agency_name, r.agency_id) agency_name, r.route_type
    FROM ${q('routes.parquet')} r LEFT JOIN ${q('agency.parquet')} a USING (agency_id)`);

  await conn.run(`
    CREATE TABLE shape_lines AS
    WITH raw AS (
      SELECT shape_id, TRY_CAST(shape_pt_sequence AS INT) seq,
             TRY_CAST(shape_pt_lat AS DOUBLE) lat, TRY_CAST(shape_pt_lon AS DOUBLE) lon
      FROM ${q('shapes.parquet')}
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
    FROM ranked
    GROUP BY shape_id`);

  await conn.run(`
    CREATE TABLE sample_shapes AS
    SELECT pv.route_id || '#' || pv.pat_rank sample_id, pv.route_id, pv.pat_rank,
           t.shape_id
    FROM pat_vec pv
    JOIN ${q('trips.parquet')} t ON t.trip_id = pv.rep_trip
    WHERE t.shape_id IS NOT NULL`);

  // samples: one per route (all unique patterns concatenated) ...
  await conn.run(`
    CREATE TABLE samples_route AS
    SELECT pv.route_id sample_id, pv.route_id, any_value(r.route_short_name) route_short_name,
           any_value(r.route_long_name) route_long_name, any_value(r.route_desc) route_desc,
           any_value(r.agency_id) agency_id,
           any_value(r.agency_name) agency_name, any_value(r.route_type) route_type,
           count(*)::INT n_patterns, sum(pv.trips_cnt)::INT n_trips,
           flatten(list(pv.seg ORDER BY pv.pat_rank)) seg,
           flatten(list(pv.cum ORDER BY pv.pat_rank)) cum,
           flatten(list(pv.mid ORDER BY pv.pat_rank)) mid,
           list(len(pv.seg)::INT ORDER BY pat_rank) seg_lengths,
           list(len(pv.cum)::INT ORDER BY pat_rank) cum_lengths,
           any_value(pv.stops[1]) FILTER (pv.pat_rank = 1) first_stop_id,
           any_value(pv.stops[-1]) FILTER (pv.pat_rank = 1) last_stop_id
    FROM pat_vec pv JOIN routes_t r USING (route_id)
    GROUP BY pv.route_id`);

  // ... or one per unique trip pattern
  await conn.run(`
    CREATE TABLE samples_pattern AS
    SELECT pv.route_id || '#' || pv.pat_rank sample_id, pv.route_id, r.route_short_name, r.route_long_name,
           r.route_desc, r.agency_id, r.agency_name, r.route_type, 1 n_patterns, pv.trips_cnt::INT n_trips,
           pv.seg, pv.cum, pv.mid,
           [len(pv.seg)::INT] seg_lengths,
           [len(pv.cum)::INT] cum_lengths,
           pv.stops[1] first_stop_id, pv.stops[-1] last_stop_id
    FROM pat_vec pv JOIN routes_t r USING (route_id)`);

  for (const t of ['st', 'tsig', 'rep']) await conn.run(`DROP TABLE ${t}`);
  console.log(`data ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

export async function getMeta() {
  const [counts] = await all(`
    SELECT (SELECT count(*) FROM routes_t)::INT routes,
           (SELECT count(*) FROM pat)::INT patterns,
           (SELECT count(*) FROM pat WHERE rep_trip IS NULL)::INT patterns_without_dist,
           (SELECT count(*) FROM samples_route)::INT route_samples,
           (SELECT count(*) FROM samples_pattern)::INT pattern_samples,
           (SELECT median(len(seg)) FROM samples_route) median_route_len,
           (SELECT max(len(seg)) FROM samples_route)::INT max_route_len,
           (SELECT median(len(seg)) FROM samples_pattern) median_pattern_len,
           (SELECT max(len(seg)) FROM samples_pattern)::INT max_pattern_len`);
  const agencies = await all(`
    SELECT agency_id, agency_name, count(*)::INT n FROM samples_route GROUP BY ALL ORDER BY n DESC`);
  const routeTypes = await all(`
    SELECT route_type, count(*)::INT n FROM samples_route GROUP BY ALL ORDER BY n DESC`);
  return { counts, agencies, routeTypes };
}

function whereClause(f) {
  const cond = [];
  const vals = [];
  const list = (col, arr) => {
    if (Array.isArray(arr) && arr.length) {
      cond.push(`${col} IN (${arr.map(() => '?').join(',')})`);
      vals.push(...arr.map(String));
    }
  };
  list('agency_id', f.agencyIds);
  list('route_type', f.routeTypes);
  const minLen = Math.max(0, Math.floor(Number(f.minLen) || 0));
  cond.push(`len(${f.feature === 'cum' ? 'cum' : 'seg'}) >= ${minLen}`);
  if (f.search) {
    cond.push(`(route_short_name ILIKE ? OR route_long_name ILIKE ? OR route_desc ILIKE ?)`);
    vals.push(`%${f.search}%`, `%${f.search}%`, `%${f.search}%`);
  }
  if (f.routeNameSearch) {
    cond.push(`route_short_name ILIKE ?`);
    vals.push(`%${f.routeNameSearch}%`);
  }
  return { where: cond.join(' AND '), vals };
}

// All samples (with vectors) matching the selected filters for a distance matrix run.
export async function loadSamples(f) {
  const table = f.unit === 'pattern' ? 'samples_pattern' : 'samples_route';
  const col = f.feature === 'cum' ? 'cum' : 'seg';
  const { where, vals } = whereClause(f);
  return all(
    `SELECT sample_id, route_id, route_short_name, route_long_name, route_desc, agency_name, route_type,
            n_patterns, n_trips, len(${col})::INT n, ${col} vec, seg, cum, mid, seg_lengths, cum_lengths
     FROM ${table} WHERE ${where} ORDER BY sample_id`,
    vals
  );
}

export async function getSample(unit, feature, id) {
  const table = unit === 'pattern' ? 'samples_pattern' : 'samples_route';
  const col = feature === 'cum' ? 'cum' : 'seg';
  const [row] = await all(
    `SELECT s.sample_id, s.route_id, s.route_short_name, s.route_long_name, s.route_desc, s.agency_name, s.route_type,
            s.n_patterns, s.n_trips, s.${col} vec, s.seg, s.cum, s.mid, s.seg_lengths, s.cum_lengths,
            (SELECT stop_name FROM stops_t WHERE stop_id = s.first_stop_id) first_stop,
            (SELECT stop_name FROM stops_t WHERE stop_id = s.last_stop_id) last_stop
     FROM ${table} s WHERE s.sample_id = ?`,
    [id]
  );
  if (!row) return null;
  row.patterns = await all(
    `SELECT pat_rank::INT rank, trips_cnt::INT trips, len(stops)::INT n_stops, cum[-1] total_m,
            (SELECT stop_name FROM stops_t WHERE stop_id = stops[1]) first_stop,
            (SELECT stop_name FROM stops_t WHERE stop_id = stops[-1]) last_stop
     FROM pat_vec WHERE route_id = ? ORDER BY pat_rank`,
    [row.route_id]
  );
  return row;
}

export async function getVectors(unit, feature, ids) {
  const table = unit === 'pattern' ? 'samples_pattern' : 'samples_route';
  const col = feature === 'cum' ? 'cum' : 'seg';
  const patternLengthsCol = feature === 'cum' ? 'cum_lengths' : 'seg_lengths';
  const results = [];
  for (let offset = 0; offset < ids.length; offset += 500) {
    const list = ids.slice(offset, offset + 500).map(String);
    if (!list.length) continue;
    results.push(...await all(
      `SELECT s.sample_id, s.${col} vec, s.seg, s.cum, s.mid,
              s.${patternLengthsCol} pattern_lengths, s.seg_lengths, s.cum_lengths
       FROM ${table} s WHERE s.sample_id IN (${list.map(() => '?').join(',')})`,
      list
    ));
  }
  return results;
}

export async function getMapLines(unit, samples) {
  const values = samples.slice(0, 12000);
  if (!values.length) return [];
  const params = [];
  const rows = values.map((sample) => {
    params.push(String(sample.sample_id), Number(sample.cluster));
    return '(?::VARCHAR, ?::INT)';
  });
  const mapTable = unit === 'pattern' ? 'sample_shapes' : `
    (SELECT route_id sample_id, route_id, shape_id FROM sample_shapes GROUP BY ALL)`;
  return all(
    `WITH selected(sample_id, cluster_id) AS (VALUES ${rows.join(',')})
     SELECT s.sample_id, s.cluster_id, sh.shape_id, sh.points
     FROM selected s
     JOIN ${mapTable} ss USING (sample_id)
     JOIN shape_lines sh USING (shape_id)
     ORDER BY s.sample_id, sh.shape_id`,
    params
  );
}

// Tabular view of samples for the "data" tab
export async function listSamples(f) {
  const table = f.unit === 'pattern' ? 'samples_pattern' : 'samples_route';
  const { where, vals } = whereClause(f);
  const col = f.feature === 'cum' ? 'cum' : 'seg';
  const limit = Math.min(1000, Math.max(1, Math.floor(Number(f.limit) || 200)));
  const rows = await all(
    `SELECT sample_id, route_short_name, route_long_name, route_desc, agency_name, route_type, n_patterns, n_trips,
            len(${col})::INT n, round(list_sum(seg)) total_m
     FROM ${table} WHERE ${where} ORDER BY route_short_name, sample_id LIMIT ${limit}`,
    vals
  );
  const [{ c }] = await all(`SELECT count(*)::INT c FROM ${table} WHERE ${where}`, vals);
  return { total: Number(c), rows };
}
