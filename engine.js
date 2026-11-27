/* Parking signals and the July 2024 archive. All event times are in Seoul. */
(() => {
  'use strict';

  const MIN = 60000;
  const SEOUL = 9 * 60 * MIN;
  const BASE = Date.parse('2024-07-20T15:00:00+09:00');
  const SURGE = 60;
  const CALM = 25;
  const DURATION = 45;
  // First-estimate ranges (minutes after the surge) from the 2025 backtest, leave-one-out over 98 show nights.
  // Only 우리금융아트홀 beat the shared range (inside range 7→19 of 25 nights); KSPO DOME and 올림픽홀 did
  // not (15/28 vs 19/28, 11/21 vs 13/21), so they keep the shared 30–65.
  const EXIT_RANGES = [
    { match: /우리금융/, from: 15, to: 45, note: '2025년 우리금융아트홀 공연 밤 25일 중 19일이 이 범위 안에 풀렸어요.' },
  ];
  const SHARED_RANGE = { from: 30, to: 65, note: '2025년 저녁 공연 98일 중 50일이 이 범위 안에 풀렸어요.' };
  // Queue estimate, fitted on the 2025 backtest (98 show nights, leave-one-out: inside ±17.5 min 71/98 vs 62/98
  // for the ranges above, mean error 13.9 vs 20.4 min). minutes to clear = A + P·cars parked + O·first-15-min outflow.
  // cars parked = count at the surge − the morning floor; a later show whose cars only start leaving more than
  // 65 min after the surge is taken out (its own wave comes later); one ending sooner stays in the queue.
  const QUEUE = { a: -8.6, parked: 0.0317, out15: 0.138, half: 17.5, apart: 65 };
  const DEFAULT_FLOOR = 1040; // API count around 05:00 with the lots empty (2026-11-24 02:00 probe: 1,038)
  const VENUE_WAVES = [
    { match: /KSPO/, name: 'KSPO DOME', cars: 666, lag: 40 },
    { match: /올림픽홀/, name: '올림픽홀', cars: 417, lag: 40 },
    { match: /우리금융/, name: '우리금융아트홀', cars: 166, lag: 10 },
  ];
  const OTHER_WAVE = { name: '다른 공연장', cars: 300, lag: 30 };
  let liveFloor = DEFAULT_FLOOR, activeFloor = DEFAULT_FLOOR;
  const RECONSTRUCTED_RECORD = '2025-12-06';
  const RECORDS_MAIN = 'https://raw.githubusercontent.com/chxnhxxx/olpark-exit-clock/main/records/';
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
    id: '2024-07-20', kind: 'archive', label: '2024.07.20(토) 입출차 재현', base: BASE, first: 300, last: 450, start: 380,
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
  // Fixed-date public holidays (MM-DD). Lunar holidays move every year and are not inferred.
  const HOLIDAYS = new Set(['01-01', '03-01', '05-05', '06-06', '08-15', '10-03', '10-09', '12-25']);
  // Lunar holidays, substitute holidays and election days through 2028 (fixed list, no upkeep needed).
  const HOLIDAY_DATES = new Set([
    '2026-02-16', '2026-02-17', '2026-02-18', '2026-03-02', '2026-05-24', '2026-05-25', '2026-06-03', '2026-08-17',
    '2026-09-24', '2026-09-25', '2026-09-26', '2026-10-05',
    '2027-02-06', '2027-02-07', '2027-02-08', '2027-02-09', '2027-05-13', '2027-08-16', '2027-09-14', '2027-09-15',
    '2027-09-16', '2027-10-04', '2027-10-11', '2027-12-27',
    '2028-01-26', '2028-01-27', '2028-01-28', '2028-04-12', '2028-05-02', '2028-10-02', '2028-10-04',
  ]);
  const isHoliday = day => HOLIDAYS.has(day.slice(5)) || HOLIDAY_DATES.has(day);
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
      times.push({ minute: h * 60 + minute, index: m.index, tail: m.index + m[0].length });
    }
    const slots = [];
    for (let i = 0; i < times.length; i++) {
      const a = times[i], b = times[i + 1];
      const finish = b && b.minute + (b.minute < a.minute ? 1440 : 0);
      if (b && finish > a.minute && finish - a.minute <= 12 * 60 &&
          /^\s*[~～–—-]\s*$/.test(text.slice(a.tail, b.index))) {
        slots.push({ start: a.minute, end: finish });
        i++;
      } else slots.push({ start: a.minute, end: null });
    }
    return slots;
  }

  function weeklySlots(text, day) {
    // Ranges may wrap around the end of the week. Commas can also separate two times.
    // "평일(수), (목), (금)" and "(월,화 휴관)": drop the brackets so the listed days become anchors.
    const normalized = text.replace(/\(\s*([일월화수목금토](?:요일)?(?:\s*[,·~～–-]\s*[일월화수목금토](?:요일)?)*)\s*\)/g, ' $1 ')
      .replace(/([일월화수목금토])(?:요일)?\s*[~～–-]\s*([일월화수목금토])(?:요일)?/g,
      (_, from, to) => {
        let range = from, i = DAYS.indexOf(from);
        while (DAYS[i] !== to) { i = (i + 1) % 7; range += DAYS[i]; }
        return range;
      }).replace(/([일월화수목금토])(?:요일)?\s*[,·]\s*(?=[일월화수목금토](?:요일)?(?:\s|[,·]))/g, '$1')
      // "평일 수목금" (from "평일(수), (목), (금)"): the listed days narrow 평일/주말.
      .replace(/(평일|주말)\s+(?=[월화수목금토일]+(?:요일)?(?:\s|[:：/()]))/g, '');
    const anchors = [...normalized.matchAll(/(?<![가-힣\d])(?:매주\s*)?(평일|주말|공휴일|휴일|HOL|[월화수목금토일]+)(?:요일)?(?=\s|[:：/(),·]|$)/gi)];
    if (!anchors.length) return closed.test(normalized) ? [] : timesIn(normalized);
    const weekday = DAYS[new Date(day + 'T00:00:00Z').getUTCDay()];
    const isHolidayWord = word => /^(?:공휴일|휴일|hol)$/i.test(word);
    // On a public holiday, a holiday clause replaces the weekday's own clause.
    const holiday = isHoliday(day) && anchors.some(a => isHolidayWord(a[1]));
    const clauseOf = i => normalized.slice(anchors[i].index + anchors[i][0].length, anchors[i + 1]?.index);
    const common = timesIn(normalized.slice(0, anchors[0].index));
    const slots = [];
    let matched = false;
    for (let i = 0; i < anchors.length; ++i) {
      const word = anchors[i][1];
      const hit = holiday ? isHolidayWord(word) : !isHolidayWord(word) &&
        word.replace('평일', '월화수목금').replace('주말', '토일').includes(weekday);
      if (!hit) continue;
      matched = true;
      // "주말 및 공휴일 14시", "토, 공휴일 14시": a clause with only a connector shares the next clause's times.
      let j = i, clause = clauseOf(j);
      while (/^[\s,·및와과&/]*$/.test(clause) && j + 1 < anchors.length) clause = clauseOf(++j);
      if (closed.test(clause)) return [];
      slots.push(...timesIn(clause));
    }
    return matched ? slots : common;
  }
  function sessionMinutes(item, day) {
    const text = String(item.tm || '').normalize('NFKC').trim();
    if (!text) return [null];
    const pattern = /(?<![\d:])(?:(\d{4})\s*(?:년\s*|[.\/-]\s*))?(\d{1,2})\s*(?:월\s*|[.\/]\s*)(\d{1,2})(?![\d:])\s*일?\.?\s*(?:\(\s*(?:[월화수목금토일](?:요일)?|[A-Z]{3})?\s*\)|(?:[월화수목금토일](?:요일)?|MON|TUE|WED|THU|FRI|SAT|SUN)(?=\s|\d))?/gi;
    // Expand a range whose second date omits its month.
    const normalized = text.replace(/(\d{1,2})월\s*(\d{1,2})일?\s*([~～–])\s*(\d{1,2})일/g, '$1월 $2일$3$1월 $4일');
    const anchors = [...normalized.matchAll(pattern)];
    const slotsFor = clause => {
      const slots = weeklySlots(clause, day);
      if (slots.length || closed.test(clause) || /(?:평일|주말|[월화수목금토일](?:요일)?)(?=\s|[:：/()])/.test(clause)) return slots;
      return [null]; // An event with an unspecified time can still be selected.
    };
    if (!anchors.length) return slotsFor(normalized);
    const dates = anchors.map(a => {
      let year = Number(a[1] || item.beginDt.slice(0, 4));
      if (!a[1] && item.endDt.slice(0, 4) !== item.beginDt.slice(0, 4) && +a[2] < +item.beginDt.slice(5, 7)) year++;
      const date = year + '-' + a[2].padStart(2, '0') + '-' + a[3].padStart(2, '0');
      if (date >= item.beginDt && date <= item.endDt) return date;
      // A mistyped month ("1월 15일" for an 11/13~15 run): keep the day if it fits the run's own months.
      const fix = [item.beginDt, item.endDt].map(d => d.slice(0, 8) + a[3].padStart(2, '0'))
        .find(d => d >= item.beginDt && d <= item.endDt);
      return fix || date;
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
  function sessionsFor(item, day) {
    const slots = sessionMinutes(item, day), text = String(item.tm || '');
    // KOPIS 공연시간 fills a day the official text gives no time for: an unknown time, or a weekday the
    // weekly text never mentions. Days the official text closes or lists by date stay as they are.
    const unknown = slots.length === 1 && slots[0] === null;
    const dated = /\d{1,2}\s*(?:월|[.\/])\s*\d{1,2}/.test(text);
    const unmentioned = !slots.length && !closed.test(text) && !dated;
    // The first and last day of a run always has a show, even when a weekly text skips that weekday
    // (a Monday run end on a holiday). Show it with an unknown time rather than hiding it.
    // A pure date list ("10월 10일(토) 6PM" for a 10/9~11 run) names every show day, so it is left alone.
    const weekly = /(?:^|[\s/|])(?:평일|주말|[월화수목금토일](?:요일)?)(?=\s*[,·~～-]|\s*\d)/.test(text.normalize('NFKC'));
    const edge = (!dated || weekly) && (day === item.beginDt || day === item.endDt);
    if (!item.tmKopis || !(unknown || unmentioned)) return { slots: !slots.length && edge ? [null] : slots, source: '' };
    const alt = sessionMinutes({ ...item, tm: String(item.tmKopis).replace(/HOL\s*\([^)]*\)/gi, '') }, day);
    return alt.some(Boolean) ? { slots: alt.filter(Boolean), source: '공연예술통합전산망 공연시간' } : { slots: !slots.length && edge ? [null] : slots, source: '' };
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
      // Festivals end stage by stage; a single assumed end time would hide their biggest exits.
      const festival = /페스티벌|페스타|festival|fest\b|축제/i.test(item.title) || /잔디마당|[,·]|\s및\s/.test(item.plc);
      const { slots, source: timeSource } = sessionsFor(item, day);
      for (const slot of slots) {
        const start = slot === null ? null : midnight + slot.start * MIN;
        const explicitEnd = slot?.end === null || slot?.end === undefined ? null : midnight + slot.end * MIN;
        const endBasis = explicitEnd ? '공식 일정의 종료 시각' : !published ? '일반 러닝타임 추정' :
          /^NOL티켓/.test(item.ndTmSource || '') ? 'NOL티켓의 공연 소요시간' :
          /^KOPIS/.test(item.ndTmSource || '') ? '공연예술통합전산망의 공연 소요시간' : '공식 일정의 공연 소요시간';
        const show = { evtSeq: item.evtSeq ?? null, title: item.title.normalize('NFKC').replace(/\s+/g, ' ').trim(), plc: item.plc.trim(),
          genre: item.cultureGenre || '', day, start, festival,
          end: explicitEnd ?? (start === null || (festival && !published) ? null : start + minutes * MIN),
          endBasis, endEstimated: !explicitEnd && (!published || /약|예상|내외/.test(rawDuration)),
          endDefault: !explicitEnd && !published, tm: item.tm || '', ndTm: rawDuration, timeSource };
        shows.set(showKey(show), show);
      }
    }
    return [...shows.values()].sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity) ||
      a.plc.localeCompare(b.plc, 'ko') || a.title.localeCompare(b.title, 'ko'));
  }

  async function fetchJSON(url, options = {}) {
    const { timeout = 9000, ...request } = options;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, { cache: 'no-store', ...request, signal: controller.signal });
      if (!response.ok) throw Error(String(response.status));
      return await response.json();
    } finally { clearTimeout(timer); }
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
  // A second exit wave (e.g. a later show ending) starts its own onset instead of reusing
  // the first wave's, so a stale onset can't flip the screen to "go" mid-surge.
  function waveStart(times) {
    let i = times.length - 1;
    while (i > 0 && times[i] - times[i - 1] <= 15 * MIN) --i;
    return times.length ? times[i] : null;
  }
  // Exit surges count as show traffic only from 15 min before a show's end to 150 min after.
  // false = no show near this time; null = a show today has no usable time, so don't suppress.
  function nearShow(shows, t) {
    let unknown = false;
    for (const show of shows) {
      const end = show.festival && show.end === null ? null : show.end ?? (show.start ? show.start + 120 * MIN : null);
      if (end === null) { unknown = true; continue; }
      if (t >= end - 45 * MIN && t <= end + 150 * MIN) return true;
    }
    return unknown ? null : false;
  }
  // The show behind a surge: the latest one ending between 150 min before and 15 min after it.
  function exitRange(shows, onset) {
    const show = shows.filter(x => x.end && x.end >= onset - 150 * MIN && x.end <= onset + 15 * MIN)
      .sort((a, b) => b.end - a.end)[0];
    return EXIT_RANGES.find(r => show && r.match.test(show.plc || '')) || SHARED_RANGE;
  }
  const comma = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  function queueEstimate(samples, shows, onset) {
    const s0 = sampleAt(samples, onset), s15 = sampleAt(samples, onset + 15 * MIN);
    if (activeFloor === null || !s0 || !s15) return null;
    let parked = s0[1] - activeFloor;
    const out15 = s0[1] - s15[1], notes = [];
    for (const show of shows) {
      if (!show.end || show.end <= onset) continue;
      const wave = VENUE_WAVES.find(w => w.match.test(show.plc || '')) || OTHER_WAVE;
      const leaves = show.end + wave.lag * MIN;
      if (leaves - onset > QUEUE.apart * MIN) {
        parked -= wave.cars;
        notes.push(`${wave.name} 공연 차량은 ${clock(leaves)} 이후 따로 빠질 것으로 보고 뺐어요.`);
      } else notes.push(`${wave.name} 공연이 ${clock(show.end)}쯤 끝나 그 차량도 이어서 빠져요.`);
    }
    parked = Math.max(0, parked);
    const minutes = QUEUE.a + QUEUE.parked * parked + QUEUE.out15 * out15;
    if (!(minutes > 0) || out15 < 0) return null;
    return { from: onset + Math.round(minutes - QUEUE.half) * MIN, to: onset + Math.round(minutes + QUEUE.half) * MIN,
      note: `남은 차 약 ${comma(Math.round(parked / 10) * 10)}대와 첫 15분 출차 ${comma(out15)}대로 계산했어요. ` + notes.join(' ') };
  }
  // "Cleared" uses the backtest rule exactly: 5-minute windows counted from the surge, the first one
  // that is followed by a second straight window both under CALM.
  function clearedAt(samples, onset) {
    for (let j = 1; j <= 48; j++) {
      const a = dropAt(samples, onset + 5 * j * MIN), b = dropAt(samples, onset + 5 * (j + 1) * MIN);
      if (a !== null && b !== null && a < CALM && b < CALM) return onset + 5 * j * MIN;
    }
    return null;
  }
  function archiveSamples(end) {
    const limit = source.base + end * MIN;
    return source.samples.filter(s => s[0] <= limit);
  }
  function reviewNight(samples, base, shows, floor = activeFloor) {
    const saved = activeFloor;
    activeFloor = floor;
    try { return reviewNightAt(samples, base, shows); } finally { activeFloor = saved; }
  }
  function reviewNightAt(samples, base, shows) {
    const points = [], history = [], surges = [];
    let longest = 0, previous = 779, recommendation = null, firstRange = null, firstOnset = null;
    for (const sample of samples) {
      const [time] = sample, minute = (time - base) / MIN;
      longest = Math.max(longest, minute - previous - 1);
      if (minute - previous >= 6) { history.length = 0; surges.length = 0; }
      previous = minute;
      history.push(sample);
      const drop = dropAt(history, time);
      if (drop !== null && drop >= SURGE) surges.push(time);
      while (surges.length && time - surges[0] > 90 * MIN) surges.shift();
      if (surges.length && (recommendation === null || firstRange === null)) {
        const verdict = decide(history, time, shows, null, drop, waveStart(surges), true);
        if (firstRange === null && verdict.lab === '예상 출발 범위') { firstRange = { minute, text: verdict.big }; firstOnset = waveStart(surges); }
        if (recommendation === null && verdict.tone === 'go') recommendation = minute;
      }
      points.push({ minute, drop });
    }
    const last = points.at(-1).minute;
    const cleared = firstOnset === null ? null : clearedAt(samples, firstOnset);
    return { points, longest, last, recommendation, firstRange, base, shows,
      onset: firstOnset === null ? null : (firstOnset - base) / MIN, cleared: cleared === null ? null : (cleared - base) / MIN };
  }
  async function loadRecordIndex() {
    const results = await Promise.allSettled([
      fetchJSON(RECORDS_MAIN + 'index.json', { timeout: 4000 }),
      fetchJSON('records/index.json', { timeout: 4000 }),
    ]);
    const index = results.find(result => result.status === 'fulfilled' && Array.isArray(result.value?.days));
    if (!index) throw Error('record index unavailable');
    return index.value;
  }
  function parseRecord(doc, day) {
    const kind = doc.kind === 'reconstruction' ? 'reconstruction' : 'measured';
    const base = Date.parse(day + 'T00:00:00+09:00');
    const samples = Array.from(new Map((doc.samples || []).filter(s => Array.isArray(s) && Number.isInteger(s[0]) && s[0] >= 780 && s[0] <= 1470 && Number.isSafeInteger(s[1]) && (kind === 'reconstruction' || s[1] >= 0))).entries())
      .sort((a, b) => a[0] - b[0]).map(([m, v]) => [base + m * MIN, v]);
    return { kind, base, samples };
  }
  // What the app would have shown on a night, from samples available up to each minute (used by the recorder).
  function nightLog(doc, day) {
    const { base, samples } = parseRecord(doc, day);
    if (samples.length < 6) return {};
    const review = reviewNight(samples, base, showsForDay(doc.shows || [], day),
      Number.isFinite(doc.floor) ? doc.floor : DEFAULT_FLOOR);
    const hm = m => m === null ? null : String(Math.floor(m / 60) % 24).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
    const out = {};
    if (review.onset !== null) out.onset = hm(review.onset);
    if (review.firstRange) out.firstRange = { at: hm(review.firstRange.minute), range: review.firstRange.text };
    if (review.recommendation !== null) out.confirmed = hm(review.recommendation);
    if (review.cleared !== null) out.cleared = hm(review.cleared);
    return out;
  }
  // Before the show: when each audience should start leaving and the range it should clear in, from the
  // schedule alone (end + venue's usual delay, then the venue's 2025 range). Saved ahead by the recorder.
  function nightForecast(doc, day) {
    const shows = showsForDay(doc.shows || [], day).filter(show => show.start !== null);
    return shows.map(show => {
      const wave = VENUE_WAVES.find(w => w.match.test(show.plc)) || OTHER_WAVE;
      const out = { title: show.title, plc: show.plc, start: clock(show.start), end: show.end === null ? null : clock(show.end),
        endBasis: show.end === null ? (show.festival ? '축제: 무대별 종료라 모름' : '모름') : show.endBasis };
      if (show.end === null) return out;
      const surge = show.end + wave.lag * MIN, range = exitRange([show], surge);
      return { ...out, surgeAround: clock(surge), clearRange: clock(surge + range.from * MIN) + '~' + clock(surge + range.to * MIN) };
    });
  }
  async function loadRecord(day) {
    if (!/^\d{4}-\d\d-\d\d$/.test(day || '')) return null;
    const file = day + '.json';
    const doc = day === RECONSTRUCTED_RECORD ? await fetchJSON('records/' + file)
      : await fetchJSON(RECORDS_MAIN + file, { timeout: 4000 }).catch(() => fetchJSON('records/' + file));
    const { kind, base, samples } = parseRecord(doc, day);
    if (samples.length < 30) return null;
    const minuteOf = t => Math.round((t - base) / MIN);
    const first = minuteOf(samples[0][0]), last = minuteOf(samples.at(-1)[0]);
    const onsetSample = samples.find(s => dropAt(samples, s[0]) >= SURGE);
    const onset = onsetSample ? minuteOf(onsetSample[0]) : null;
    const shows = showsForDay(doc.shows || [], day);
    const floor = kind === 'measured' ? (Number.isFinite(doc.floor) ? doc.floor : DEFAULT_FLOOR) : null;
    const review = reviewNight(samples, base, shows, floor);
    const lastEnd = Math.max(0, ...shows.map(show => show.end ? minuteOf(show.end) : 0));
    const clamp = m => Math.max(first, Math.min(last, m));
    const steps = onset === null ? [first, clamp(Math.round((first + last) / 2)), last]
      : [clamp(lastEnd ? Math.min(lastEnd - 10, onset - 1) : onset - 30), clamp(onset),
        clamp(review.recommendation ?? onset + DURATION)];
    const labels = onset === null ? ['처음', '중간', '마지막'] :
      [lastEnd > steps[0] ? '종료 전' : '감지 전', '출차 집중', review.recommendation === null ? '이후' : '첫 권장'];
    const [y, m, d] = day.split('-');
    return { id: day, kind, floor, label: `${y}.${m}.${d}(${DAYS[new Date(base + 12 * 3600000).getUTCDay()]}) ${kind === 'reconstruction' ? '입출차 재현 · 부분 자료' : '실측 기록'}`,
      base, first, last, start: onset === null ? steps[1] : clamp(onset + 15), steps, labels, samples, shows, review };
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

  function decide(samples, t, shows, selectedShow, d, onset, isReplay = demo) {
    const result = (tone, chip, head, lab, big, after, tip, go = null, alarm = false) =>
      ({ tone, chip, head, lab, big, after, tip, go, alarm, wait: alarm });
    if (!isReplay && ((lastOk && t - lastOk > 5 * MIN) || (!lastOk && liveErr)))
      return result('stale', '연결 지연', '주차 정보를 기다리고 있어요', '', '', '', '기관 연결을 다시 시도하거나 공연 기록을 볼 수 있어요.');
    const noShowDay = !isReplay && !shows.length && scheduleDay === dayKey(t);
    // Away from any show's exit window there is nothing to wait for: answer from the schedule right away.
    const quiet = d === null && (isReplay ? shows.length > 0 : scheduleDay === dayKey(t)) && nearShow(shows, t) === false;
    if (d === null && !quiet) {
      const left = Math.max(1, Math.ceil(5 - (samples.length ? t - samples[0][0] : 0) / MIN));
      if (noShowDay)
        return result('wait', '공연 없음', '오늘은 공원 안 공연이 없어요', '', '', '',
          `공연이 없어 출차가 몰릴 일은 적어요. 주차 흐름은 약 ${left}분 뒤부터 확인해 알려 드려요.`);
      return result('wait', '관측 중', '출차 흐름을 확인하고 있어요', '', '', '',
        `주차 대수를 1분마다 받아 5분 변화를 계산해요. 약 ${left}분 뒤부터 안내해요. 화면을 오래 닫아 두면 처음부터 다시 모아요.`);
    }
    const scheduleKnown = isReplay ? shows.length > 0 : scheduleDay === dayKey(t);
    // Only a one-off blip is hidden; a sustained exit (two back-to-back 5-min drops of 60+, or 300+ in 30 min)
    // is guided even without a matching show (unlisted events, shows ending early).
    const sustained = d !== null && ((dropAt(samples, t - 5 * MIN) ?? 0) >= SURGE && d >= SURGE ||
      (sampleAt(samples, t - 30 * MIN) && sampleAt(samples, t - 30 * MIN)[1] - sampleAt(samples, t)?.[1] >= 300));
    if (onset !== null && scheduleKnown && !sustained && nearShow(shows, t) === false)
      return result('calm', '공원 출차', '공연과 무관한 일시적 출차예요', '추천 출발', '지금', '',
        '이 시간 앞뒤로 끝나는 공연이 없어요. 퇴근이나 시설 마감 무렵 잠깐 늘어난 출차로 보고 혼잡으로 안내하지 않아요.', t);
    if (onset !== null) {
      let go = onset + DURATION * MIN;
      const previous = dropAt(samples, t - 2 * MIN);
      const below = previous !== null && previous < SURGE && d < SURGE;
      const settled = below && (d < CALM || (t >= go && d < SURGE * 0.6) || t >= go + 5 * MIN);
      if (d >= SURGE || (!settled && (isReplay || liveGo !== onset))) {
        const crowded = d >= SURGE;
        if (t >= go - (crowded ? 2 : 0) * MIN) go = t + (crowded ? 5 : 3) * MIN;
        if (crowded && !isReplay) liveGo = null;
        // First estimate is a range: half of 2025 show nights (50/98) eased 30–65 min after the surge began.
        const queue = t >= onset + 15 * MIN ? queueEstimate(samples, shows, onset) : null;
        const range = queue ? { from: (queue.from - onset) / MIN, to: (queue.to - onset) / MIN, note: queue.note } : exitRange(shows, onset);
        const from = Math.max(onset + range.from * MIN, t + (crowded ? 5 : 3) * MIN), to = onset + range.to * MIN;
        const ranged = to - from >= 5 * MIN;
        const head = crowded ? '조금 쉬었다 출발하세요' : '출차 흐름이 잦아들고 있어요';
        if (ranged)
          return { ...result(crowded ? 'jam' : 'easing', crowded ? '혼잡' : '완화 중', head, '예상 출발 범위',
            clock(from) + '~' + clock(to), '약 ' + Math.ceil((from - t) / MIN) + '~' + Math.ceil((to - t) / MIN) + '분 뒤',
            (queue ? '' : crowded ? '주차 대수가 빠르게 줄고 있어요. ' : '혼잡이 누그러지고 있어요. ') +
              range.note + (shows.some(x => x.festival) ? ' 축제는 무대별로 끝나 출차가 여러 번 올 수 있어요.' : '') +
              ' 실제 흐름을 보고 출발 시각을 확정해요.', go, true), range: [from, to] };
        return result(crowded ? 'jam' : 'easing', crowded ? '혼잡' : '완화 중', head, '예상 출발 시각', clock(go),
          '약 ' + Math.ceil((go - t) / MIN) + '분 뒤',
          crowded ? '평소보다 출차가 길게 이어지고 있어요. 줄어드는 속도가 잦아들 때까지 출발 시각을 늦춰 안내해요.' : '혼잡이 누그러지고 있어요. 관측값을 보고 출발 시각을 조정해요.', go, true);
      }
      if (!isReplay) liveGo = onset;
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
        guessed ? '러닝타임이 공개되지 않아 보통 공연 길이로 종료 시각을 추정했어요. 실제 출차 흐름을 보고 바로 고쳐 안내해요.' :
          `${(selectedShow || shows.find(show => show.end === end))?.endBasis || '공연 일정'}을 기준으로 안내해요.`);
    if (end && t <= end + 110 * MIN) {
      // Opened mid-exit: a surge before the screen was on can't be seen, so don't say "now" until 30 min of watching.
      const watched = samples.length ? (t - samples[0][0]) / MIN : 0;
      const parked = activeFloor === null || !samples.length ? null : samples.at(-1)[1] - activeFloor;
      if (watched < 30 && t >= end)
        return result('soon', '흐름 확인 중', '출차 흐름을 확인하고 있어요', '추천 출발', '확인 중', '',
          (parked !== null && parked >= 300 ? `주차장에 아직 약 ${comma(Math.round(parked / 10) * 10)}대가 남아 있어요. ` : '') +
          '화면을 켜기 전에 출차가 시작됐을 수 있어 바로 출발을 권하지 않아요. 몇 분만 지켜보면 알려 드려요.');
      // Turnover: a big-venue show has ended and another show starts within 3 h. Incoming evening cars hide the exits
      // in the net count (2025: 4 of 12 such days never reached the surge level while gates let out 70–100 cars per 5 min).
      const ended = shows.find(show => show.end === end);
      const turnover = !selectedShow && ended && /KSPO|올림픽홀|핸드볼|티켓링크/.test(ended.plc || '') &&
        shows.some(show => show !== ended && show.start && show.start > end - 60 * MIN && show.start <= end + 180 * MIN);
      if (turnover && t <= end + 90 * MIN)
        return result('soon', '공연 교대 시간', '출구는 실제로 더 붐빌 수 있어요', '추천 출발', '확인 중', '',
          '낮 공연이 끝나고 다음 공연 관객이 들어오는 시간이라, 주차 대수 합계로는 나가는 차가 덜 보여요. ' +
          '2025년 이런 날 12일 중 4일은 출구로 5분에 70~100대가 나가는데도 감소폭이 혼잡 기준에 못 미쳤어요. ' +
          '공연 종료 뒤 약 1시간은 출구가 붐빌 수 있어요.');
      return result('soon', '공연 종료 후', '곧 출차가 몰릴 수 있어요', '추천 출발', '지금', '공연 종료 후 집중 구간', '아직 대량 출차 신호가 없어요. 종료 후 흐름이 빠르게 바뀔 수 있어요.', t);
    }
    const upcoming = shows.filter(show => show.start && show.start > t && (show.start - t < 6 * 60 * MIN || dayKey(show.start) === dayKey(t)))
      .sort((a, b) => a.start - b.start)[0];
    if (!selectedShow && upcoming)
      return result('calm', '공연 전', '지금은 바로 출발하셔도 돼요', '추천 출발', '지금', `오늘 첫 공연 ${clock(upcoming.start)} 시작`,
        '지금은 공연이 끝나는 시간이 아니라 출차가 몰리지 않아요. 공연을 보러 온다면 남2문 주차장이 나갈 때 먼저 풀려요(2025년 공연 밤 98일 중 81일, 동2문보다 15~20분 먼저).', t);
    if (noShowDay)
      return result('calm', '공연 없음', '출차가 몰리지 않아요, 바로 출발하셔도 돼요', '추천 출발', '지금', '',
        d === null ? '오늘 공원 안 공연이 없어 출차가 몰릴 일은 적어요. 주차 흐름은 계속 확인해요.' :
          '오늘 등록된 공연이 없고, 최근 5분간 대량 출차 신호도 없어요. 주차 흐름을 계속 확인해요.', t);
    return result('calm', '평소 수준', '출차가 몰리지 않아요, 바로 출발하셔도 돼요', '추천 출발', '지금', '출차 집중 신호가 없어요',
      d === null ? '지금은 공연이 끝나는 시간이 아니라 출차가 몰리지 않아요. 주차 흐름은 계속 확인해요.' :
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
    // Stretch the 2024 curve (eased ~45 min after the surge) so it eases at the middle of the range on screen.
    const stretch = decision.range ? Math.max(0.6, Math.min(2.5, ((decision.range[0] + decision.range[1]) / 2 - onset) / MIN / DURATION)) : 1;
    const shape = minutes => pattern(minutes / stretch);
    const modeled = recent.reduce((sum, p) => sum + shape((p.t - onset) / MIN), 0);
    const observed = recent.reduce((sum, p) => sum + p.r, 0);
    const scale = modeled > 0.5 * recent.length ? Math.max(0.5, Math.min(2, observed / modeled)) : 1;
    const count = Math.ceil(Math.max(30, ((decision.range?.[1] ?? decision.go) - time) / MIN + 6));
    return Array.from({ length: count + 1 }, (_, i) => {
      const base = shape((time - onset) / MIN + i) * scale;
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
    const onset = waveStart(samples.filter(s => time - s[0] <= 90 * MIN && s[0] <= time && dropAt(samples, s[0]) >= SURGE).map(s => s[0]));
    const baseline = drop === null ? null : sampleAt(samples, end - 5 * MIN);
    const observedChange = baseline ? samples.at(-1)[1] - baseline[1] : null;
    const observedMinutes = baseline ? Math.round((end - baseline[0]) / MIN) : null;
    const series = end ? rates(history, demo ? time : end) : [];
    activeFloor = demo ? (source.floor ?? null) : liveFloor;
    const decision = decide(samples, time, shows, selectedShow, drop, onset);
    latestState = { demo, playing, time, minute: demo ? minute : null,
      review: demo ? source.review : null, record: { id: source.id, kind: source.kind, label: source.label,
        first: source.first, last: source.last, steps: source.steps, labels: source.labels }, lastOk: demo ? time : lastOk,
      schedulePending: !demo && scheduleDay !== day && !schedErr, liveErr: !demo && liveErr, schedErr: !demo && schedErr,
      shows, selectedShow, decision, series,
      forecast: predict(series, onset, decision, time), rate: fresh ? series.at(-1)?.r ?? null : null,
      drop, observedChange, observedMinutes, total: demo && source.kind === 'reconstruction' ? null : samples.at(-1)?.[1] ?? null };
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
      minute = position(value === undefined || rec ? value : value - 900);
      emit();
    });
  }
  async function replayLatest(value) {
    switchMode(true);
    const token = generation;
    const index = await loadRecordIndex().catch(() => null);
    const dates = Array.isArray(index?.days) ? index.days.filter(entry => entry?.count >= 30 &&
      /^\d{4}-\d\d-\d\d$/.test(entry.day) && entry.day > RECONSTRUCTED_RECORD).map(entry => entry.day).sort().reverse() : [];
    let record = null;
    for (const day of [...new Set([...dates, RECONSTRUCTED_RECORD])]) {
      if (token !== generation) return;
      record = await loadRecord(day).catch(() => null);
      if (record) break;
    }
    if (token !== generation) return;
    source = record || ARCHIVE_SOURCE;
    minute = position(value === undefined || record ? value : value - 900);
    emit();
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
  // On show nights the recorder publishes the last 30 one-minute counts; seeding them lets a fresh screen decide at once.
  const LIVE_FEED = 'https://api.github.com/repos/chxnhxxx/olpark-exit-clock/contents/live.json?ref=live';
  async function loadLiveFeed() {
    try {
      const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 5000);
      const r = await fetch(LIVE_FEED, { headers: { Accept: 'application/vnd.github.raw' }, cache: 'no-store', signal: ctrl.signal });
      clearTimeout(timer);
      if (!r.ok) return;
      const doc = await r.json(), now = Date.now();
      const feed = (Array.isArray(doc?.samples) ? doc.samples : []).filter(s => Array.isArray(s) && Number.isFinite(s[0]) &&
        Number.isInteger(s[1]) && s[1] >= 0 && s[0] <= now && now - s[0] < 40 * MIN);
      if (!feed.length || now - feed.at(-1)[0] > 5 * MIN) return;
      const own = new Set(liveSamples.map(s => Math.round(s[0] / MIN)));
      liveSamples = [...feed.filter(s => !own.has(Math.round(s[0] / MIN))), ...liveSamples].sort((a, b) => a[0] - b[0]);
      if (!demo) emit();
    } catch {}
  }
  function live() { switchMode(false); emit(); refresh(); loadLiveFeed(); }
  // Morning floor (lots empty) saved daily by the recorder; the API count drifts, so use a recent one.
  async function loadFloor() {
    try {
      const doc = await fetchJSON(RECORDS_MAIN + 'floor.json', { timeout: 4000 }).catch(() => fetchJSON('records/floor.json'));
      if (Number.isSafeInteger(doc?.count) && doc.count >= 0 && Date.now() - Date.parse(doc.day + 'T00:00:00+09:00') < 4 * 24 * 3600000)
        liveFloor = doc.count;
    } catch {}
  }
  function start() {
    if (started) return;
    started = true;
    const q = new URLSearchParams(location.search);
    if (q.has('demo')) {
      const at = /^(\d{1,2}):([0-5]\d)$/.exec(q.get('at') || '');
      const day = q.get('record');
      const value = at ? Number(at[1]) * 60 + Number(at[2]) : undefined;
      if (day) replay(value !== undefined && day === ARCHIVE_SOURCE.id ? value - 900 : value, day);
      else replayLatest(value);
    } else live();
    loadFloor();
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
  window.exitClock = { nightLog, nightForecast, subscribe, start, live, replay, replayLatest, seek, togglePlay, refresh, selectShow, showKey, showsForDay, loadRecordIndex };
})();
