/* Parking signals and the July 2024 archive. All event times are in Seoul. */
(() => {
  'use strict';

  const MIN = 60000;
  const SEOUL = 9 * 60 * MIN;
  const BASE = Date.parse('2024-07-20T15:00:00+09:00');
  const SURGE = 60;
  const CALM = 25;
  const DURATION = 45;
  // Measured show night used by default for the 기록 체험 (records/<day>.json, saved by record.yml).
  // null keeps the July 2024 archive. ?record=YYYY-MM-DD picks any saved night.
  const DEFAULT_RECORD = null;
  const API = 'https://www.ksponco.or.kr/online/main/parkingorsApi.do?apiKey=PARKING21803504';
  const SCHEDULE = 'https://www.ksponco.or.kr/olympicpark/eventInfo/eventInfoListAjax.es';
  const archive = window.PATTERN_2024.d20.v;
  const patternStart = archive.findIndex((value, index) => index > 0 && archive[index - 1] - value >= SURGE);
  const recordedShows = [
    { title: '올림픽홀 공연', plc: '올림픽홀', start: BASE + 180 * MIN, end: BASE + 300 * MIN, endEstimated: false },
    { title: 'KSPO DOME 공연', plc: 'KSPO DOME', start: BASE + 180 * MIN, end: BASE + 330 * MIN, endEstimated: false },
  ];
  const listeners = new Set();
  const clock = time => new Date(time + SEOUL).toISOString().slice(11, 16);
  const dayKey = time => new Date(time + SEOUL).toISOString().slice(0, 10);
  const ARCHIVE_SOURCE = {
    id: '2024-07-20', label: '2024.07.20(토) 실제 기록', base: BASE, first: 300, last: 450, start: 380,
    steps: [300, 380, 420], shows: recordedShows,
    samples: Array.from({ length: 451 }, (_, m) => {
      const i = Math.floor(m / 5), mix = m % 5 / 5;
      return [BASE + m * MIN, Math.round(archive[i] + ((archive[i + 1] ?? archive[i]) - archive[i]) * mix)];
    }),
  };
  let source = ARCHIVE_SOURCE;
  let demo = false, started = false, playing = false, minute = 380;
  let player, generation = 0, polling = false, loadingShows = false;
  let lastOk = 0, liveErr = false, schedErr = false, scheduleDay = '', lastScheduleTry = 0;
  let liveShows = [], liveSamples = [], latestState, liveGo = null;
  let selectionScope = '', selectedKey = null;

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

  const DAYS = '일월화수목금토';
  const closed = /휴연|휴관|공연\s*없음|공연\s*없습니다|공연\s*취소/;
  function timesIn(text) {
    // The institution uses 7:30PM, 9:00:00PM, 오후 7시 30분, and multiple slots in one clause.
    const timePattern = /(?<!\d)(?:(오전|오후)\s*)?(\d{1,2})(?:(?:\s*:\s*(\d{2})(?::\d{2})?|\s*시(?:\s*(\d{1,2})\s*분)?)(?:\s*(am|pm))?|\s*(am|pm)|(?!\d))/gi;
    const times = [];
    for (const m of text.matchAll(timePattern)) {
      let h = Number(m[2]);
      const minute = Number(m[3] || m[4] || 0);
      const period = (m[1] || m[5] || m[6] || '').toLowerCase();
      if (!period && !m[0].includes('시') && m[3] === undefined) continue;
      if (minute > 59 || h > 23 || (period && (h < 1 || h > 12))) continue;
      if (period) h = h % 12 + (period === '오후' || period === 'pm' ? 12 : 0);
      else if (h > 0 && h < 9 && m[0].includes('시')) h += 12;
      times.push(h * 60 + minute);
    }
    return times;
  }

  function weeklySlots(text, day) {
    // Ranges may wrap around the end of the week. Commas can also separate two times.
    const normalized = text.replace(/([일월화수목금토])(?:요일)?\s*[~～–-]\s*([일월화수목금토])(?:요일)?/g,
      (_, from, to) => {
        let range = from, i = DAYS.indexOf(from);
        while (DAYS[i] !== to) { i = (i + 1) % 7; range += DAYS[i]; }
        return range;
      }).replace(/([일월화수목금토])(?:요일)?\s*[,·]\s*(?=[일월화수목금토](?:요일)?(?:\s|[,·]))/g, '$1');
    const anchors = [...normalized.matchAll(/(?<![가-힣\d])(?:매주\s*)?(평일|주말|[월화수목금토일]+)(?:요일)?(?=\s|[:：/)])/g)];
    if (!anchors.length) return closed.test(normalized) ? [] : timesIn(normalized);
    const weekday = DAYS[new Date(day + 'T00:00:00Z').getUTCDay()];
    const common = timesIn(normalized.slice(0, anchors[0].index));
    const slots = [];
    let matched = false;
    for (let i = 0; i < anchors.length; ++i) {
      const a = anchors[i], days = a[1].replace('평일', '월화수목금').replace('주말', '토일');
      if (!days.includes(weekday)) continue;
      matched = true;
      const clause = normalized.slice(a.index + a[0].length, anchors[i + 1]?.index);
      if (closed.test(clause)) return [];
      slots.push(...timesIn(clause));
    }
    return matched ? slots : common;
  }
  function sessionMinutes(item, day) {
    const text = String(item.tm || '').normalize('NFKC').trim();
    if (!text) return [null];
    const pattern = /(?<!\d)(?:(\d{4})\s*(?:년\s*|[.\/-]\s*))?(\d{1,2})\s*(?:월\s*|[.\/]\s*)(\d{1,2})(?!\d)\s*일?\.?\s*(?:\(\s*(?:[월화수목금토일](?:요일)?|[A-Z]{3})?\s*\)|(?:[월화수목금토일](?:요일)?|MON|TUE|WED|THU|FRI|SAT|SUN)(?=\s|\d))?/gi;
    // Expand a range whose second date omits its month.
    const normalized = text.replace(/(\d{1,2})월\s*(\d{1,2})일?\s*([~～–])\s*(\d{1,2})일/g, '$1월 $2일$3$1월 $4일');
    const anchors = [...normalized.matchAll(pattern)];
    const slotsFor = clause => {
      const slots = weeklySlots(clause, day);
      if (slots.length || closed.test(clause) || /(?:평일|주말|[월화수목금토일](?:요일)?)(?=\s|[:：/])/.test(clause)) return slots;
      return [null]; // An event with an unspecified time can still be selected.
    };
    if (!anchors.length) return slotsFor(normalized);
    const dates = anchors.map(a => {
      let year = Number(a[1] || item.beginDt.slice(0, 4));
      if (!a[1] && item.endDt.slice(0, 4) !== item.beginDt.slice(0, 4) && +a[2] < +item.beginDt.slice(5, 7)) year++;
      return year + '-' + a[2].padStart(2, '0') + '-' + a[3].padStart(2, '0');
    });
    const sessions = [];
    for (let i = 0; i < anchors.length; ++i) {
      const a = anchors[i], next = anchors[i + 1];
      let clause = normalized.slice(a.index + a[0].length, next?.index);
      if (next && /^\s*(?:~|～|–|-|부터)\s*$/.test(clause)) {
        if (day >= dates[i] && day <= dates[i + 1]) {
          clause = normalized.slice(next.index + next[0].length, anchors[i + 2]?.index);
          sessions.push(...slotsFor(clause));
        }
        ++i;
      } else if (dates[i] === day) {
        sessions.push(...slotsFor(clause));
      }
    }
    if (sessions.length) return sessions;
    if (dates.includes(day)) return []; // Includes explicit closure dates.
    const prefix = normalized.slice(0, anchors[0].index);
    if (timesIn(prefix).length) return slotsFor(prefix);
    // A malformed out-of-range date in the publisher's list cannot establish a start time.
    return dates.some(date => date < item.beginDt || date > item.endDt) ? [null] : [];
  }
  function showKey(show) {
    return JSON.stringify([show.evtSeq ?? show.title, show.plc, show.start ?? show.day ?? null]);
  }
  function showsForDay(rows, day) {
    if (!Array.isArray(rows) || !/^\d{4}-\d\d-\d\d$/.test(day)) return [];
    const midnight = Date.parse(day + 'T00:00:00+09:00'), shows = new Map();
    for (const item of rows.flat(Infinity)) {
      if (!item || !item.beginDt || !item.endDt || item.beginDt > day || item.endDt < day ||
          typeof item.plc !== 'string' || !item.plc.trim() || !item.title || item.delYn === 'Y') continue;
      const rawDuration = String(item.ndTm || '').trim();
      const duration = /(?:(\d+)\s*시간(?:\s*(\d+)\s*분)?|(\d{1,3})\s*분)/.exec(rawDuration);
      const published = duration ? Number(duration[1] || 0) * 60 + Number(duration[2] || duration[3] || 0) : null;
      // No published running time: assume a typical concert length so the night can still be guided.
      const minutes = published || (/KSPO|DOME|체조/i.test(item.plc) ? 150 : 120);
      for (const slot of sessionMinutes(item, day)) {
        const start = slot === null ? null : midnight + slot * MIN;
        const show = { evtSeq: item.evtSeq ?? null, title: item.title.normalize('NFKC').replace(/\s+/g, ' ').trim(), plc: item.plc.trim(),
          genre: item.cultureGenre || '', day, start, end: start !== null && minutes ? start + minutes * MIN : null,
          endEstimated: !published || /약|예상|내외/.test(rawDuration), endDefault: !published, tm: item.tm || '', ndTm: rawDuration };
        shows.set(showKey(show), show);
      }
    }
    return [...shows.values()].sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity) ||
      a.plc.localeCompare(b.plc, 'ko') || a.title.localeCompare(b.title, 'ko'));
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
    const previousDay = dayKey(timestamp - 24 * 60 * MIN);
    const months = [...new Set([previousDay, day].map(d => d.slice(0, 7).replace('-', '')))];
    loadingShows = true;
    lastScheduleTry = timestamp;
    try {
      let snapshot;
      try { snapshot = await window.parkSchedule.load(); }
      catch { /* The public schedule API is the secondary source. */ }
      const rows = await Promise.all(months.map(async ym => {
        const rows = snapshot?.months?.[ym];
        if (Array.isArray(rows)) return rows;
        const response = await fetchJSON(SCHEDULE, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nowYM: ym, plcCd: '' }),
        });
        if (!Array.isArray(response)) throw Error('schedule format');
        return response;
      }));
      if (generation !== token) return;
      liveShows = relevantShows([...showsForDay(rows, previousDay), ...showsForDay(rows, day)], timestamp);
      scheduleDay = day;
      schedErr = false;
      save('olpark_shows', { day, shows: liveShows });
    } catch {
      if (generation !== token) return;
      const record = cached('olpark_shows', null);
      if ([day, previousDay].includes(record?.day) && Array.isArray(record.shows)) {
        // Legacy caches inferred a duration when none was published. Surface that uncertainty.
        liveShows = record.shows.filter(show => show?.title && show.plc).map(show => ({
          ...show, day: show.day || record.day, endEstimated: show.endEstimated ?? Boolean(show.end),
        }));
        liveShows = relevantShows(liveShows, timestamp);
        scheduleDay = record.day;
      }
      schedErr = true;
    } finally {
      if (generation === token) { loadingShows = false; emit(); }
    }
  }

  function relevantShows(shows, time) {
    const day = dayKey(time);
    return shows.filter(show => (show.day || (show.start && dayKey(show.start))) === day ||
      (show.end && show.end + 110 * MIN >= time && show.start <= time));
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
      if (samples[i][0] - samples[i - 1][0] >= 6 * MIN) return samples.slice(i);
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
    const limit = source.base + end * MIN;
    return source.samples.filter(s => s[0] <= limit);
  }
  async function loadRecord(day) {
    if (!/^\d{4}-\d\d-\d\d$/.test(day || '')) return null;
    const doc = await fetchJSON('records/' + day + '.json');
    const base = Date.parse(day + 'T00:00:00+09:00');
    const samples = (doc.samples || []).filter(s => Number.isInteger(s[0]) && Number.isInteger(s[1]))
      .sort((a, b) => a[0] - b[0]).map(([m, v]) => [base + m * MIN, v]);
    if (samples.length < 30) return null;
    const minuteOf = t => Math.round((t - base) / MIN);
    let first = minuteOf(samples[0][0]) + 6, last = minuteOf(samples.at(-1)[0]);
    // The first surge of the night anchors a 2.5-hour window around the exit rush.
    const onsetSample = samples.find(s => s[0] >= base + first * MIN && dropAt(samples, s[0]) >= SURGE);
    const onset = onsetSample ? minuteOf(onsetSample[0]) : null;
    if (onset !== null) { first = Math.max(first, onset - 60); last = Math.min(last, onset + 90); }
    const clamp = m => Math.max(first, Math.min(last, m));
    const steps = onset === null ? [first, clamp(Math.round((first + last) / 2)), last]
      : [clamp(onset - 30), clamp(onset + 10), clamp(onset + DURATION)];
    const [y, m, d] = day.split('-');
    return { id: day, label: `${y}.${m}.${d}(${DAYS[new Date(base + 12 * 3600000).getUTCDay()]}) 실측 기록`,
      base, first, last, start: steps[1], steps, samples, shows: showsForDay(doc.shows || [], day) };
  }
  function rates(samples, end) {
    if (samples.length < 2) return [];
    const changes = samples.filter((s, i) => {
      const previous = samples[i - 1], next = samples[i + 1];
      return !previous || !next || s[1] !== previous[1] ||
        s[0] - previous[0] >= 6 * MIN || next[0] - s[0] >= 6 * MIN;
    });
    const gaps = samples.slice(1).flatMap((s, i) =>
      s[0] - samples[i][0] >= 6 * MIN ? [[samples[i][0], s[0]]] : []);
    function value(time) {
      if (time < changes[0][0] || time > changes.at(-1)[0]) return null;
      if (gaps.some(([start, end]) => time > start && time < end)) return null;
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

  function decide(samples, t, shows, selectedShow, d, onset) {
    const result = (tone, chip, head, lab, big, after, tip, go = null, alarm = false) =>
      ({ tone, chip, head, lab, big, after, tip, go, alarm, wait: alarm });
    if (!demo && ((lastOk && t - lastOk > 5 * MIN) || (!lastOk && liveErr)))
      return result('stale', '연결 지연', '주차 정보를 기다리고 있어요', '', '', '', '기관 연결을 다시 시도하거나 공연 기록을 볼 수 있어요.');
    const noShowDay = !demo && !shows.length && scheduleDay === dayKey(t);
    if (d === null) {
      const left = Math.max(1, Math.ceil(5 - (samples.length ? t - samples[0][0] : 0) / MIN));
      return result('wait', '관측 중', '출차 흐름을 확인하고 있어요', '', '', '',
        `주차 대수를 1분마다 받아 5분 변화를 계산해요. 약 ${left}분 뒤부터 안내해요. 화면을 오래 닫아 두면 처음부터 다시 모아요.`);
    }
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
    if (selectedShow?.start && t < selectedShow.start)
      return result('show', '공연 예정', '선택한 공연의 시작 시각이에요', '공연 시작', clock(selectedShow.start), '',
        '선택한 회차의 시작 시각이에요. 출차 집중 신호가 감지되면 주차 상황을 먼저 안내해요.');
    if (selectedShow && !selectedShow.end)
      return result('show', '종료 미정', '종료 시각이 공지되지 않았어요', '공연 종료', '미정', '',
        '선택한 회차의 종료 시각을 확인할 수 없어 주차장의 출차 신호를 관측하고 있어요.');
    const ends = selectedShow ? [selectedShow.end] :
      shows.filter(show => show.start && show.start <= t).map(show => show.end).filter(end => end && end < t + 4 * 60 * MIN);
    const end = ends.length ? Math.max(...ends) : null;
    const guessed = (selectedShow ? [selectedShow] : shows).some(show => show.end === end && show.endDefault);
    if (end && t < end)
      return result('show', '공연 중', '공연이 진행 중이에요', '예상 종료', (guessed ? '약 ' : '') + clock(end), '',
        guessed ? '러닝타임이 공개되지 않아 보통 공연 길이로 종료 시각을 추정했어요. 실제 출차 흐름을 보고 바로 고쳐 안내해요.' : '종료 시각은 공연 일정과 러닝타임을 기준으로 계산해요.');
    if (end && t <= end + 110 * MIN)
      return result('soon', '공연 종료 후', '곧 출차가 몰릴 수 있어요', '추천 출발', '지금', '공연 종료 후 집중 구간', '아직 대량 출차 신호가 없어요. 종료 후 흐름이 빠르게 바뀔 수 있어요.', t);
    const upcoming = shows.filter(show => show.start && show.start > t && (show.start - t < 6 * 60 * MIN || dayKey(show.start) === dayKey(t)))
      .sort((a, b) => a.start - b.start)[0];
    if (!selectedShow && upcoming)
      return result('show', '공연 전', '오늘 공연이 아직 시작 전이에요', '첫 공연 시작', clock(upcoming.start), '',
        '현재 대량 출차 신호가 없어요. 공연 중에도 주차 흐름을 계속 확인해요.');
    if (noShowDay)
      return result('calm', '평소 수준', '지금 출발하기 좋아요', '추천 출발', '지금', '',
        '오늘 등록된 공연이 없고, 최근 5분간 대량 출차 신호도 없어요. 주차 흐름을 계속 확인해요.', t);
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
    const time = demo ? source.base + minute * MIN : Date.now();
    const history = demo ? archiveSamples(minute) : liveSamples;
    const samples = continuous(history);
    const day = dayKey(time), shows = demo ? source.shows : relevantShows(liveShows, time);
    const scope = 'olpark_show_selection:' + (demo ? 'replay:' : 'live:') + day;
    if (scope !== selectionScope) {
      selectionScope = scope;
      const continued = shows.some(show => showKey(show) === selectedKey) ? selectedKey : null;
      selectedKey = cached(scope, continued);
    }
    const selectedShow = shows.find(show => showKey(show) === selectedKey) || null;
    const end = samples.at(-1)?.[0], fresh = end && time - end <= 5 * MIN;
    const drop = fresh ? dropAt(samples, end) : null;
    const onset = samples.find(s => time - s[0] <= 90 * MIN && dropAt(samples, s[0]) >= SURGE)?.[0] ?? null;
    const series = end ? rates(history, demo ? time : end) : [];
    const decision = decide(samples, time, shows, selectedShow, drop, onset);
    latestState = { demo, playing, time, minute: demo ? minute : null,
      record: { id: source.id, label: source.label, first: source.first, last: source.last, steps: source.steps }, lastOk: demo ? time : lastOk,
      schedulePending: !demo && scheduleDay !== day && !schedErr, liveErr: !demo && liveErr, schedErr: !demo && schedErr,
      shows, selectedShow, decision, series,
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
    return Math.max(source.first, Math.min(source.last, Number.isFinite(Number(value)) ? Math.round(Number(value)) : source.start));
  }
  function replay(value, day) {
    if (day === ARCHIVE_SOURCE.id) source = ARCHIVE_SOURCE;
    if (day === undefined || day === ARCHIVE_SOURCE.id) { switchMode(true); minute = position(value); emit(); return Promise.resolve(); }
    const token = ++generation;
    return loadRecord(day).catch(() => null).then(rec => {
      if (token !== generation) return;
      source = rec || ARCHIVE_SOURCE;
      switchMode(true);
      minute = position(value);
      emit();
    });
  }
  function seek(value) { if (demo) { stopPlayer(); minute = position(value); emit(); } }
  function togglePlay() {
    if (!demo) return;
    if (playing) stopPlayer();
    else {
      if (minute >= source.last) minute = source.first;
      playing = true;
      player = setInterval(() => {
        if (++minute >= source.last) stopPlayer();
        emit();
      }, 950);
    }
    emit();
  }
  function refresh() { if (!demo) { poll(); loadShows(); } }
  function selectShow(key) {
    if (!latestState || (key !== null && !latestState.shows.some(show => showKey(show) === key))) return;
    selectedKey = key;
    save(selectionScope, key);
    emit();
  }
  function live() { switchMode(false); emit(); refresh(); }
  function start() {
    if (started) return;
    started = true;
    const q = new URLSearchParams(location.search);
    if (q.has('demo')) {
      const at = /^(\d{1,2}):([0-5]\d)$/.exec(q.get('at') || '');
      const day = q.get('record') || DEFAULT_RECORD;
      if (day && day !== ARCHIVE_SOURCE.id) {
        const at2 = at ? Number(at[1]) * 60 + Number(at[2]) : undefined;
        replay(at2, day);
      } else replay(at ? Number(at[1]) * 60 + Number(at[2]) - 900 : 380);
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
  function recordDefault() { return DEFAULT_RECORD; }
  window.exitClock = { subscribe, start, live, replay, recordDefault, seek, togglePlay, refresh, selectShow, showKey, showsForDay };
})();
