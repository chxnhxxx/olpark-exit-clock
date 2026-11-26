/* Collect the public park schedule for GitHub Pages. No credentials required. */
'use strict';
const fs = require('node:fs');
const BASE = 'https://www.ksponco.or.kr/olympicpark/eventInfo/';

function publishedRows(payload, calendar) {
  if (!Array.isArray(payload) || payload.length !== 2 || !payload.every(Array.isArray)) {
    throw Error('Unexpected schedule response');
  }
  const day = value => typeof value === 'string' ? value.replace(/^(\d{4})(\d\d)(\d\d)$/, '$1-$2-$3') : '';
  const rows = (calendar ? payload[0] : payload.flat()).map(row =>
    row && { ...row, beginDt: day(row.beginDt), endDt: day(row.endDt) });
  if (!rows.every(row => row && /^\d+$/.test(String(row.evtSeq)) && typeof row.title === 'string' &&
      /^\d{4}-\d\d-\d\d$/.test(row.beginDt) && /^\d{4}-\d\d-\d\d$/.test(row.endDt))) {
    throw Error('Invalid event fields');
  }
  return [...new Map(rows.map(row => [String(row.evtSeq), row])).values()];
}

async function fetchMonth(month, request = fetch) {
  for (const [calendar, endpoint] of [[false, 'eventInfoListAjax.es'], [true, 'eventInfoListCalAjax.es']]) {
    try {
      const response = await request(BASE + endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ nowYM: calendar ? month + '01' : month, plcCd: calendar ? '0' : '' }),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw Error('HTTP ' + response.status);
      return { rows: publishedRows(await response.json(), calendar), endpoint };
    } catch (error) {
      if (calendar) throw Error(month + ' official schedule unavailable: ' + error.message);
    }
  }
}

async function refresh(destination, now = new Date()) {
  const seoul = new Date(now.getTime() + 9 * 3600000);
  const months = {}, sources = {};
  for (const offset of [-1, 0, 1, 2, 3, 4, 5, 6]) {
    const key = new Date(Date.UTC(seoul.getUTCFullYear(), seoul.getUTCMonth() + offset, 1))
      .toISOString().slice(0, 7).replace('-', '');
    const {rows, endpoint} = await fetchMonth(key);
    months[key] = rows;
    sources[key] = endpoint;
    console.log(key, rows.length, endpoint);
  }
  // Update the file only after every month (last month to six months ahead) has a valid response.
  fs.writeFileSync(destination, JSON.stringify({ updated: now.toISOString(), months, sources }));
}

if (require.main === module) {
  refresh(process.argv[2] || 'schedule.json').catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { fetchMonth };
