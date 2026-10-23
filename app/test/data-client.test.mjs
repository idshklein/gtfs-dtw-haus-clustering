import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserGtfsData } from '../public/data-client.mjs';

test('loadSamples converts Arrow rows in yielded chunks without changing order or values', async () => {
  const rows = Array.from({ length: 300 }, (_, index) => ({
    toJSON: () => ({ sample_id: `sample-${index}`, seg: new Float64Array([index, index + 1]) }),
  }));
  const slices = [];
  let query;
  const client = Object.create(BrowserGtfsData.prototype);
  client.conn = {
    async query(sql) {
      query = sql;
      return {
        numRows: rows.length,
        slice(start, end) {
          slices.push([start, end]);
          return { toArray: () => rows.slice(start, end) };
        },
      };
    },
  };

  const samples = await client.loadSamples({ unit: 'pattern', feature: 'seg', minLen: 2 });

  assert.match(query, /FROM samples_pattern/);
  assert.deepEqual(slices, [[0, 256], [256, 300]]);
  assert.equal(samples.length, rows.length);
  assert.equal(samples[0].sample_id, 'sample-0');
  assert.deepEqual(samples[299], { sample_id: 'sample-299', seg: [299, 300] });
});
