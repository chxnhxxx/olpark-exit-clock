(() => {
  'use strict';

  const officialList = 'https://www.ksponco.or.kr/olympicpark/eventInfo/eventInfoListText?mid=a20301010200';
  const dayMs = 24 * 60 * 60_000;
  const today = () => new Date(Date.now() + 9 * 60 * 60_000).toISOString().slice(0, 10);
  const clock = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const dayLabel = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric', weekday: 'short' });
  const shortDate = day => dayLabel.format(Date.parse(day + 'T12:00:00+09:00'));
  const monthKey = day => day.slice(0, 7).replace('-', '');
  const venueName = name => window.parkVenues?.name(name) || String(name || '').trim();

  const dialog = document.createElement('dialog');
  dialog.id = 'calendarDialog';
  dialog.setAttribute('aria-labelledby', 'calendarTitle');
  dialog.innerHTML = `<div class="dialog-head">
      <span class="icon-tile"><svg class="ico" aria-hidden="true"><use href="#i-calendar"/></svg></span>
      <button type="button" class="close" aria-label="공연 찾기 닫기"><svg class="ico" aria-hidden="true"><use href="#i-close"/></svg></button>
    </div>
    <h2 id="calendarTitle">다른 날짜 공연 찾기</h2>
    <p class="dialog-intro">관람 날짜와 공연장을 골라 회차별 시작 시각을 확인하세요.</p>
    <div class="calendar-fields">
      <label>관람 날짜<input id="calendarDate" type="date" required></label>
      <label>공연장<select id="calendarVenue"><option value="">공연장 전체</option></select></label>
    </div>
    <p class="calendar-status" role="status"></p>
    <div class="calendar-results"></div>
    <div class="source-links"><a href="${officialList}" target="_blank" rel="noopener noreferrer">올림픽공원 공식 공연 일정 ↗</a></div>`;
  document.body.append(dialog);
  const date = dialog.querySelector('#calendarDate');
  const venue = dialog.querySelector('#calendarVenue');
  const status = dialog.querySelector('.calendar-status');
  const results = dialog.querySelector('.calendar-results');
  let months, fetched = 0, pending, loadedVenue, failed = false;

  function el(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content) node.textContent = content;
    return node;
  }

  function fillVenues(requested) {
    const available = new Set(window.parkVenues?.names || []);
    for (const rows of Object.values(months || {})) {
      if (!Array.isArray(rows)) continue;
      for (const row of rows.flat(Infinity)) {
        if (row?.plc) available.add(venueName(row.plc));
      }
    }
    if (requested) available.add(requested);
    venue.replaceChildren(new Option('공연장 전체', ''));
    for (const name of [...available].sort((a, b) => { const order = window.parkVenues.names, i = order.indexOf(a), j = order.indexOf(b); return (i < 0 ? 99 : i) - (j < 0 ? 99 : j) || a.localeCompare(b, 'ko'); })) {
      venue.add(new Option(name, name));
    }
    venue.value = requested || '';
    loadedVenue = venue.value;
  }

  function showsOn(day) {
    const rows = months[monthKey(day)];
    if (!Array.isArray(rows)) return [];
    return window.exitClock.showsForDay(rows, day);
  }

  function nextAvailable(day) {
    const keys = Object.keys(months).filter(k => /^\d{6}$/.test(k)).sort();
    // Only scan months present in the downloaded timetable.
    for (const key of keys.filter(key => key >= monthKey(day))) {
      const year = +key.slice(0, 4), month = +key.slice(4);
      const end = Date.UTC(year, month, 1);
      const start = Math.max(Date.parse(day + 'T00:00:00Z') + dayMs, Date.UTC(year, month - 1, 1));
      for (let stamp = start; stamp < end; stamp += dayMs) {
        const candidate = new Date(stamp).toISOString().slice(0, 10);
        if (showsOn(candidate).some(s => !venue.value || venueName(s.plc) === venue.value)) return candidate;
      }
    }
    return null;
  }

  function action(text, fn, extra = '') {
    const button = el('button', 'panel-link ' + extra, text);
    button.type = 'button';
    button.onclick = fn;
    return button;
  }

  function renderShow(show, day) {
    const row = el('article', 'calendar-result window-row show-copy');
    row.append(el('p', 'venue', venueName(show.plc)), el('h3', '', show.title));
    const timing = [];
    if (Number.isFinite(show.start)) timing.push(clock.format(show.start) + ' 시작');
    if (Number.isFinite(show.end)) timing.push(show.endDefault ? '약 ' + clock.format(show.end) + ' 종료 (추정)' : clock.format(show.end) + ' 종료 예상');
    row.append(el('p', 'show-time', timing.join(' · ') || '회차 시각 미확인 · 공식 일정에서 확인하세요.'));
    if (show.timeSource) row.append(el('p', 'show-source', '시작 시각 출처 · 공연예술통합전산망(KOPIS)'));
    const actions = el('div', 'calendar-actions');
    if (/^\d+$/.test(String(show.evtSeq))) {
      const link = el('a', '', '공식 상세 일정 ↗');
      link.href = 'https://www.ksponco.or.kr/olympicpark/eventInfo/eventInfoView.es?mid=a20301010100&evtSeq=' + show.evtSeq;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      actions.append(link);
    }
    if (day === today()) {
      actions.append(action('이 회차 출차 안내 보기', () => {
        if (day !== today()) { render(); return; }
        dialog.close();
        dialog.dispatchEvent(new CustomEvent('park-pick-show', { bubbles: true, detail: { show } }));
      }));
    }
    row.append(actions);
    return row;
  }

  function render() {
    results.replaceChildren();
    if (!date.value) {
      status.textContent = '관람 날짜를 선택해 주세요.';
      return;
    }
    if (failed) {
      status.textContent = '공연 일정에 연결하지 못했어요.';
      results.append(action('다시 불러오기', load));
      return;
    }
    if (!months) { status.textContent = '공연 일정을 불러오는 중이에요.'; return; }
    const day = date.value;
    const rows = months[monthKey(day)];
    if (!Object.hasOwn(months, monthKey(day))) {
      status.textContent = '아직 이 달의 일정 자료가 없어요. 공식 공연 일정을 확인해 주세요.';
      return;
    }
    if (!Array.isArray(rows)) {
      status.textContent = '이 달의 일정 자료를 읽을 수 없어요.';
      return;
    }
    const allShows = showsOn(day);
    const matches = allShows.filter(s => !venue.value || venueName(s.plc) === venue.value);
    if (!matches.length) {
      status.textContent = !allShows.length ? shortDate(day) + '에 등록된 공연이 없어요.'
        : shortDate(day) + '에는 선택한 공연장의 일정이 없어요.';
      if (allShows.length && venue.value) results.append(action('전체 공연장 보기', () => {
        venue.value = ''; loadedVenue = ''; render();
      }));
      const next = nextAvailable(day);
      if (next) results.append(action('다음 공연일 · ' + shortDate(next) + ' 보기', () => {
        date.value = next; render();
      }, 'calendar-next'));
      return;
    }
    status.textContent = shortDate(day) + ' · 공연 ' + matches.length + '회차';
    for (const show of matches) results.append(renderShow(show, day));
  }

  async function load() {
    if (pending) return pending;
    failed = false;
    status.textContent = '공연 일정을 불러오는 중이에요.';
    results.replaceChildren();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 9000);
    pending = (async () => {
      try {
        const snapshot = await window.parkSchedule.load();
        if (!snapshot.months || Array.isArray(snapshot.months) || typeof snapshot.months !== 'object') throw Error('schedule format');
        months = snapshot.months;
        fetched = Date.now();
        fillVenues(loadedVenue);
      } catch {
        failed = true;
      } finally {
        clearTimeout(timer);
        pending = null;
        render();
      }
    })();
    return pending;
  }

  function open(name = '') {
    date.value = today();
    loadedVenue = name && name !== '전체' && name !== '전체 공연장' && name !== 'all' ? venueName(name) : '';
    fillVenues(loadedVenue);
    if (!dialog.open) dialog.showModal();
    if (!months || failed || Date.now() - fetched >= 3 * 60 * 60_000) load();
    else render();
  }
  dialog.querySelector('.close').onclick = () => dialog.close();
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
  });
  date.onchange = render;
  venue.onchange = () => { loadedVenue = venue.value; render(); };
  window.parkCalendar = { open };
})();
