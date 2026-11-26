(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const clock = window.exitClock;
  const minute = 60000;
  const clockFormat = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const dateFormat = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
  const time = value => clockFormat.format(value);
  let current, scheduleKey, armed = false, audioContext, wakeLock, installRequest;
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    node.className = cls;
    node.textContent = text || '';
    return node;
  };

  const domeArt = '<path d="M4 45h56M8 43v-9c4-12 15-19 24-19 9 0 20 7 24 19v9M7 34h50M15 33c3-9 10-16 17-18m0 0c8 3 13 8 17 18m-26 0 9-18 8 18M13 38h38m-36 1v4m8-4v4m8-4v4m8-4v4m8-4v4"/><circle cx="47" cy="14" r="3" fill="currentColor" stroke="none"/>';
  const hallArt = '<path d="M4 46h56M8 42V31l18-8 29 5v14M8 31l19 2 28-5m-28 5v9M15 32v9m6-9v9m13-8v7m7-8v8m7-10v9M6 30l19-12 32 8-2 2M19 23v-5l5-2v4"/><path d="M45 15h7m-3.5-3.5v7" opacity=".75"/>';
  function venueArt(dome) {
    const tile = el('div', 'venue-art ' + (dome ? 'dome' : 'hall'));
    tile.setAttribute('aria-hidden', 'true');
    tile.innerHTML = '<svg viewBox="0 0 64 60" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round">' + (dome ? domeArt : hallArt) + '</svg>';
    return tile;
  }

  const venueName = window.parkVenues.name;
  let venue = '', scope = '', pendingShow = null;
  const scopeOf = s => (s.demo ? 'record:' : 'live:') + new Date(s.time + 9 * 3600000).toISOString().slice(0, 10);
  function chooseVenue(name) {
    venue = name;
    try { localStorage.setItem('olpark_visit_venue_' + (current.demo ? 'record' : 'live'), JSON.stringify({scope, venue})); } catch {}
  }
  function syncVenue(s) {
    const next = scopeOf(s);
    if (next !== scope) {
      scope = next;
      venue = '';
      try {
        const saved = JSON.parse(localStorage.getItem('olpark_visit_venue_' + (s.demo ? 'record' : 'live')));
        if (saved?.scope === scope && typeof saved.venue === 'string') venue = saved.venue;
      } catch {}
    }
    if (s.selectedShow) venue = venueName(s.selectedShow.plc);
  }
  function pick(show) {
    chooseVenue(venueName(show.plc));
    clock.selectShow(clock.showKey(show));
    render(current);
  }
  function slot(show) {
    return show.start ? time(show.start) + (show.end ? ' – ' + (show.endDefault ? '약 ' + time(show.end) + ' 종료 (추정)' : time(show.end) + ' 예정') : ' 시작 · 종료 미정') : '시작·종료 시각 미정';
  }
  function windowText(show) {
    return show.end ? time(show.end + 30 * minute) + ' – ' + time(show.end + 90 * minute) : '종료 시각 확인 후 안내';
  }
  function addWindow(box, show) {
    const row = el('div', 'window-row');
    row.append(el('strong', '', show.title), el('span', '', venueName(show.plc) + ' · ' + slot(show)),
      el('span', 'window-forecast', (show.end ? '혼잡 예상 ' : '') + windowText(show)));
    box.append(row);
  }
  function renderShows(s) {
    const key = JSON.stringify([scope, venue, s.selectedShow, s.shows, s.schedulePending, s.schedErr]);
    if (key === scheduleKey) return;
    scheduleKey = key;
    const selected = s.selectedShow;
    const shows = s.demo ? [...s.shows].sort((a,b) => b.end-a.end) : s.shows;
    const available = [...new Set(shows.map(show => venueName(show.plc)))];
    const options = [...new Set([...available, ...window.parkVenues.names, ...(venue ? [venue] : [])])];
    const atVenue = venue ? shows.filter(show => venueName(show.plc) === venue) : shows;
    const source = s.demo ? '이 기록' : '오늘 일정';
    $('venueSelect').replaceChildren(new Option('공연장 전체', ''), ...options.map(name => new Option(name, name)));
    $('venueSelect').value = venue;
    const placeholder = s.schedulePending ? '일정 확인 중' : atVenue.length ? '모든 회차' : '등록된 회차 없음';
    $('showSelect').replaceChildren(new Option(placeholder, ''), ...atVenue.map(show =>
      new Option((show.start ? time(show.start) + '  ' : '') + show.title, clock.showKey(show))));
    $('showSelect').disabled = !atVenue.length;
    $('showSelect').value = selected ? clock.showKey(selected) : '';
    const rows = selected ? [selected] : atVenue;
    const list = $('shows'), windows = $('windows');
    list.replaceChildren();
    windows.replaceChildren();
    $('showTitle').textContent = selected ? '내 공연 일정' : venue ? '공연장 일정' : s.demo ? '그날의 공연' : '오늘의 공연';
    $('showCount').hidden = !rows.length;
    $('showCount').textContent = rows.length + '회';
    $('scheduleRetry').hidden = !s.schedErr;
    $('scheduleHelp').hidden = !rows.some(show => show.end);
    if (!rows.length) {
      const empty = el('div', 'empty');
      empty.append(el('b', '', s.schedulePending ? '일정을 확인하고 있어요' : s.schedErr ? '공연 일정을 받지 못했어요' : venue ? venue : '등록된 공연이 없어요'));
      empty.append(document.createTextNode(s.schedulePending ? '공연 일정이 도착하면 회차를 고를 수 있어요.' : s.schedErr ? '다시 확인하거나 공식 일정을 확인해 주세요.' : source + '에 ' + (venue ? '이 공연장의 ' : '') + '공연이 등록되어 있지 않아요.'));
      const button = el('button', 'text-action', '다른 날짜의 공연 찾기');
      button.onclick = () => window.parkCalendar.open(venue);
      empty.append(button);
      list.append(empty);
      return;
    }
    for (const show of rows) {
      const name = venueName(show.plc);
      const row = el(selected ? 'article' : 'button', 'show-item show-choice');
      const copy = el('div', 'show-copy');
      copy.append(el('p', 'venue', [name, show.genre].filter(Boolean).join(' · ')), el('h3', '', show.title), el('p', 'show-time', slot(show)));
      row.append(venueArt(name === 'KSPO DOME'), copy);
      if (!selected) {
        row.append(el('span', 'pick-hint', '선택'));
        row.setAttribute('aria-label', [name,show.title,slot(show),'선택'].join(' '));
        row.onclick = () => { pick(show); $('showSelect').focus({preventScroll:true}); };
      }
      list.append(row);
      addWindow(windows, show);
    }
    if (selected) {
      const details = el('div','visit-detail');
      details.append(el('span','detail-caption','내 회차 종료 후 혼잡 예상'), el('strong','',windowText(selected)));
      let text = selected.end ? '종료 예정 시각에서 30~90분 뒤예요.' : '공식 일정에 종료 시각이나 공연 시간이 필요해요.';
      const overlaps = shows.filter(other => other.end && selected.end && clock.showKey(other) !== clock.showKey(selected)
        && Math.abs(other.end - selected.end) < 60 * minute);
      if (overlaps.length) {
        const others = [...new Set(overlaps.map(show => venueName(show.plc)))].join(' · ');
        text = others + '의 다른 회차와 혼잡 예상 시간이 겹쳐요.';
      }
      details.append(el('p','',text));
      list.append(details);
      if (/^\d+$/.test(String(selected.evtSeq || ''))) {
        const link = el('a','text-action','공식 공연 상세 보기 ↗');
        link.href = 'https://www.ksponco.or.kr/olympicpark/eventInfo/eventInfoView.es?mid=a20301010100&evtSeq=' + selected.evtSeq;
        link.target='_blank'; link.rel='noopener'; list.append(link);
      }
      const clear = el('button','text-action', '선택 해제 · 전체 보기');
      clear.onclick = () => { chooseVenue(''); clock.selectShow(null); render(current); $('venueSelect').focus({preventScroll:true}); };
      list.append(clear);
    }
    if (s.schedErr) list.append(el('p', 'chart-note', '최근 저장한 일정이에요.'));
  }

  $('venueSelect').onchange = event => {
    const value = event.target.value;
    chooseVenue(value);
    const matching = current.shows.filter(show => venueName(show.plc) === value);
    clock.selectShow(value && matching.length === 1 ? clock.showKey(matching[0]) : null);
    render(current);
  };
  $('showSelect').onchange = event => {
    const selected = current.shows.find(show => clock.showKey(show) === event.target.value);
    if (selected) pick(selected);
    else { clock.selectShow(null); render(current); }
  };
  document.addEventListener('park-pick-show', event => {
    pendingShow = event.detail.show;
    if (current.demo) { changeUrl(false); clock.live(); }
    else render(current);
  });

  function changeUrl(demo) {
    const url = new URL(location.href);
    url.searchParams.delete('at');
    if (demo) url.searchParams.set('demo', '1');
    else url.searchParams.delete('demo');
    try { history.replaceState(null, '', url); } catch { /* Direct file previews may limit history. */ }
  }

  function setAlarm(active) {
    armed = active;
    $('alarm').setAttribute('aria-pressed', String(active));
    $('alarm').querySelector('span').textContent = active ? '알림 켜짐 · 끄기' : '출발 알림 켜기';
    if (!active && wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  }
  async function keepAwake() {
    if (!armed || !navigator.wakeLock || document.hidden) return;
    try {
      const lock = await navigator.wakeLock.request('screen');
      if (armed) wakeLock = lock; else await lock.release();
    } catch { /* Alerts still work while the screen is awake. */ }
  }
  function ring() {
    setAlarm(false);
    $('announce').textContent = '출발 알림. 지금 출발하기 좋아요.';
    navigator.vibrate?.([250, 120, 250]);
    if (!audioContext || audioContext.state !== 'running') return;
    for (const delay of [0, 0.36]) {
      const oscillator = audioContext.createOscillator(), gain = audioContext.createGain();
      const start = audioContext.currentTime + delay;
      oscillator.frequency.value = 740;
      gain.gain.setValueAtTime(0.001, start);
      gain.gain.exponentialRampToValueAtTime(0.14, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.28);
      oscillator.connect(gain).connect(audioContext.destination);
      oscillator.start(start); oscillator.stop(start + 0.3);
    }
  }
  $('alarm').onclick = () => {
    setAlarm(!armed);
    if (armed) {
      try {
        const Audio = window.AudioContext || window.webkitAudioContext;
        if (Audio && !audioContext) audioContext = new Audio();
        audioContext?.resume().catch(() => {});
      } catch { /* Vibration can be available without audio. */ }
      keepAwake();
      $('announce').textContent = '출발 알림을 켰어요. 이 화면을 켜 두세요.';
    }
    render(current);
  };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) keepAwake(); });

  let displayedReview;
  function renderReview(review) {
    if (displayedReview === review) return;
    displayedReview = review;
    $('nightReview').hidden = !review;
    const box = $('nightEvidence');
    box.replaceChildren();
    if (!review) return;
    const {points, longest, last, recommendation, shows, base} = review;
    const stamp = m => (m >= 1440 ? '다음 날 ' : '') + [Math.floor(m / 60) % 24, m % 60].map(n => String(n).padStart(2, '0')).join(':');
    const add = text => box.append(el('p', 'chart-note', text));
    add('동2·남2·북2문 주차장 합계 · 수집 ' + points.length + ' / 예정 691분 · 마지막 관측 ' + stamp(last));
    add('13:00부터 마지막 관측까지 가장 긴 누락 ' + longest + '분 · 수집 예정 종료 다음 날 00:30');
    const at = m => points.find(p => p.minute === m)?.drop;
    const measure = m => at(m) == null ? '관측 부족' : at(m) + '대';
    const markers = [];
    for (const show of shows) {
      for (const [label, time] of [['시작', show.start], ['종료 예상', show.end]]) {
        if (Number.isFinite(time)) markers.push({minute:(time-base)/60000, label:show.plc + ' · ' + show.title + ' ' + label});
      }
    }
    if (recommendation !== null) markers.push({minute:recommendation,label:'혼잡 감지 후 첫 출발 권장'});
    const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.setAttribute('viewBox','0 0 600 130');
    svg.setAttribute('role','img');
    svg.setAttribute('aria-label','13시부터 다음 날 0시 30분까지의 5분 순감소. 세로선은 공연 일정과 첫 권장 시각이며 빈 구간은 관측 부족입니다.');
    const x = m => 6 + (m-780)/690*588;
    const valid = points.filter(p => p.drop !== null);
    const low = Math.min(0,...valid.map(p => p.drop)), high = Math.max(60,...valid.map(p => p.drop));
    const y = v => 115 - (v-low)/(high-low)*105;
    function path(d,color,width,dash) {
      const node = document.createElementNS(svg.namespaceURI,'path');
      node.setAttribute('d',d); node.setAttribute('fill','none'); node.setAttribute('stroke',color);
      node.setAttribute('stroke-width',width);
      if (dash) node.setAttribute('stroke-dasharray',dash);
      svg.append(node);
    }
    path('M6 '+y(60)+' H594','var(--muted)',1,'5 4');
    let line = '', prev = null;
    for (const p of valid) {
      line += (p.minute === prev+1 ? ' L' : ' M') + x(p.minute) + ' ' + y(p.drop);
      prev = p.minute;
    }
    path(line,'var(--green)',2);
    for (const marker of markers.filter(m => m.minute >= 780 && m.minute <= 1470)) {
      path('M'+x(marker.minute)+' 5 V120',marker.minute === recommendation ? 'var(--green)' : 'var(--muted)',1.5,'2 3');
    }
    box.append(svg);
    add('13:00 → 다음 날 00:30 · 실선은 5분 순감소, 가로 점선은 혼잡 기준 60대예요. 아래 시각을 누르면 해당 장면으로 이동해요.');
    const timeline = document.createElement('ol');
    for (const marker of markers.sort((a,b) => a.minute-b.minute)) {
      const li = document.createElement('li');
      const button = el('button','panel-link',stamp(marker.minute) + ' · ' + marker.label);
      button.type = 'button';
      button.disabled = marker.minute < points[0].minute || marker.minute > last;
      button.addEventListener('click', () => clock.seek(marker.minute));
      li.append(button); timeline.append(li);
    }
    box.append(timeline);
    if (recommendation === null) { add('관측 구간에서 혼잡 감지 후 출발 권장으로 바뀐 시점이 없어요.'); return; }
    add('첫 권장 전후의 5분 순감소 · 5분 전 ' + measure(recommendation-5) + ' / 권장 시점 ' + measure(recommendation) + ' / 5분 뒤 ' + measure(recommendation+5));
    const again = points.find(p => p.minute > recommendation && p.drop >= 60);
    add(again ? '이후 혼잡 신호가 다시 관측된 시각 ' + stamp(again.minute) : '이후 유효한 관측값에서 혼잡 신호가 다시 나타나지 않았어요.');
    add('권장 시각은 해당 분까지의 기록으로 재현했어요. 실제 차량별 대기시간은 측정하지 않아요.');
  }
  function render(s) {
    renderReview(s.review);
    const previous = current, d = s.decision;
    current = s;
    syncVenue(s);
    if (pendingShow && !s.demo && !s.schedulePending) {
      const wanted = pendingShow;
      pendingShow = null;
      const todayShow = s.shows.find(show => clock.showKey(show) === clock.showKey(wanted));
      if (todayShow) { pick(todayShow); return; }
      $('announce').textContent = '오늘 일정에서 해당 회차를 찾을 수 없어요.';
    }
    if (armed && !s.demo && d.tone === 'go') ring();
    if (armed && (s.demo || !d.alarm && d.tone !== 'wait' && d.tone !== 'stale')) setAlarm(false);
    $('hero').dataset.tone = d.tone;
    $('advice').textContent = d.head;
    $('statusText').textContent = d.chip;
    $('sourceText').textContent = (s.demo ? (s.record.id.startsWith('2024') ? '공연 기록 재현' : '공연 밤 실측 재생') : '실시간 주차현황') + ' · 세 주차장 합산';
    $('dateText').textContent = dateFormat.format(s.time);
    const hasTime = !!d.big;
    $('timeLabel').textContent = hasTime ? (s.selectedShow && d.lab === '예상 종료' ? '내 공연 종료 예정' : d.lab) : '예상 출발 시각';
    const approx = /^약 (\d{1,2}:\d\d)$/.exec(d.big || '');
    if (approx) $('goTime').replaceChildren(el('span', 'approx', '약'), approx[1]);
    else $('goTime').textContent = d.big || '확인 중';
    $('goTime').parentNode.classList.toggle('text-time', !d.big || !(approx || /^\d/.test(d.big)));
    $('remaining').hidden = !d.after || !/^약/.test(d.after);
    $('remaining').textContent = d.after || '';
    $('heroTip').textContent = armed ? '출발 알림이 켜져 있어요. 이 화면을 켜 두세요.' : d.tip;
    $('fresh').textContent = s.demo ? time(s.time) + ' 기록 기준' : s.lastOk ? time(s.lastOk) + ' 마지막 수신' + (s.liveErr ? ' · 연결 재시도 중' : '') : s.liveErr ? '기관 API 연결 지연' : '기관 데이터 수신 중';
    $('alarm').hidden = s.demo || (!d.alarm && !armed);
    $('retry').hidden = s.demo || !s.liveErr && d.tone !== 'stale';
    $('demoMode').setAttribute('aria-pressed', String(s.demo));
    $('liveMode').setAttribute('aria-pressed', String(!s.demo));
    $('replay').hidden = !s.demo;
    if (s.demo) {
      const rec = s.record;
      if ($('seek').dataset.record !== rec.id) {
        $('seek').dataset.record = rec.id;
        $('seek').min = rec.first; $('seek').max = rec.last;
        document.querySelector('.replay-heading p').textContent = rec.label;
        const ticks = document.querySelectorAll('.replay .ticks span');
        ticks[0].textContent = time(s.time - (s.minute - rec.first) * 60000) + '부터';
        ticks[1].textContent = time(s.time + (rec.last - s.minute) * 60000) + '까지';
        document.querySelectorAll('[data-minute]').forEach((btn, i) => { btn.dataset.minute = rec.steps[i]; });
      }
      $('seek').value = s.minute;
      $('seek').setAttribute('aria-valuetext', time(s.time));
      $('seek').style.setProperty('--position', (s.minute - rec.first) / Math.max(1, rec.last - rec.first) * 100 + '%');
      $('replayNow').textContent = time(s.time);
      $('play').setAttribute('aria-label', s.playing ? '기록 일시정지' : '기록 재생');
      $('play').querySelector('use').setAttribute('href', s.playing ? '#i-pause' : '#i-play');
      document.querySelectorAll('[data-minute]').forEach(btn => btn.setAttribute('aria-pressed', String(+btn.dataset.minute === s.minute)));
    }
    renderShows(s);
    const change = s.observedChange;
    $('changeLabel').textContent = '최근 약 ' + (s.observedMinutes ?? 5) + '분 주차 대수 변화';
    $('rate').textContent = change === null ? '—' : String(Math.abs(change));
    $('changeUnit').textContent = change === null ? '관측 중' : change === 0 ? '대 변화' : change < 0 ? '대 감소' : '대 증가';
    $('pastLabel').textContent = s.demo ? '기록 재현' : '관측값';
    $('forecastLegend').hidden = !s.forecast.length;
    $('chartNote').textContent = '동2·남2·북2문 합계 · 입차와 출차가 함께 반영돼요. 그래프 단위는 대/분이에요.' + (s.forecast.length ? ' 점선은 예상값이에요.' : '');
    window.renderExitChart({ element: $('flowChart'), series: s.series, forecast: s.forecast, now: s.time, go: d.go, demo: s.demo });
    if (previous && previous.decision.tone !== d.tone) $('announce').textContent = d.head + '. ' + d.lab + ' ' + d.big;
  }

  $('liveMode').onclick = () => { if (current?.demo) { changeUrl(false); clock.live(); } };
  $('demoMode').onclick = () => { if (!current?.demo) { changeUrl(true); clock.replay(undefined, clock.recordDefault() || '2024-07-20'); } };
  $('retry').onclick = clock.refresh;
  $('play').onclick = clock.togglePlay;
  $('seek').oninput = event => clock.seek(+event.target.value);
  document.querySelectorAll('[data-minute]').forEach(button => button.onclick = () => clock.seek(+button.dataset.minute));
  document.querySelectorAll('[data-dialog]').forEach(button => {
    button.onclick = () => {
      if (button.dataset.dialog === 'calendarDialog') { window.parkCalendar.open(venue); return; }
      const dialog = $(button.dataset.dialog);
      dialog.setAttribute('aria-label', dialog.querySelector('h2').textContent);
      dialog.showModal();
    };
  });
  document.querySelectorAll('dialog:not(#calendarDialog)').forEach(dialog => {
    dialog.querySelector('.close').onclick = () => dialog.close();
    dialog.addEventListener('click', event => {
      const r = dialog.getBoundingClientRect();
      if (event.target === dialog && (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom)) dialog.close();
    });
  });
  function highlightSection() {
    const active = location.hash === '#flow' ? '#flow' : '#overview';
    document.querySelectorAll('.topnav a').forEach(link => {
      const match = active === link.getAttribute('href');
      link.classList.toggle('current', match);
      if (match) link.setAttribute('aria-current', 'location'); else link.removeAttribute('aria-current');
    });
  }
  addEventListener('hashchange', highlightSection);
  highlightSection();
  if (matchMedia('(display-mode: standalone)').matches || navigator.standalone) document.querySelector('[data-dialog=installDialog]').hidden = true;
  if (/iPad|iPhone|iPod/i.test(navigator.userAgent)) $('installHow').textContent = 'Safari의 공유 메뉴에서 ‘홈 화면에 추가’를 선택해 주세요.';
  addEventListener('beforeinstallprompt', e => { e.preventDefault(); installRequest = e; $('install').hidden = false; });
  $('install').onclick = async () => {
    if (!installRequest) return;
    try { await installRequest.prompt(); await installRequest.userChoice; }
    finally { installRequest = null; $('install').hidden = true; $('installDialog').close(); }
  };
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) navigator.serviceWorker.register('./sw.js').catch(() => {});
  document.getElementById('scheduleRetry').onclick = clock.refresh;
  clock.subscribe(render);
  clock.start();
})();
