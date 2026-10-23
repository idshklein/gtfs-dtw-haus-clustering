import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectDirectory = path.resolve(appDirectory, '..');
const sourceDirectory = path.resolve(
  process.env.GTFS_PARQUET_DIR || path.join(projectDirectory, 'israel-public-transportation-parquet')
);
const outputDirectory = path.join(appDirectory, 'data-deploy');
const requiredFiles = ['agency', 'routes', 'shapes', 'stops', 'stop_times', 'trips'];

const hashFile = async (filePath) => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
};

const fileHashes = {};
for (const name of requiredFiles) {
  const filePath = path.join(sourceDirectory, `${name}.parquet`);
  const metadata = await stat(filePath);
  if (!metadata.isFile() || metadata.size === 0) {
    throw new Error(`Required GTFS data file is missing or empty: ${filePath}`);
  }
  fileHashes[name] = await hashFile(filePath);
}

const snapshotHash = createHash('sha256');
for (const name of requiredFiles) snapshotHash.update(`${name} ${fileHashes[name]}\n`);
const version = `sha256-${snapshotHash.digest('hex')}`;
const snapshotDirectory = path.join(outputDirectory, 'snapshots', version);

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(snapshotDirectory, { recursive: true });

const files = {};
for (const name of requiredFiles) {
  await copyFile(
    path.join(sourceDirectory, `${name}.parquet`),
    path.join(snapshotDirectory, `${name}.parquet`)
  );
  files[name] = `./snapshots/${version}/${name}.parquet`;
}

await writeFile(
  path.join(outputDirectory, 'manifest.json'),
  `${JSON.stringify({ version, files }, null, 2)}\n`,
  'utf8'
);
await writeFile(
  path.join(outputDirectory, '_headers'),
  [
    '/*',
    '  Access-Control-Allow-Origin: *',
    '  Access-Control-Allow-Methods: GET, HEAD, OPTIONS',
    '  Access-Control-Allow-Headers: Range',
    '  Access-Control-Expose-Headers: Accept-Ranges, Content-Range, Content-Length, ETag, Last-Modified',
    '  Timing-Allow-Origin: *',
    '/manifest.json',
    '  Cache-Control: no-cache',
    '/snapshots/*',
    '  Cache-Control: public, max-age=31536000, immutable',
    '',
  ].join('\n'),
  'utf8'
);

let totalBytes = 0;
for (const name of requiredFiles) {
  const { size } = await stat(path.join(snapshotDirectory, `${name}.parquet`));
  totalBytes += size;
}
console.log(`Prepared Netlify data deploy at ${outputDirectory}`);
console.log(`Snapshot: ${version}`);
console.log(`Parquet bytes: ${totalBytes}`);
