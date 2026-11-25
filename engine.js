/* Parking signals and the July 2024 archive. All event times are in Seoul. */
(() => {
  'use strict';

  const MIN = 60000;
  const SEOUL = 9 * 60 * MIN;
  const BASE = Date.parse('2024-07-20T15:00:00+09:00');
  const SURGE = 60;
  const CALM = 25;
  const DURATION = 45;
  const FIRST = 300;
  const LAST = 450;
  const API = 'https://www.ksponco.or.kr/online/main/parkingorsApi.do?apiKey=PARKING21803504';
  const SCHEDULE = 'https://www.ksponco.or.kr/olympicpark/eventInfo/eventInfoListAjax.es';
  const VENUE = /DOME|체조|올림픽홀|핸드볼|88잔디|체육관|경기장/i;
  const archive = window.PATTERN_2024.d20.v;
  const patternStart = archive.findIndex((value, index) => index > 0 && archive[index - 1] - value >= SURGE);
  const recordedShows = [
    { title: '올림픽홀 공연', plc: '올림픽홀', start: BASE + 180 * MIN, end: BASE + 300 * MIN },
    { title: 'KSPO DOME 공연', plc: 'KSPO DOME', start: BASE + 180 * MIN, end: BASE + 330 * MIN },
  ];
  const listeners = new Set();
  const clock = time => new Date(time + SEOUL).toISOString().slice(11, 16);
  const dayKey = time => new Date(time + SEOUL).toISOString().slice(0, 10);
  let demo = false, started = false, playing = false, minute = 380;
  let player, generation = 0, polling = false, loadingShows = false;
  let lastOk = 0, liveErr = false, schedErr = false, scheduleDay = '', lastScheduleTry = 0;
  let liveShows = [], liveSamples = [], latestState, liveGo = null;

  function cached(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
    catch { return fallback; }
  }
  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Storage is optional. */ }
  }
  const stored = cached('olpark_samples', []);
  if (Array.isArray(stored)) {
    const time = Date.now();
    liveSamples = stored.filter(s => Array.isArray(s) && Number.isFinite(s[0]) &&
      Number.isInteger(s[1]) && s[1] >= 0 && s[0] <= time && time - s[0] < 180 * MIN)
      .sort((a, b) => a[0] - b[0]);
    lastOk = liveSamples.at(-1)?.[0] || 0;
  }

  function parseTime(text) {
    const m = text.match(/(오전|오후)?\s*(\d{1,2})(?:(?:\s*:\s*|\s*시\s*)(\d{1,2})?(?:\s*분)?(?:\s*(am|pm))?|\s*(am|pm))/i);
    if (!m) return null;
    let h = Number(m[2]);
    const minutes = Number(m[3] || 0), period = (m[1] || m[4] || m[5] || '').toLowerCase();
    if (period === '오전' || period === 'am') h %= 12;
    else if (period === '오후' || period === 'pm') h = h % 12 + 12;
    else if (h < 9) h += 12;
    return h < 24 && minutes < 60 ? h * 60 + minutes : null;
  }
  function startMinutes(item, date) {
    const weekday = '일월화수목금토'[date.getUTCDay()];
    const month = date.getUTCMonth() + 1, day = date.getUTCDate();
    const text = (item.tm || '').replace(/\s+/g, ' ');
    const datePatterns = [
      new RegExp('(?:^|\\D)0?' + month + '월\\s*0?' + day + '일'),
      new RegExp('(?:^|\\D)0?' + month + '\\.\\s*0?' + day + '(?!\\d)'),
    ];
    for (const anchor of datePatterns) {
      const match = anchor.exec(text);
      if (match) return parseTime(text.slice(match.index + match[0].length));
    }
    if (/\d{1,2}월\s*\d{1,2}일.*\d{1,2}월\s*\d{1,2}일/.test(text)) return null;
    for (const part of text.split(/\s*[/|]\s*/)) {
      const week = part.match(/(?:^|\s|\()([월화수목금토일]+)(?:요일|\)|\s)/);
      if (week?.[1].includes(weekday)) return parseTime(part.slice(week.index + week[0].length));
    }
    return parseTime(text);
  }

  async function fetchJSON(url, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 9000);
    try {
      const response = await fetch(url, { cache: 'no-store', ...options, signal: controller.signal });
      if (!response.ok) throw Error(String(response.status));
      return await response.json();
    } finally { clearTimeout(timeout); }
  }
  async function loadShows() {
    if (demo || loadingShows) return;
    const token = generation, timestamp = Date.now(), day = dayKey(timestamp);
    const ym = day.slice(0, 7).replace('-', '');
    loadingShows = true;
    lastScheduleTry = timestamp;
    if (scheduleDay !== day) liveShows = [];
    try {
      let rows;
      try { rows = (await fetchJSON('schedule.json')).months?.[ym]; }
      catch { /* The public schedule API is the secondary source. */ }
      if (!Array.isArray(rows)) rows = await fetchJSON(SCHEDULE, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nowYM: ym, plcCd: '' }),
      });
      if (!Array.isArray(rows)) throw Error('schedule format');
      if (generation !== token) return;
      const date = new Date(timestamp + SEOUL), midnight = Date.parse(day + 'T00:00:00+09:00');
      const seen = new Set();
      liveShows = rows.flat().filter(item => {
        if (!item || item.beginDt > day || item.endDt < day || !VENUE.test(item.plc)) return false;
        const key = item.title + item.plc;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).map(item => {
        const start = startMinutes(item, date);
        const duration = Number(item.ndTm?.match(/\d{2,3}/)?.[0]) || (/DOME|체조/.test(item.plc) ? 150 : 120);
        return { title: item.title, plc: item.plc.trim(), start: start === null ? null : midnight + start * MIN,
          end: start === null ? null : midnight + (start + duration) * MIN };
      }).sort((a, b) => (a.end ?? Infinity) - (b.end ?? Infinity));
      scheduleDay = day;
      schedErr = false;
      save('olpark_shows', { day, shows: liveShows });
    } catch {
      if (generation !== token) return;
      const record = cached('olpark_shows', null);
      liveShows = record?.day === day && Array.isArray(record.shows) ? record.shows : [];
      schedErr = true;
    } finally {
      if (generation === token) { loadingShows = false; emit(); }
    }
  }

  async function poll() {
    if (demo || polling) return;
    const token = generation;
    polling = true;
    try {
      const data = await fetchJSON(API);
      const raw = data?.[0]?.parking_sum;
      if ((typeof raw !== 'number' && typeof raw !== 'string') || !String(raw).trim()) throw Error('missing count');
      const value = Number(raw);
      if (!Number.isSafeInteger(value) || value < 0) throw Error('invalid count');
      if (generation !== token) return;
      lastOk = Date.now();
      liveSamples = liveSamples.filter(s => lastOk - s[0] < 180 * MIN);
      if (liveSamples.length && lastOk - liveSamples.at(-1)[0] < 1000) liveSamples.pop();
      liveSamples.push([lastOk, value]);
      save('olpark_samples', liveSamples);
      liveErr = false;
    } catch { if (generation === token) liveErr = true; }
    finally { if (generation === token) { polling = false; emit(); } }
  }

  // A long gap starts a new observation window. It cannot provide a five-minute change.
  function continuous(samples) {
    for (let i = samples.length - 1; i > 0; --i) {
      if (samples[i][0] - samples[i - 1][0] > 6 * MIN) return samples.slice(i);
    }
    return samples;
  }
  function sampleAt(samples, time) {
    for (let i = samples.length - 1; i >= 0; --i) {
      if (samples[i][0] <= time + MIN / 2) return time - samples[i][0] < 1.5 * MIN ? samples[i] : null;
    }
    return null;
  }
  function dropAt(samples, time) {
    const a = sampleAt(samples, time - 5 * MIN), b = sampleAt(samples, time);
    if (!a || !b || b[0] - a[0] < 4 * MIN || b[0] - a[0] > 6.5 * MIN) return null;
    const delta = Math.round((a[1] - b[1]) * 5 * MIN / (b[0] - a[0]));
    return Math.abs(delta) <= 400 ? delta : null;
  }
  function archiveSamples(end) {
    return Array.from({ length: end + 1 }, (_, m) => {
      const i = Math.floor(m / 5), mix = m % 5 / 5;
      return [BASE + m * MIN, Math.round(archive[i] + ((archive[i + 1] ?? archive[i]) - archive[i]) * mix)];
    });
  }
  function rates(samples, end) {
    if (samples.length < 2) return [];
    const changes = samples.filter((s, i) => i === 0 || s[1] !== samples[i - 1][1] || i === samples.length - 1);
    function value(time) {
      if (time < changes[0][0] || time > changes.at(-1)[0]) return null;
      const i = changes.findIndex(s => s[0] >= time);
      if (i <= 0) return changes[0][1];
      const a = changes[i - 1], b = changes[i];
      return a[1] + (b[1] - a[1]) * (time - a[0]) / (b[0] - a[0]);
    }
    const raw = Array.from({ length: 61 }, (_, i) => {
      const t = end - (60 - i) * MIN, a = value(t - MIN), b = value(t);
      return { t, r: a === null || b === null || Math.abs(a - b) > 80 ? null : Math.max(0, a - b) };
    });
    return raw.map((p, i) => {
      if (p.r === null) return p;
      const near = raw.slice(Math.max(0, i - 1), i + 2).filter(q => q.r !== null);
      return { t: p.t, r: near.reduce((sum, q) => sum + q.r, 0) / near.length };
    });
  }

  function decide(samples, t, shows, d, onset) {
    const result = (tone, chip, head, lab, big, after, tip, go = null, alarm = false) =>
      ({ tone, chip, head, lab, big, after, tip, go, alarm, wait: alarm });
    if (!demo && ((lastOk && t - lastOk > 5 * MIN) || (!lastOk && liveErr)))
      return result('stale', '연결 지연', '주차 정보를 기다리고 있어요', '', '', '', '기관 연결을 다시 시도하거나 공연 기록을 볼 수 있어요.');
    if (d === null)
      return result('wait', '관측 중', '출차 흐름을 확인하고 있어요', '', '', '', '5분 동안 주차 대수 변화를 모으면 출발 시각을 안내해요.');
    if (onset !== null) {
      let go = onset + DURATION * MIN;
      const previous = dropAt(samples, t - 2 * MIN);
      const below = previous !== null && previous < SURGE && d < SURGE;
      const settled = below && (d < CALM || (t >= go && d < SURGE * 0.6) || t >= go + 5 * MIN);
      if (d >= SURGE || (!settled && (demo || liveGo !== onset))) {
        const crowded = d >= SURGE;
        if (t >= go - (crowded ? 2 : 0) * MIN) go = t + (crowded ? 5 : 3) * MIN;
        if (crowded && !demo) liveGo = null;
        return result(crowded ? 'jam' : 'easing', crowded ? '혼잡' : '완화 중',
          crowded ? '조금 쉬었다 출발하세요' : '출차 흐름이 잦아들고 있어요', '예상 출발 시각', clock(go),
          '약 ' + Math.ceil((go - t) / MIN) + '분 뒤',
          crowded ? '주차 대수가 빠르게 줄고 있어요. 출차가 몰리는 시간이에요.' : '혼잡이 누그러지고 있어요. 관측값을 보고 출발 시각을 조정해요.', go, true);
      }
      if (!demo) liveGo = onset;
      return result('go', '출발 권장', '지금 출발하기 좋아요', '추천 출발', '지금', '출차 집중 구간이 지났어요', '5분간 주차 대수 감소폭이 혼잡 기준 아래로 내려왔어요.', t);
    }
    const ends = shows.map(show => show.end).filter(end => end && end < t + 4 * 60 * MIN);
    const end = ends.length ? Math.max(...ends) : null;
    if (end && t < end)
      return result('show', '공연 중', '공연이 진행 중이에요', '예상 종료', clock(end), '', '종료 시각은 공연 일정과 러닝타임을 기준으로 계산해요.');
    if (end && t <= end + 110 * MIN)
      return result('soon', '공연 종료 후', '곧 출차가 몰릴 수 있어요', '추천 출발', '지금', '공연 종료 후 집중 구간', '아직 대량 출차 신호가 없어요. 종료 후 흐름이 빠르게 바뀔 수 있어요.', t);
    return result('calm', '평소 수준', '지금 출발하기 좋아요', '추천 출발', '지금', '출차 집중 신호가 없어요',
      '최근 5분간 주차 대수 변화가 대량 출차 기준에 못 미쳤어요.', t);
  }
  function pattern(k) {
    const x = patternStart + k / 5, i = Math.floor(x);
    if (i < 1 || i >= archive.length) return 0;
    const a = Math.max(0, (archive[i - 1] - archive[i]) / 5);
    const b = Math.max(0, (archive[i] - (archive[i + 1] ?? archive[i])) / 5);
    return a + (b - a) * (x - i);
  }
  function predict(series, onset, decision, time) {
    if (onset === null || !['jam', 'easing', 'go'].includes(decision.tone)) return [];
    const recent = series.filter(p => p.r !== null).slice(-8);
    if (!recent.length) return [];
    const modeled = recent.reduce((sum, p) => sum + pattern((p.t - onset) / MIN), 0);
    const observed = recent.reduce((sum, p) => sum + p.r, 0);
    const scale = modeled > 0.5 * recent.length ? Math.max(0.5, Math.min(2, observed / modeled)) : 1;
    const count = Math.ceil(Math.max(30, (decision.go - time) / MIN + 6));
    return Array.from({ length: count + 1 }, (_, i) => {
      const base = pattern((time - onset) / MIN + i) * scale;
      return { t: time + i * MIN, r: i < 4 ? recent.at(-1).r + (base - recent.at(-1).r) * i / 4 : base };
    });
  }
  function emit() {
    const time = demo ? BASE + minute * MIN : Date.now();
    const samples = demo ? archiveSamples(minute) : continuous(liveSamples);
    const shows = demo ? recordedShows : liveShows;
    const end = samples.at(-1)?.[0], fresh = end && time - end <= 5 * MIN;
    const drop = fresh ? dropAt(samples, end) : null;
    const onset = samples.find(s => time - s[0] <= 90 * MIN && dropAt(samples, s[0]) >= SURGE)?.[0] ?? null;
    const series = end ? rates(samples, end) : [];
    const decision = decide(samples, time, shows, drop, onset);
    latestState = { demo, playing, time, minute: demo ? minute : null, lastOk: demo ? time : lastOk,
      schedulePending: !demo && !scheduleDay && !schedErr, liveErr: !demo && liveErr, schedErr: !demo && schedErr, shows, decision, series,
      forecast: predict(series, onset, decision, time), rate: fresh ? series.at(-1)?.r ?? null : null,
      drop, total: samples.at(-1)?.[1] ?? null };
    listeners.forEach(fn => fn(latestState));
  }
  function stopPlayer() { clearInterval(player); playing = false; }
  function switchMode(toDemo) {
    stopPlayer();
    generation++;
    polling = loadingShows = false;
    demo = toDemo;
  }
  function position(value) {
    return Math.max(FIRST, Math.min(LAST, Number.isFinite(Number(value)) ? Math.round(Number(value)) : 380));
  }
  function replay(value = 380) { switchMode(true); minute = position(value); emit(); }
  function seek(value) { if (demo) { stopPlayer(); minute = position(value); emit(); } }
  function togglePlay() {
    if (!demo) return;
    if (playing) stopPlayer();
    else {
      if (minute >= LAST) minute = FIRST;
      playing = true;
      player = setInterval(() => {
        if (++minute >= LAST) stopPlayer();
        emit();
      }, 950);
    }
    emit();
  }
  function refresh() { if (!demo) { poll(); loadShows(); } }
  function live() { switchMode(false); emit(); refresh(); }
  function start() {
    if (started) return;
    started = true;
    const q = new URLSearchParams(location.search);
    if (q.has('demo')) {
      const at = /^(\d{1,2}):([0-5]\d)$/.exec(q.get('at') || '');
      replay(at ? Number(at[1]) * 60 + Number(at[2]) - 900 : 380);
    } else live();
    setInterval(() => {
      if (demo) return;
      poll();
      if (scheduleDay !== dayKey(Date.now()) || Date.now() - lastScheduleTry >= 30 * MIN) loadShows();
    }, MIN);
    setInterval(() => { if (!demo) emit(); }, 15000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden && !demo) refresh(); });
    window.addEventListener('online', refresh);
  }
  function subscribe(fn) {
    listeners.add(fn);
    if (latestState) fn(latestState);
    return () => listeners.delete(fn);
  }
  window.exitClock = { subscribe, start, live, replay, seek, togglePlay, refresh };
})();
