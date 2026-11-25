/* Revisit the latest past performances using their published schedules in Seoul time. */
(() => {
  'use strict';

  const dashboard = document.querySelector('.dashboard');
  if (!dashboard) return;

  const MIN = 60_000;
  const DAY = 24 * 60 * MIN;
  const kstDay = ms => new Date(ms + 9 * 60 * MIN).toISOString().slice(0, 10);
  const formatClock = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  });
  const formatDay = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: 'long', day: 'numeric', weekday: 'short'
  });
  const clock = time => Number.isFinite(time) ? formatClock.format(time) : '시각 미공개';
  const dayText = day => formatDay.format(Date.parse(day + 'T12:00:00+09:00'));
  const venue = show => window.parkVenues?.name(show.plc) || show.plc;
  const icon = id => '<svg class="ico" aria-hidden="true"><use href="#i-' + id + '"/></svg>';

  const section = document.createElement('section');
  section.id = 'recent';
  section.className = 'panel recent-panel';
  section.setAttribute('aria-labelledby', 'recent-title');
  section.innerHTML = `
    <div class="panel-title">
      <div class="panel-heading"><span class="icon-tile">${icon('clock')}</span><h2 id="recent-title">최근 공연 다시보기</h2></div>
      <span class="recent-kind">일정 기준</span>
    </div>
    <p class="recent-loading" role="status">최근 공연 일정을 찾고 있어요.</p>
    <button type="button" class="recent-retry panel-link" hidden>다시 불러오기</button>
    <div class="recent-content" hidden>
      <div class="recent-show">
        <p class="recent-meta"></p>
        <h3></h3>
        <label class="recent-choice" hidden>이날의 다른 회차<select></select></label>
        <a class="recent-official" target="_blank" rel="noopener noreferrer">공식 공연 일정 ↗</a>
      </div>
      <div class="recent-playback">
        <div class="recent-stage-line"><div><p class="recent-label"></p><strong class="recent-time"></strong></div>
          <button type="button" class="recent-play" aria-pressed="false"></button>
        </div>
        <div class="recent-steps" role="group" aria-label="공연 타임라인 장면"></div>
        <p class="recent-copy"></p>
      </div>
      <p class="recent-note">이날의 주차 실측 기록은 없어요. 혼잡 예상 구간은 2024년 공연 밤의 출차 흐름을 참고했어요.</p>
      <button type="button" class="recent-measured panel-link" hidden>이날 실측 기록으로 출차 흐름 재생</button>
    </div>`;
  dashboard.after(section);

  const styles = document.createElement('style');
  styles.textContent = `
    .recent-panel{margin-top:18px;padding:24px 26px}
    .recent-kind{font-size:13px;font-weight:650;color:var(--green);white-space:nowrap;background:var(--soft);padding:4px 10px;border-radius:20px}
    .recent-content{display:grid;grid-template-columns:minmax(210px,.88fr) minmax(0,1.3fr);column-gap:32px;align-items:start;margin-top:23px}
    .recent-meta,.recent-label,.recent-copy,.recent-note,.recent-loading{color:var(--muted)}
    .recent-meta,.recent-label,.recent-official{font-size:14px;font-weight:600}
    .recent-show h3{font-size:clamp(20px,2.4vw,28px);line-height:1.35;margin:7px 0 12px;overflow-wrap:anywhere}
    .recent-official{color:var(--green);text-decoration:underline;text-underline-offset:4px;display:inline-block;padding:7px 0}
    .recent-choice{display:block;font-size:14px;color:var(--muted);margin:8px 0}
    .recent-choice select{display:block;width:100%;max-width:100%;margin-top:5px;min-height:44px;font:inherit;color:var(--ink);background:var(--panel);border:1px solid var(--stroke);border-radius:8px;padding:6px}
    .recent-stage-line,.recent-play{display:flex;align-items:center}
    .recent-stage-line{justify-content:space-between;gap:12px}
    .recent-time{font-variant-numeric:tabular-nums;font-size:clamp(23px,3vw,32px);letter-spacing:-.04em;line-height:1.3}
    .recent-play{gap:6px;min-height:44px;padding:6px 12px;background:var(--soft);color:var(--green);font-size:14px;font-weight:650;border-radius:8px;flex-shrink:0}
    .recent-play .ico{width:15px;height:15px}
    .recent-steps{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:5px;margin-top:15px}
    .recent-steps button{position:relative;min-height:44px;padding:11px 1px 3px;color:var(--muted);font-size:14px;text-align:start;border-radius:2px}
    .recent-steps button::before{content:'';position:absolute;inset:0 0 auto;height:5px;border-radius:3px;background:var(--line)}
    .recent-steps button[aria-pressed="true"]{color:var(--green);font-weight:750}
    .recent-steps button[aria-pressed="true"]::before{background:var(--green)}
    .recent-copy{margin-top:5px;font-size:15px;line-height:1.55}
    .recent-note{grid-column:1/-1;margin-top:18px;border-top:1px solid var(--line);padding-top:12px;font-size:14px;line-height:1.55}
    .recent-measured{grid-column:1/-1;justify-self:start;margin-top:8px;width:auto;min-height:44px;padding:8px 14px;background:var(--green2);color:#fff;border-radius:8px;font-weight:650}
    .recent-loading{margin-top:14px}.recent-retry{margin-top:10px;width:auto}
    @media(max-width:740px){.recent-panel{padding:20px;margin-top:14px}.recent-content{grid-template-columns:minmax(0,1fr);gap:15px;margin-top:16px}.recent-playback{border-top:1px solid var(--line);padding-top:14px}.recent-show h3{margin-bottom:3px}.recent-note{margin-top:0}.recent-kind{font-size:12px}}
    @media(max-width:480px){.recent-panel{padding:18px}.recent-panel .panel-title{gap:6px}.recent-panel .icon-tile{flex:none}.recent-choice{margin-top:12px}.recent-steps button{font-size:13px}}
  `;
  document.head.append(styles);

  const q = selector => section.querySelector(selector);
  const select = q('select');
  const steps = ['공연 전', '시작', '종료 예정', '종료 후'];
  let performances = [], stage = 1, timer, loading = false, loadDay = '', nextEnd = Infinity;
  function findLatest(months, time) {
    const today = kstDay(time);
    const ceiling = Date.parse(today + 'T00:00:00Z');
    let next = Infinity;
    for (const key of Object.keys(months).filter(k => /^\d{4}(?:0[1-9]|1[0-2])$/.test(k)).sort().reverse()) {
      if (!Array.isArray(months[key])) continue;
      const year = +key.slice(0, 4), month = +key.slice(4);
      const first = Date.UTC(year, month - 1, 1), last = Date.UTC(year, month, 0);
      for (let d = Math.min(last, ceiling); d >= first; d -= DAY) {
        const day = new Date(d).toISOString().slice(0, 10);
        const sessions = window.exitClock.showsForDay(months[key], day);
        // A past date can still be replayed when the organiser omitted its running time.
        // On today's date only a supplied end estimate qualifies the session.
        const ended = sessions.filter(show => Number.isFinite(show.end) ? show.end <= time : day < today);
        for (const show of sessions) if (show.end > time) next = Math.min(next, show.end);
        if (ended.length) {
          ended.sort((a, b) => (b.end ?? b.start ?? 0) - (a.end ?? a.start ?? 0));
          return { ended, next };
        }
      }
    }
    return { ended: [], next };
  }

  function stageContent(show) {
    const start = Number.isFinite(show.start), end = Number.isFinite(show.end);
    return [
      ['시작 30분 전', start ? clock(show.start - 30 * MIN) : '공연 전', '공연장 입장 전을 기준으로 잡은 장면이에요.'],
      ['공식 시작 시각', clock(show.start), start ? '공식 공연 일정에 안내된 시작 시각이에요.' : '공식 일정에 회차별 시작 시각이 공개되지 않았어요.'],
      ['공연 종료 예정', end ? clock(show.end) : '시각 미공개', end ? '공식 시작 시각에 안내된 공연 소요 시간을 더했어요. 실제 종료 시각은 달라질 수 있어요.' : '공식 일정에 종료 시각을 계산할 정보가 없어, 다음 장면은 종료 후 경과 시간으로 보여드려요.'],
      ['혼잡 예상 구간', end ? clock(show.end + 30 * MIN) + '–' + clock(show.end + 90 * MIN) : '종료 후 30~90분', '이전 공연 밤에는 종료 후 30~90분 사이에 출차가 몰리는 경향이 있었어요.']
    ][stage];
  }

  function renderStage() {
    const show = performances[select.selectedIndex];
    if (!show) return;
    const [label, time, description] = stageContent(show);
    q('.recent-label').textContent = label;
    q('.recent-time').textContent = time;
    q('.recent-copy').textContent = description;
    [...q('.recent-steps').children].forEach((button, i) => button.setAttribute('aria-pressed', String(stage === i)));
    const play = q('.recent-play');
    play.innerHTML = icon(timer ? 'pause' : 'play') + (timer ? '일시정지' : '재생');
    play.setAttribute('aria-label', timer ? '공연 타임라인 일시정지' : '공연 타임라인 재생');
    play.setAttribute('aria-pressed', String(Boolean(timer)));
  }
  function pause() {
    clearInterval(timer);
    timer = undefined;
  }
  let recordDays = null;
  async function recordIndex() {
    if (recordDays) return recordDays;
    try {
      const r = await fetch('records/index.json', { cache: 'no-cache' });
      recordDays = r.ok ? new Set(((await r.json()).days || []).filter(d => d.count >= 30).map(d => d.day)) : new Set();
    } catch { recordDays = new Set(); }
    return recordDays;
  }
  function renderMeasured(show) {
    const has = recordDays?.has(show.day);
    q('.recent-measured').hidden = !has;
    q('.recent-note').textContent = has
      ? '이날 공연 밤에 1분 간격으로 저장한 주차 실측 기록이 있어요. 아래 버튼으로 그날의 출차 흐름과 출발 안내를 다시 볼 수 있어요.'
      : '이날의 주차 실측 기록은 없어요. 혼잡 예상 구간은 2024년 공연 밤의 출차 흐름을 참고했어요.';
  }
  q('.recent-measured').addEventListener('click', () => {
    const show = performances[select.selectedIndex];
    if (!show || !window.exitClock) return;
    const url = new URL(location.href);
    url.searchParams.set('demo', '1'); url.searchParams.set('record', show.day); url.searchParams.delete('at');
    try { history.replaceState(null, '', url); } catch {}
    window.exitClock.replay(undefined, show.day).then(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
  });
  function renderShow() {
    const show = performances[select.selectedIndex];
    renderMeasured(show);
    q('.recent-meta').textContent = dayText(show.day) + ' · ' + venue(show);
    q('h3').textContent = show.title;
    const link = q('.recent-official');
    link.href = /^\d+$/.test(String(show.evtSeq))
      ? 'https://www.ksponco.or.kr/olympicpark/eventInfo/eventInfoView.es?mid=a20301010100&evtSeq=' + show.evtSeq
      : 'https://www.ksponco.or.kr/olympicpark/eventInfo/eventInfoListText?mid=a20301010200';
    renderStage();
  }

  for (const [index, text] of steps.entries()) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = text;
    button.addEventListener('click', () => { pause(); stage = index; renderStage(); });
    q('.recent-steps').append(button);
  }
  select.addEventListener('change', () => { pause(); stage = 1; renderShow(); });
  q('.recent-play').addEventListener('click', () => {
    if (timer) pause();
    else {
      if (stage === steps.length - 1) stage = 0;
      timer = setInterval(() => {
        ++stage;
        if (stage === steps.length - 1) pause();
        renderStage();
      }, 3200);
    }
    renderStage();
  });

  async function load() {
    if (loading) return;
    loading = true;
    pause();
    const status = q('.recent-loading'), retry = q('.recent-retry');
    status.hidden = false;
    status.textContent = '최근 공연 일정을 찾고 있어요.';
    retry.hidden = true;
    try {
      const [{ months }] = await Promise.all([window.parkSchedule.load(), recordIndex()]);
      const now = Date.now();
      const { ended, next } = findLatest(months, now);
      performances = ended;
      loadDay = kstDay(now);
      nextEnd = next;
      if (!ended.length) {
        q('.recent-content').hidden = true;
        status.textContent = '불러온 일정에 지난 공연 회차가 아직 없어요.';
        return;
      }
      select.replaceChildren(...ended.map((show, i) => new Option([clock(show.start), venue(show), show.title].join(' · '), i)));
      select.selectedIndex = 0;
      q('.recent-choice').hidden = ended.length < 2;
      stage = 1;
      renderShow();
      status.hidden = true;
      q('.recent-content').hidden = false;
    } catch {
      status.textContent = '최근 공연 일정을 불러오지 못했어요.';
      retry.hidden = false;
    } finally { loading = false; }
  }
  q('.recent-retry').addEventListener('click', load);
  function refreshIfDue() {
    if (document.hidden) { pause(); renderStage(); return; }
    if (loadDay && (loadDay !== kstDay(Date.now()) || Date.now() >= nextEnd)) load();
  }
  document.addEventListener('visibilitychange', refreshIfDue);
  setInterval(refreshIfDue, MIN);
  load();
})();
