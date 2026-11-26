const assert = require('node:assert/strict');
const {fetchMonth} = require('../scripts/fetch_schedule.cjs');

(async () => {
  const row = {evtSeq: 100, title: '회차', beginDt: '2026-11-27', endDt: '2026-11-28'};
  const primary = await fetchMonth('202611', async () => ({ok: true, json: async () => [[], [row, row]]}));
  assert.deepEqual(primary.rows, [row]);
  const endpoints = [];
  const secondary = await fetchMonth('202611', async (url, payload) => {
    endpoints.push(JSON.parse(payload.body).nowYM);
    return {ok: true, json: async () => url.endsWith('ListAjax.es') ? {broken: true} :
      [[{...row, beginDt:'20261127', endDt:'20261128'}], [{calendar: true}]]};
  });
  assert.deepEqual(endpoints, ['202611', '20261101']);
  assert.deepEqual(secondary.rows, [row]);
  await assert.rejects(fetchMonth('202611', async () => ({ok:false, status:503})), /schedule unavailable/);
  console.log('PASS official schedule fallback, duplicate events, unavailable source');
})().catch(error => { console.error(error); process.exitCode = 1; });
