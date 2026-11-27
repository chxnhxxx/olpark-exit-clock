'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const MIN = 60000;
const engine = fs.readFileSync('engine.js', 'utf8');
const archive = fs.readFileSync('data2024.js', 'utf8');
async function settle() {
  for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve));
}
async function start({ time, seed = [], rows = [], parking = 1000, record, records = {}, recordIndex, mainRecords = {}, search = '' }) {
  let now = Date.parse(time), state;
  const intervals = [], storage = new Map([['olpark_samples', JSON.stringify(seed.map(([m, v]) => [now + m * MIN, v]))]]);
  class Clock extends Date { static now() { return now; } }
  const box = {
    window: { addEventListener() {} }, Date: Clock, URLSearchParams, AbortController,
    location: { search }, document: { addEventListener() {} },
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) },
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    clearInterval() {}, setTimeout, clearTimeout,
    fetch: async url => {
      const main = 'https://raw.githubusercontent.com/chxnhxxx/olpark-exit-clock/main/records/';
      if (url.startsWith(main)) {
        const doc = mainRecords[url.slice(main.length)];
        return { ok: Boolean(doc), json: async () => doc };
      }
      if (url === 'records/index.json') return { ok: Boolean(recordIndex), json: async () => recordIndex };
      if (url.startsWith('records/')) {
        const doc = records[url.slice(8, -5)] ?? record;
        return { ok: Boolean(doc), json: async () => doc };
      }
      if (parking === null) throw Error('offline');
      return { ok: true, json: async () => [{ parking_sum: parking }] };
    },
  };
  box.window.parkSchedule = { load: async () => ({ months: Object.fromEntries(
    ['202611', '202612', '202701'].map(m => [m, rows])) }) };
  vm.createContext(box);
  vm.runInContext(archive, box);
  vm.runInContext(engine, box);
  const api = box.window.exitClock;
  api.subscribe(s => { state = s; });
  api.start();
  await settle();
  return {
    api, state: () => state,
    async tick(ms) {
      now += ms;
      intervals.filter(timer => timer.ms === 15000).forEach(timer => timer.fn());
      await settle();
    },
    async advance(iso) { now = Date.parse(iso); api.refresh(); await settle(); },
  };
}
function show(day, tm, ndTm = '120분') {
  return { evtSeq: 1, title: '밤 공연', plc: 'KSPO DOME', beginDt: day, endDt: day, tm, ndTm };
}
(async () => {
  const empty = await start({ time: '2026-11-27T21:00:00+09:00' });
  assert.equal(empty.state().decision.tone, 'wait');
  const ready = await start({ time: '2026-11-27T21:00:00+09:00',
    seed: [[-5, 1060], [-4, 1048], [-3, 1036], [-2, 1024], [-1, 1012]], rows: [show('2026-11-27', '19:00')] });
  assert.equal(ready.state().drop, 60);
  assert.equal(ready.state().decision.tone, 'jam');
  // first estimate is a range (surge +30..+65 min); 21:00 surge → 21:30~22:05
  assert.equal(ready.state().decision.big, '21:30~22:05');
  assert.equal(ready.state().decision.lab, '예상 출발 범위');
  // 우리금융아트홀 nights use their own range (surge +15..+45 min)
  const hall = await start({ time: '2026-11-27T21:00:00+09:00',
    seed: [[-5, 1060], [-4, 1048], [-3, 1036], [-2, 1024], [-1, 1012]],
    rows: [{ ...show('2026-11-27', '19:00'), plc: '올림픽공원 우리금융아트홀' }] });
  assert.equal(hall.state().decision.big, '21:15~21:45');
  assert.match(hall.state().decision.tip, /우리금융아트홀/);
  // no show ending near this time (e.g. a weekday 22:00 blip) → no congestion alert
  const blip = await start({ time: '2026-11-27T22:05:00+09:00',
    seed: [[-5, 1060], [-4, 1048], [-3, 1036], [-2, 1024], [-1, 1012]] });
  assert.equal(blip.state().drop, 60);
  assert.equal(blip.state().decision.tone, 'calm');
  assert.equal(blip.state().decision.alarm, false);
  // a festival with only a start time has an unknown end, so its evening exit is not hidden
  const fest = await start({ time: '2026-11-27T22:05:00+09:00',
    seed: [[-5, 1060], [-4, 1048], [-3, 1036], [-2, 1024], [-1, 1012]],
    rows: [{ ...show('2026-11-27', '11:00', ''), title: '서울재즈페스티벌 2026', plc: '88잔디마당, KSPO DOME' }] });
  assert.equal(fest.state().shows[0].end, null);
  assert.equal(fest.state().decision.tone, 'jam');
  // a sustained exit with no listed show (two back-to-back 5-min drops of 60+) is still guided
  const unlisted = await start({ time: '2026-11-27T22:05:00+09:00',
    seed: Array.from({ length: 11 }, (_, i) => [i - 11, 1200 - i * 13]) });
  assert.equal(unlisted.state().decision.tone, 'jam');
  // opened right after a show ended: no big "지금" until it has watched for 30 min
  const late = await start({ time: '2026-11-27T21:20:00+09:00',
    seed: [[-6, 2000], [-5, 1990], [-4, 1980], [-3, 1970], [-2, 1960], [-1, 1950]], parking: 1945, rows: [show('2026-11-27', '19:00')] });
  assert.equal(late.state().decision.big, '확인 중');
  assert.match(late.state().decision.tip, /남아 있어요/);
  // matinee ended and the evening crowd is arriving: net drop stays low, but don't say "now"
  const turnover = await start({ time: '2026-11-27T16:50:00+09:00',
    seed: Array.from({ length: 40 }, (_, i) => [i - 40, 3000 - i * 4]), parking: 2840,
    rows: [show('2026-11-27', '14:00'), { ...show('2026-11-27', '18:00'), evtSeq: 2, title: '저녁 공연', plc: '올림픽홀' }] });
  assert.equal(turnover.state().decision.big, '확인 중');
  assert.equal(turnover.state().decision.chip, '공연 교대 시간');
  const matinee = await start({ time: '2026-11-27T22:05:00+09:00',
    seed: [[-5, 1060], [-4, 1048], [-3, 1036], [-2, 1024], [-1, 1012]], rows: [show('2026-11-27', '15:00')] });
  assert.equal(matinee.state().decision.tone, 'calm');
  await ready.tick(15000);
  assert.equal(ready.state().rate, 12);
  const six = await start({ time: '2026-11-27T21:00:00+09:00', seed: [[-6, 1200]] });
  assert.equal(six.state().drop, null);
  assert.equal(six.state().decision.tone, 'wait');
  const night = await start({ time: '2026-12-31T23:59:00+09:00',
    seed: [[-5, 1000], [-4, 1000], [-3, 1000], [-2, 1000], [-1, 1000]],
    rows: [show('2026-12-31', '23:00')] });
  night.api.selectShow(night.api.showKey(night.state().shows[0]));
  await night.advance('2027-01-01T00:01:00+09:00');
  assert.equal(night.state().shows.length, 1);
  assert.equal(night.state().selectedShow.title, '밤 공연');
  assert.equal(night.state().decision.big, '01:00');
  assert.equal(night.state().decision.tone, 'show');
  const afterMidnight = await start({ time: '2027-01-01T00:05:00+09:00',
    seed: [[-5, 1000], [-4, 1000], [-3, 1000], [-2, 1000], [-1, 1000]],
    rows: [show('2026-12-31', '23:00')] });
  assert.equal(afterMidnight.state().decision.big, '01:00');
  const offline = await start({ time: '2026-11-27T21:00:00+09:00', parking: null });
  assert.equal(offline.state().decision.tone, 'stale');
  const samples = [
    ...Array.from({ length: 30 }, (_, i) => [1140 + i, 1000]),
    ...Array.from({ length: 11 }, (_, i) => [1200 + i, 500]),
  ];
  const replay = await start({ time: '2026-11-28T12:00:00+09:00',
    record: { samples, shows: [show('2026-11-27', '18:00')] } });
  await replay.api.replay(1190, '2026-11-27');
  assert.equal(replay.state().decision.tone, 'wait');
  assert.equal(replay.state().drop, null);
  assert.equal(replay.state().review.points.length, 41);
  assert.equal(replay.state().record.first, 1140);
  assert.equal(replay.state().record.last, 1210);
  assert.equal(replay.state().review.recommendation, null);
  const signal = Array.from({length:40}, (_,i) => [790+i, 1200-Math.min(i,10)*15]);
  async function firstGo(rows) {
    const r = await start({time:'2026-11-28T12:00:00+09:00', record:{samples:rows}});
    await r.api.replay(undefined,'2026-11-27');
    for (const [m] of rows) {
      r.api.seek(m);
      if (r.state().decision.tone === 'go') {
        assert.equal(r.state().review.recommendation,m);
        return m;
      }
    }
    assert.fail('expected a recommendation');
  }
  assert.equal(await firstGo(signal),await firstGo([...signal,[1470,400]]));
  // 2026-11-27 measured night: a second exit wave (23:22) must not reuse the first wave's onset.
  const night27 = JSON.parse(fs.readFileSync('records/2026-11-27.json', 'utf8'));
  const wave = await start({ time: '2026-11-28T12:00:00+09:00', record: { samples: night27.samples, shows: night27.shows } });
  await wave.api.replay(undefined, '2026-11-27');
  assert.equal(wave.state().review.recommendation, 22 * 60 + 39);
  assert.equal(wave.state().review.firstRange.text, '21:57~22:32');
  // after 15 min the range comes from the queue model; the 올림픽홀 crowd (ending later) is left out
  wave.api.seek(21 * 60 + 42);
  assert.equal(wave.state().decision.big, '22:18~22:53');
  assert.match(wave.state().decision.tip, /남은 차 약 1,360대/);
  assert.match(wave.state().decision.tip, /올림픽홀 공연 차량은 22:40 이후 따로/);
  // cleared = backtest rule: 5-min windows from the surge (21:27), two in a row under 25
  assert.equal(wave.state().review.cleared, 22 * 60 + 42);
  assert.deepEqual(JSON.parse(JSON.stringify(wave.api.nightLog(night27, '2026-11-27'))),
    { onset: '21:27', firstRange: { at: '21:27', range: '21:57~22:32' }, confirmed: '22:39', cleared: '22:42' });
  for (let m = 23 * 60 + 22; m <= 23 * 60 + 35; m++) {
    wave.api.seek(m);
    assert.notEqual(wave.state().decision.tone, 'go', `second wave ${m}`);
  }
  const beforeGap = replay.state().series.filter(p => p.t <= Date.parse('2026-11-27T19:29:00+09:00') && p.r !== null);
  assert(beforeGap.length > 0);
  assert(beforeGap.every(p => p.r === 0));
  replay.api.seek(1205);
  const base = Date.parse('2026-11-27T00:00:00+09:00');
  const gap = replay.state().series.filter(p => p.t > base + 1169 * MIN && p.t <= base + 1200 * MIN);
  assert(gap.length > 0);
  assert(gap.every(p => p.r === null));
  assert.equal(replay.state().rate, 0);
  const reconstructed = { kind: 'reconstruction', samples: Array.from({length: 45}, (_, i) => [1200 + i, -14 * i]) };
  const latest = await start({ time: '2026-11-28T12:00:00+09:00', search: '?demo&at=20:10',
    recordIndex: {days: [{day: '2026-11-27', count: 40}]}, records: {'2025-12-06': reconstructed} });
  assert.equal(latest.state().record.id, '2025-12-06');
  assert.equal(latest.state().record.kind, 'reconstruction');
  assert.equal(latest.state().total, null);
  assert.equal(latest.state().minute, 1210);
  assert.equal(latest.state().drop, 70);
  const measured = await start({ time: '2026-11-28T12:00:00+09:00', search: '?demo',
    recordIndex: {days: [{day: '2026-11-27', count: 41}, {day: '2026-11-25', count: 42}]},
    records: {'2026-11-27': {samples}, '2025-12-06': reconstructed} });
  assert.equal(measured.state().record.id, '2026-11-27');
  assert.equal(measured.state().record.kind, 'measured');
  const fromMain = await start({ time: '2026-11-28T12:00:00+09:00', search: '?demo', recordIndex: {days: []},
    mainRecords: { 'index.json': {days: [{day: '2026-11-27', count: 41}]}, '2026-11-27.json': {samples} } });
  assert.equal(fromMain.state().record.id, '2026-11-27');
  assert.equal(fromMain.state().record.kind, 'measured');
  const old = await start({ time: '2026-11-28T12:00:00+09:00', search: '?demo&record=2024-07-20&at=22:00' });
  assert.equal(old.state().record.id, '2024-07-20');
  assert.equal(old.state().minute, 420);
  const explicit = measured.api.showsForDay([show('2026-11-28', '18:00~20:00 / 22:00–01:15', '')], '2026-11-28');
  assert.equal(explicit.length, 2);
  assert.equal(explicit[0].end, Date.parse('2026-11-28T20:00:00+09:00'));
  assert.equal(explicit[1].end, Date.parse('2026-11-29T01:15:00+09:00'));
  assert.equal(explicit[1].endDefault, false);
  assert.equal(explicit[1].endBasis, '공식 일정의 종료 시각');
  console.log('PASS observation, 6-minute reset, 5-minute delta, month/year midnight, selection, offline, replay gaps');
})().catch(error => { console.error(error); process.exitCode = 1; });
