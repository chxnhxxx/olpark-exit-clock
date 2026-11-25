(() => {
  'use strict';

  const MINUTE = 60_000;
  const states = new WeakMap();
  let nextId = 0;
  const timeFormat = new Intl.DateTimeFormat('ko-KR', {
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Seoul'
  });
  const time = ms => timeFormat.format(ms);
  const fixed = num => Number(num.toFixed(2));
  const clamp = (v, low, high) => Math.max(low, Math.min(high, v));
  const valid = point => Number.isFinite(point.r) && point.r >= 0;
  const color = {
    real: 'var(--chart-real, #087d68)', projected: 'var(--chart-forecast, #478e82)',
    ink: 'var(--chart-ink, #28463e)', muted: 'var(--chart-muted, #526a62)',
    grid: 'var(--chart-grid, #d9e4df)', panel: 'var(--chart-panel, #ffffff)',
    threshold: 'var(--chart-threshold, #98613c)', active: 'var(--chart-active, #164d42)'
  };

  function lines(points) {
    const runs = [];
    let group = [];
    let previous;
    for (const point of points) {
      if (!valid(point) || (previous && point.t - previous.t > 6 * MINUTE)) {
        if (group.length) runs.push(group);
        group = [];
      }
      if (valid(point)) group.push(point);
      previous = point;
    }
    if (group.length) runs.push(group);
    return runs;
  }

  // Monotone interpolation keeps a local peak or a zero value in the observed range.
  function curve(points, x, y) {
    const coords = points.map(p => [x(p.t), y(p.r)]);
    let path = `M${coords[0][0]},${coords[0][1]}`;
    if (coords.length === 1) return path;
    const slopes = coords.slice(1).map(([cx, cy], i) => (cy - coords[i][1]) / (cx - coords[i][0] || 1));
    const tangent = coords.map((_, i) => {
      if (!i) return slopes[0];
      if (i === slopes.length) return slopes[i - 1];
      const a = slopes[i - 1], b = slopes[i];
      return a * b > 0 ? 2 * a * b / (a + b) : 0;
    });
    for (let i = 1; i < coords.length; i++) {
      const [x0, y0] = coords[i - 1], [x1, y1] = coords[i];
      const step = (x1 - x0) / 3;
      path += ` C${fixed(x0 + step)},${fixed(y0 + step * tangent[i - 1])} ${fixed(x1 - step)},${fixed(y1 - step * tangent[i])} ${x1},${y1}`;
    }
    return path;
  }

  function nearest(points, stamp) {
    return points.reduce((best, p) => Math.abs(p.t - stamp) < Math.abs(best.t - stamp) ? p : best);
  }

  function hideSelection(state) {
    state.active = null;
    state.element.querySelector('[data-cursor]')?.setAttribute('visibility', 'hidden');
  }

  function select(state, point, mode) {
    const { element, geom } = state;
    const { x, y, width, top, bottom, ticks } = geom;
    const px = x(point.t), py = y(point.r);
    const text = `${time(point.t)} · ${point.projected ? '예상' : state.data.demo ? '기록' : '관측'} ${Math.round(point.r)}대/분`;
    const cursor = element.querySelector('[data-cursor]');
    const labelWidth = Math.min(150, width - 4);
    const bx = clamp(px - labelWidth / 2, 2, width - labelWidth - 2);
    const by = py > top + 52 ? py - 43 : py + 13;
    cursor.innerHTML = `<line x1="${px}" x2="${px}" y1="${top}" y2="${bottom}" stroke="${color.active}" stroke-dasharray="2 3"/>
      <circle cx="${px}" cy="${py}" r="5.5" fill="${color.panel}" stroke="${color.active}" stroke-width="2.5"/>
      <rect x="${bx}" y="${by}" width="${labelWidth}" height="30" rx="7" fill="${color.active}"/>
      <text x="${bx + labelWidth / 2}" y="${by + 19.7}" text-anchor="middle" font-size="12.5" font-weight="650" fill="var(--chart-on-active, white)">${text}</text>`;
    cursor.setAttribute('visibility', 'visible');
    element.setAttribute('aria-valuenow', String(ticks.indexOf(point) + 1));
    element.setAttribute('aria-valuetext', text);
    state.active = { t: point.t, mode };
  }

  function wire(element) {
    const state = { element, id: ++nextId, active: null, width: 0, data: null, geom: null };
    states.set(element, state);
    element.style.display = 'block';
    element.style.width = '100%';
    element.style.touchAction = 'pan-y';
    const inspectPointer = e => {
      const g = state.geom;
      if (!g?.ticks.length) return;
      const box = element.getBoundingClientRect();
      const px = (e.clientX - box.left) * g.width / box.width;
      const stamp = g.start + (px - g.left) / (g.right - g.left) * (g.end - g.start);
      const p = nearest(g.ticks, stamp);
      if (Math.abs(g.x(p.t) - px) > 18) return hideSelection(state);
      select(state, p, 'pointer');
    };
    element.addEventListener('pointermove', inspectPointer);
    element.addEventListener('pointerdown', inspectPointer);
    element.addEventListener('pointerleave', () => hideSelection(state));
    element.addEventListener('pointercancel', () => hideSelection(state));
    element.addEventListener('blur', () => hideSelection(state));
    element.addEventListener('focus', () => {
      if (state.geom?.ticks.length && !state.active) select(state, nearest(state.geom.ticks, state.data.now), 'keyboard');
    });
    element.addEventListener('keydown', e => {
      const ticks = state.geom?.ticks;
      if (!ticks?.length) return;
      if (e.key === 'Escape') return hideSelection(state);
      const i = ticks.indexOf(nearest(ticks, state.active?.t ?? state.data.now));
      const keys = { ArrowRight: i + 1, ArrowUp: i + 1, ArrowLeft: i - 1, ArrowDown: i - 1, Home: 0, End: ticks.length - 1 };
      if (!Object.hasOwn(keys, e.key)) return;
      e.preventDefault();
      select(state, ticks[clamp(keys[e.key], 0, ticks.length - 1)], 'keyboard');
    });
    if (window.ResizeObserver) {
      state.observer = new ResizeObserver(() => {
        if (state.data && Math.round(element.getBoundingClientRect().width) !== state.width) draw(state);
      });
      state.observer.observe(element);
    }
    return state;
  }

  function draw(state) {
    const { element: svg, data } = state;
    const { now, demo, go } = data;
    state.width = Math.round(svg.getBoundingClientRect().width);
    const width = Math.max(180, state.width || 420);
    const height = width < 440 ? 198 : 226;
    const left = 30, right = width - 10, top = 36, bottom = height - 30;
    const start = now - 30 * MINUTE;
    const end = Math.max(now + 30 * MINUTE, go > now ? go + 5 * MINUTE : 0);
    const past = data.series.filter(p => p.t >= start && p.t <= now);
    const future = data.forecast.filter(p => p.t >= now && p.t <= end);
    const observed = past.filter(valid);
    const projected = future.filter(valid).map(p => ({ ...p, projected: true }));
    const ticks = [...observed, ...projected.filter(p => p.t !== observed.at(-1)?.t)];
    const peak = Math.max(0, ...ticks.map(p => p.r));
    const interval = Math.max(6, Math.ceil(peak / 3 / 6) * 6);
    const max = interval * 3;
    const x = t => fixed(left + (t - start) / (end - start) * (right - left));
    const y = r => fixed(bottom - (bottom - top) * r / max);
    const xn = x(now);
    const prefix = `exit-flow-${state.id}`;
    state.geom = { width, left, right, top, bottom, start, end, ticks, x, y };
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.style.height = height + 'px';
    svg.style.fontVariantNumeric = 'tabular-nums';
    const segments = [];
    const label = (px, py, value, anchor = 'middle', fill = color.muted, weight = 500) =>
      `<text x="${px}" y="${py}" text-anchor="${anchor}" fill="${fill}" font-size="12" font-weight="${weight}">${value}</text>`;
    segments.push(`<defs><linearGradient id="${prefix}-fill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${color.real}" stop-opacity=".24"/>
      <stop offset="100%" stop-color="${color.real}" stop-opacity=".025"/></linearGradient></defs>`);
    segments.push(`<rect x="${xn}" y="${top}" width="${fixed(right - xn)}" height="${bottom - top}" fill="${color.real}" opacity=".026"/>`);
    for (const value of [0, interval, interval * 2, max]) {
      const py = y(value);
      segments.push(`<path d="M${left},${py}H${right}" stroke="${color.grid}" fill="none" ${value ? 'stroke-dasharray="2 4"' : ''}/>`,
        label(left - 8, py + 4, value, 'end'));
    }
    segments.push(label(left, 17, '대/분', 'start'));
    if (ticks.length) {
      segments.push(`<path d="M${left},${y(12)}H${right}" stroke="${color.threshold}" opacity=".65" stroke-dasharray="4 5" fill="none"/>`);
    }
    const minSpacing = width < 485 ? 84 : 72;
    const step = ([10, 15, 30].find(minutes => (right - left) * minutes * MINUTE / (end - start) >= minSpacing) || 30) * MINUTE;
    for (let stamp = Math.ceil(start / step) * step; stamp <= end; stamp += step) {
      const px = x(stamp);
      const anchor = px - left < 20 ? 'start' : right - px < 20 ? 'end' : 'middle';
      segments.push(`<path d="M${px},${bottom}v4" stroke="${color.grid}"/>`,
        label(px, bottom + 21, time(stamp), anchor));
    }
    for (const [group, predicted] of [[past, false], [future, true]]) {
      for (const run of lines(group)) {
        const first = run[0], last = run.at(-1);
        if (run.length === 1) {
          segments.push(`<circle cx="${x(first.t)}" cy="${y(first.r)}" r="2.6" fill="${predicted ? color.projected : color.real}"/>`);
          continue;
        }
        const path = curve(run, x, y);
        if (!predicted) segments.push(`<path d="${path} L${x(last.t)},${bottom} L${x(first.t)},${bottom} Z" fill="url(#${prefix}-fill)"/>`);
        segments.push(`<path d="${path}" fill="none" stroke="${predicted ? color.projected : color.real}" stroke-width="${predicted ? 2.6 : 3.2}" stroke-linecap="round" stroke-linejoin="round" ${predicted ? 'stroke-dasharray="4 6"' : ''}/>`);
      }
    }
    segments.push(`<path d="M${xn},25V${bottom}" fill="none" stroke="${color.real}" opacity=".58" stroke-dasharray="3 4"/>`,
      label(xn, 17, `지금 ${time(now)}`, 'middle', color.real, 700));
    if (go > now && ticks.length) {
      const gx = x(go);
      segments.push(`<path d="M${gx},${top}V${bottom}" fill="none" stroke="${color.muted}" opacity=".5" stroke-dasharray="2 4"/>`);
      const labelX = Math.min(gx, right - 42);
      if (labelX - xn > 81) segments.push(label(labelX, 17, `출발 예상 ${time(go)}`, 'middle', color.ink, 650));
    }
    const last = observed.at(-1);
    if (last && Math.abs(last.t - now) <= MINUTE) segments.push(`<circle cx="${x(last.t)}" cy="${y(last.r)}" r="8" fill="${color.real}" opacity=".14"/>
      <circle cx="${x(last.t)}" cy="${y(last.r)}" r="4.6" stroke="${color.panel}" stroke-width="2" fill="${color.real}"/>`);
    if (ticks.length) {
      // Keep the threshold annotation legible without coloring the data itself.
      const thresholdX = right - 1;
      segments.push(`<text x="${thresholdX}" y="${y(12) - 5}" text-anchor="end" fill="${color.threshold}" stroke="${color.panel}" stroke-width="3" paint-order="stroke" font-size="12">혼잡 기준 12</text>`);
    } else {
      const cx = (left + right) / 2, cy = (top + bottom) / 2;
      segments.push(`<rect x="${cx - 74}" y="${cy - 18}" width="148" height="36" rx="12" fill="${color.panel}"/>`,
        label(cx, cy + 5, '주차 기록을 기다리는 중', 'middle', color.ink, 600));
    }
    segments.push('<g data-cursor visibility="hidden" pointer-events="none"></g>');
    svg.innerHTML = segments.join('');
    svg.setAttribute('role', ticks.length ? 'slider' : 'img');
    svg.setAttribute('aria-label', ticks.length
      ? `분당 출차 흐름. ${demo ? '공연 밤 기록' : '주차 관측값'} 및 예상. 좌우 방향키로 시각별 값을 확인하세요.`
      : '주차 기록을 기다리는 중');
    if (ticks.length) {
      svg.setAttribute('tabindex', '0');
      svg.setAttribute('aria-valuemin', '1');
      svg.setAttribute('aria-valuemax', String(ticks.length));
      const selected = nearest(ticks, state.active?.t ?? now);
      svg.setAttribute('aria-valuenow', String(ticks.indexOf(selected) + 1));
      svg.setAttribute('aria-valuetext', `${time(selected.t)}, ${Math.round(selected.r)}대/분`);
      if (state.active) select(state, selected, state.active.mode);
    } else {
      state.active = null;
      for (const attr of ['tabindex', 'aria-valuemin', 'aria-valuemax', 'aria-valuenow', 'aria-valuetext']) svg.removeAttribute(attr);
    }
  }

  window.renderExitChart = ({ element, series = [], forecast = [], now, go = null, demo = false }) => {
    if (!element || !Number.isFinite(now)) return;
    const state = states.get(element) || wire(element);
    if (state.data?.demo !== demo) state.active = null;
    state.data = { series, forecast, now, go, demo };
    draw(state);
  };
})();
