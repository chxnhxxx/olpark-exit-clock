/* Historical context only. Live decisions continue to use the parking observations. */
(() => {
  const valid = profile => profile && Number.isInteger(profile.n) && profile.n > 0
    && Number.isInteger(profile.fromMinute) && Number.isInteger(profile.toMinute)
    && profile.fromMinute >= -25 && profile.toMinute <= 120 && profile.fromMinute <= profile.toMinute;
  const ready = fetch('venue-params.json', {signal: AbortSignal.timeout?.(9000)})
    .then(response => response.ok ? response.json() : null)
    .then(document => document?.version === 1 && valid(document.park) ? document : null)
    .catch(() => null);
  let params;
  ready.then(document => { params = document; });

  function reference(show) {
    const match = params?.venues?.[window.parkVenues.name(show.plc)];
    const profile = valid(match) ? match : params?.park;
    if (!profile) return {label: params === undefined ? '과거 기록 확인 중' : '과거 기록을 불러오지 못했어요', detail: ''};
    const format = new Intl.DateTimeFormat('ko-KR', {timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'});
    const toClock = offset => format.format(show.end + offset * 60_000);
    let detail = match?.source === 'venue'
      ? `이 공연장 단독 공연 ${profile.n}일의 과거 기록이에요.`
      : `이 공연장의 단독 표본이 적어 공원 전체 ${profile.n}일의 기록을 참고했어요.`;
    if (show.endDefault) detail += ' 공연 종료 시각은 추정값이에요.';
    return {
      label: Number.isFinite(show.end) ? `${toClock(profile.fromMinute)} – ${toClock(profile.toMinute)}` : '종료 시각 확인 후 안내',
      detail: Number.isFinite(show.end) ? detail : '공식 일정에 종료 시각이나 공연 시간이 필요해요.',
    };
  }

  window.exitProfile = {ready, reference};
})();
