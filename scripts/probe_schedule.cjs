// Temporary probe: find events by title across months and print their time fields.
const BASE = 'https://www.ksponco.or.kr/olympicpark/eventInfo/';
(async () => {
  for (const ym of ['202609','202610','202611','202612','202701','202702','202703']) {
    const r = await fetch(BASE + 'eventInfoListAjax.es', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nowYM: ym, plcCd: '' }) });
    const j = await r.json(); const flat = j.flat();
    console.log(ym, flat.length, flat.map(e => e.title.slice(0, 14)).join(' | '));
    for (const e of flat) if (/폭풍|뮤지컬/.test(e.title)) console.log('  HIT', JSON.stringify({ evtSeq: e.evtSeq, title: e.title, plc: e.plc, beginDt: e.beginDt, endDt: e.endDt, tm: e.tm, ndTm: e.ndTm, keys: Object.keys(e).join(',') }));
  }
})();
