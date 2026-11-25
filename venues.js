/* Canonical names used by both the daily view and the official schedule browser. */
(() => {
  const venues = [
    ['KSPO DOME', /KSPO\s*DOME|체조경기장/i],
    ['올림픽홀', /올림픽\s*홀/],
    ['티켓링크 라이브 아레나', /핸드볼|펜싱경기장|라이브\s*아레나|handball|live\s*arena/i],
    ['우리금융아트홀', /우리\s*금융|역도경기장/],
    ['K-아트홀', /K[–-]?\s*아트\s*홀|태권도공연장|케이아트홀/i],
    ['88잔디마당', /88\s*(잔디)?마당/],
  ];
  function name(raw) {
    const text = String(raw || '').trim().replace(/\s+/g, ' ');
    if (/뮤즈\s*라이브/.test(text)) return '뮤즈라이브';
    return venues.find(([, pattern]) => pattern.test(text))?.[0] || text || '장소 미정';
  }
  window.parkVenues = { name, names: [...venues.map(([label]) => label), '뮤즈라이브'] };
})();
