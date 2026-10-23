import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.GTFS_PARQUET_DIR || path.resolve(here, '..', '..', 'israel-public-transportation-parquet');
const port = Number(process.env.GTFS_FIXTURE_PORT) || 3001;
const app = express();
const requests = [];

app.use((req, res, next) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range',
    'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Range, Content-Length, ETag, Last-Modified',
    'Timing-Allow-Origin': '*',
    Vary: 'Range',
  });
  const startedAt = Date.now();
  res.on('finish', () => {
    if (req.path !== '/__stats') {
      requests.push({
        path: req.path,
        method: req.method,
        range: req.get('range') || null,
        status: res.statusCode,
        contentRange: res.get('content-range') || null,
        contentLength: Number(res.get('content-length')) || null,
        durationMs: Date.now() - startedAt,
      });
    }
  });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/__stats', (req, res) => res.json(requests));
const manifest = (req, version, missingFile) => {
  const base = `${req.protocol}://${req.get('host')}`;
  const files = Object.fromEntries(['agency', 'routes', 'shapes', 'stops', 'stop_times', 'trips'].map((name) => [
    name,
    `${base}/${name === missingFile ? 'missing' : name}.parquet?snapshot=${version}`,
  ]));
  return { version, files };
};
app.get('/manifest.json', (req, res) => {
  res.json(manifest(req, 'gate0-local-fixture-c7252aa-v4'));
});
app.get('/manifest-next.json', (req, res) => {
  res.json(manifest(req, 'gate0-local-fixture-c7252aa-v5'));
});
app.get('/manifest-broken-file.json', (req, res) => {
  res.json(manifest(req, 'gate0-local-fixture-broken-v1', 'agency'));
});
app.get('/manifest-missing.json', (req, res) => res.json({ version: 'invalid', files: {} }));

app.use(express.static(dataDir, { fallthrough: false, immutable: true, maxAge: '1h' }));
app.listen(port, '127.0.0.1', () => console.log(`GTFS fixture server http://127.0.0.1:${port} (${dataDir})`));
