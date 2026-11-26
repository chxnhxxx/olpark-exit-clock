// Temporary probe: how many events each official schedule request returns.
const BASE = 'https://www.ksponco.or.kr/olympicpark/eventInfo/';
async function post(ep, body) {
  const r = await fetch(BASE + ep, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
  const t = await r.text();
  try { const j = JSON.parse(t); return j; } catch { return 'non-json ' + t.slice(0, 200); }
}
const show = (label, j) => {
  if (!Array.isArray(j)) return console.log(label, typeof j === 'string' ? j : JSON.stringify(j).slice(0, 300));
  const flat = j.flat(); console.log(label, 'parts', j.map(a => Array.isArray(a) ? a.length : typeof a).join('/'), 'titles', flat.slice(0, 40).map(e => e && (e.plc || '') + ':' + String(e.title).slice(0, 18)).join(' | '));
};
(async () => {
  for (const ym of ['202611', '202612']) {
    show(ym + ' list', await post('eventInfoListAjax.es', { nowYM: ym, plcCd: '' }));
    show(ym + ' list p2', await post('eventInfoListAjax.es', { nowYM: ym, plcCd: '', pageIndex: 2, currentPage: 2, page: 2 }));
    show(ym + ' cal', await post('eventInfoListCalAjax.es', { nowYM: ym + '01', plcCd: '0' }));
    for (const c of ['1', '2', '3', '4', '5', '6', '7', '8']) show(ym + ' list plc' + c, await post('eventInfoListAjax.es', { nowYM: ym, plcCd: c }));
  }
  const html = await (await fetch(BASE + 'eventInfoList.es?mid=a20301010100')).text();
  console.log('HTML plc options', (html.match(/plcCd[^\n]{0,200}/g) || []).slice(0, 10).join('\n'));
  console.log('HTML ajax refs', (html.match(/eventInfo\w*Ajax[^\n]{0,200}/g) || []).slice(0, 10).join('\n'));
  const js = (html.match(/<script[^>]*src="([^"]*event[^"]*)"/g) || []); console.log('scripts', js.join(' '));
  console.log('폭풍 in html', html.includes('폭풍'));
})();
