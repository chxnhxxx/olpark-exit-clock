(() => {
  let pending, cached, checked = 0;
  async function snapshot(url) {
    const response = await fetch(url, {cache:'no-cache',signal:AbortSignal.timeout(6000)});
    if (!response.ok) throw Error('공연 일정 응답 오류');
    const data = await response.json();
    if (!data.months || !Number.isFinite(Date.parse(data.updated))) throw Error('공연 일정 형식 오류');
    return data;
  }
  async function load() {
    if (cached && Date.now() - checked < 15 * 60000) return cached;
    if (!pending) pending = (async () => {
      const urls = ['schedule.json', 'https://raw.githubusercontent.com/chxnhxxx/olpark-exit-clock/main/schedule.json'];
      if (location.hostname !== 'chxnhxxx.github.io') urls.push('https://chxnhxxx.github.io/olpark-exit-clock/schedule.json');
      const results = await Promise.allSettled(urls.map(snapshot));
      const sources = results.filter(r=>r.status==='fulfilled').map(r=>r.value).sort((a,b)=>Date.parse(a.updated)-Date.parse(b.updated));
      if (!sources.length) throw Error('공연 일정 연결 실패');
      cached = {months:Object.assign({},...sources.map(s=>s.months)),updated:sources.at(-1).updated};
      checked=Date.now();
      return cached;
    })().finally(()=>{pending=null;});
    return pending;
  }
  window.parkSchedule = {load};
})();
