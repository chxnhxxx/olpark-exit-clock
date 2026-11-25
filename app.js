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

  function renderShows(s) {
    const key = JSON.stringify([s.demo, s.schedErr, s.schedulePending, s.shows]);
    if (key === scheduleKey) return;
    scheduleKey = key;
    const list = $('shows'), windows = $('windows');
    list.replaceChildren();
    windows.replaceChildren();
    $('showTitle').textContent = s.demo ? '그날의 공연' : '오늘의 공연';
    $('showCount').hidden = !s.shows.length;
    $('showCount').textContent = s.shows.length + '건';
    $('scheduleHelp').hidden = !s.shows.some(show => show.end);
    if (!s.shows.length) {
      const empty = el('div', 'empty');
      empty.append(el('b', '', s.schedulePending ? '일정을 확인하고 있어요' : s.schedErr ? '공연 일정을 받지 못했어요' : '예정된 대형 공연이 없어요'));
      empty.append(document.createTextNode(s.schedulePending ? '올림픽공원 공연 일정을 불러오는 중이에요.' : s.schedErr ? '다음 조회 때 일정을 다시 확인해요.' : '오늘 주요 공연장에 등록된 일정 기준이에요.'));
      list.append(empty);
      return;
    }
    const shows = s.demo ? [...s.shows].sort((a, b) => b.end - a.end) : s.shows;
    for (const show of shows) {
      const dome = /DOME|체조/i.test(show.plc);
      const row = el('article', 'show-item'), copy = el('div', 'show-copy');
      copy.append(el('p', 'venue', s.demo ? (dome ? '올림픽체조경기장' : '대중음악 공연장') : show.plc));
      copy.append(el('h3', '', s.demo ? show.plc : show.title));
      copy.append(el('p', 'show-time', show.start && show.end ? time(show.start) + ' – ' + time(show.end) + ' 예정' : '시간 미정'));
      row.append(venueArt(dome), copy);
      list.append(row);
      const item = el('div', 'window-row');
      item.append(el('strong', '', show.title), el('span', '', show.end ? time(show.end + 30 * minute) + ' – ' + time(show.end + 90 * minute) + ' 혼잡 예상' : '종료 시각 미정'));
      windows.append(item);
    }
    if (s.schedErr) list.append(el('p', 'chart-note', '최근 저장한 오늘의 일정이에요.'));
  }

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

  function render(s) {
    const previous = current, d = s.decision;
    current = s;
    if (armed && !s.demo && d.tone === 'go') ring();
    if (armed && (s.demo || !d.alarm && d.tone !== 'wait' && d.tone !== 'stale')) setAlarm(false);
    $('hero').dataset.tone = d.tone;
    $('advice').textContent = d.head;
    $('statusText').textContent = d.chip;
    $('sourceText').textContent = s.demo ? '공연 기록 재현' : '실시간 주차현황';
    $('dateText').textContent = dateFormat.format(s.time);
    const hasTime = !!d.big;
    $('timeLabel').textContent = hasTime ? d.lab : '예상 출발 시각';
    $('goTime').textContent = d.big || '––:––';
    $('goTime').parentNode.classList.toggle('text-time', !!d.big && !/^\d/.test(d.big));
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
      $('seek').value = s.minute;
      $('seek').setAttribute('aria-valuetext', time(s.time));
      $('seek').style.setProperty('--position', (s.minute - 300) / 150 * 100 + '%');
      $('replayNow').textContent = time(s.time);
      $('play').setAttribute('aria-label', s.playing ? '기록 일시정지' : '기록 재생');
      $('play').querySelector('use').setAttribute('href', s.playing ? '#i-pause' : '#i-play');
      document.querySelectorAll('[data-minute]').forEach(btn => btn.setAttribute('aria-pressed', String(+btn.dataset.minute === s.minute)));
    }
    renderShows(s);
    $('rate').textContent = s.rate === null ? '—' : Math.round(s.rate);
    $('pastLabel').textContent = s.demo ? '기록 재현' : '관측값';
    $('forecastLegend').hidden = !s.forecast.length;
    $('chartNote').textContent = s.drop === null ? '동2·남2·북2문 주차 대수의 변화를 관측하고 있어요.' : '최근 5분간 주차 대수 ' + (s.drop === 0 ? '변화 없음' : Math.abs(s.drop) + '대 ' + (s.drop > 0 ? '감소' : '증가')) + ' · 세 주차장 합산';
    window.renderExitChart({ element: $('flowChart'), series: s.series, forecast: s.forecast, now: s.time, go: d.go, demo: s.demo });
    if (previous && previous.decision.tone !== d.tone) $('announce').textContent = d.head + '. ' + d.lab + ' ' + d.big;
  }

  $('liveMode').onclick = () => { if (current?.demo) { changeUrl(false); clock.live(); } };
  $('demoMode').onclick = () => { if (!current?.demo) { changeUrl(true); clock.replay(); } };
  $('retry').onclick = clock.refresh;
  $('play').onclick = clock.togglePlay;
  $('seek').oninput = event => clock.seek(+event.target.value);
  document.querySelectorAll('[data-minute]').forEach(button => button.onclick = () => clock.seek(+button.dataset.minute));
  document.querySelectorAll('[data-dialog]').forEach(button => {
    button.onclick = () => {
      const dialog = $(button.dataset.dialog);
      dialog.setAttribute('aria-label', dialog.querySelector('h2').textContent);
      dialog.showModal();
    };
  });
  document.querySelectorAll('dialog').forEach(dialog => {
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
  clock.subscribe(render);
  clock.start();
})();
