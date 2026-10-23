import { cp, copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const appDirectory = path.resolve(scriptDirectory, '..');
const publicDirectory = path.join(appDirectory, 'public');
const outputDirectory = path.join(appDirectory, 'dist');
const manifestValue = process.env.GTFS_MANIFEST_URL?.trim();

if (!manifestValue) {
  throw new Error('Set GTFS_MANIFEST_URL to the HTTPS URL of the GTFS manifest before building the static site.');
}

const manifestUrl = new URL(manifestValue);
const loopbackHost = ['localhost', '127.0.0.1', '[::1]'].includes(manifestUrl.hostname);
if (manifestUrl.protocol !== 'https:' && !(manifestUrl.protocol === 'http:' && loopbackHost)) {
  throw new Error('GTFS_MANIFEST_URL must use HTTPS; HTTP is allowed only for localhost staging.');
}
if (manifestUrl.username || manifestUrl.password || manifestUrl.hash || manifestUrl.search) {
  throw new Error('GTFS_MANIFEST_URL must not contain credentials, a query string, or a fragment.');
}

await mkdir(outputDirectory, { recursive: true });
const localManifest = path.join(publicDirectory, 'gtfs-manifest.json');
await cp(publicDirectory, outputDirectory, {
  recursive: true,
  filter: (source) => path.resolve(source) !== localManifest,
});

const copyRequired = async (source, target) => {
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(source, target);
};

const leafletDirectory = path.join(appDirectory, 'node_modules', 'leaflet');
const duckdbDirectory = path.join(appDirectory, 'node_modules', '@duckdb', 'duckdb-wasm');
const arrowDirectory = path.join(appDirectory, 'node_modules', 'apache-arrow');
const licenseSourceDirectory = path.join(scriptDirectory, 'licenses');

for (const name of ['leaflet.css', 'leaflet.js']) {
  await copyRequired(
    path.join(leafletDirectory, 'dist', name),
    path.join(outputDirectory, 'vendor', 'leaflet', name)
  );
}
await cp(
  path.join(leafletDirectory, 'dist', 'images'),
  path.join(outputDirectory, 'vendor', 'leaflet', 'images'),
  { recursive: true }
);

for (const name of [
  'duckdb-mvp.wasm',
  'duckdb-eh.wasm',
  'duckdb-browser-mvp.worker.js',
  'duckdb-browser-eh.worker.js',
]) {
  await copyRequired(
    path.join(duckdbDirectory, 'dist', name),
    path.join(outputDirectory, 'vendor', 'duckdb', name)
  );
}

const licenseDirectory = path.join(outputDirectory, 'licenses');
await mkdir(licenseDirectory, { recursive: true });
await copyRequired(path.join(leafletDirectory, 'LICENSE'), path.join(licenseDirectory, 'leaflet-LICENSE'));
await copyRequired(path.join(licenseSourceDirectory, 'duckdb-wasm-LICENSE.txt'), path.join(licenseDirectory, 'duckdb-wasm-LICENSE.txt'));
await copyRequired(path.join(arrowDirectory, 'LICENSE.txt'), path.join(licenseDirectory, 'apache-arrow-LICENSE.txt'));
await copyRequired(path.join(arrowDirectory, 'NOTICE.txt'), path.join(licenseDirectory, 'apache-arrow-NOTICE.txt'));

const indexPath = path.join(outputDirectory, 'index.html');
const index = await readFile(indexPath, 'utf8');
const escapedManifestUrl = manifestUrl.toString()
  .replaceAll('&', '&amp;')
  .replaceAll('"', '&quot;')
  .replaceAll('<', '&lt;');
const updatedIndex = index.replace(
  /(<meta name="gtfs-manifest" content=")[^"]*(")/,
  `$1${escapedManifestUrl}$2`
);
if (updatedIndex === index) throw new Error('Could not find the GTFS manifest meta tag in public/index.html.');
await writeFile(indexPath, updatedIndex, 'utf8');

const outputFiles = await readdir(outputDirectory, { recursive: true });
console.log(`Static site built at ${outputDirectory} (${outputFiles.length} entries).`);
console.log(`GTFS manifest: ${manifestUrl.toString()}`);
