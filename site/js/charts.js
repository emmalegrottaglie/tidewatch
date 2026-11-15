// Hand-built charts: a weekly heatmap (HTML grid, keyboard navigable), an
// hourly area chart and a weekday bar chart (SVG). Tooltips take plain text
// lines, never HTML, so data from the network can't inject markup.

const SVG_NS = 'http://www.w3.org/2000/svg';
const STEPS = 8;

let tipEl;
function tip() {
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.className = 'tip';
    // Visual only: every hover target carries the same text in its aria-label.
    tipEl.setAttribute('aria-hidden', 'true');
    document.body.append(tipEl);
  }
  return tipEl;
}

export function showTip(lines, x, y) {
  const t = tip();
  t.replaceChildren();
  lines.forEach((line, i) => {
    const el = document.createElement(i === 0 ? 'strong' : 'div');
    el.textContent = line;
    t.append(el);
  });
  t.classList.add('on');
  const pad = 12;
  const r = t.getBoundingClientRect();
  let left = x + pad;
  let top = y - r.height - pad;
  if (left + r.width > innerWidth - 8) left = x - r.width - pad;
  if (top < 8) top = y + pad;
  t.style.left = `${Math.max(8, left)}px`;
  t.style.top = `${top}px`;
}
export function hideTip() { if (tipEl) tipEl.classList.remove('on'); }

function el(name, attrs = {}, parent) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (parent) parent.append(node);
  return node;
}

/** Map values to ramp steps 0..7 over their own range. Null stays null. */
export function quantize(values) {
  const nums = values.filter((v) => v !== null && Number.isFinite(v));
  if (!nums.length) return values.map(() => null);
  const min = Math.min(...nums), max = Math.max(...nums);
  return values.map((v) => {
    if (v === null || !Number.isFinite(v)) return null;
    if (max === min) return Math.floor(STEPS / 2);
    return Math.min(STEPS - 1, Math.floor(((v - min) / (max - min)) * STEPS));
  });
}

/**
 * Map values to a diverging scale around `center`: --n4..--n1 below, --mid at
 * it, --p1..--p4 above. Both sides share one extent so equal distances from
 * typical get equally strong colours.
 */
export function divergingSteps(values, center) {
  const nums = values.filter((v) => v !== null && Number.isFinite(v));
  if (!nums.length) return values.map(() => null);
  const extent = Math.max(...nums.map((v) => Math.abs(v - center))) || 1;
  return values.map((v) => {
    if (v === null || !Number.isFinite(v)) return null;
    const t = (v - center) / extent; // -1..1
    if (Math.abs(t) < 0.1) return 'mid';
    const k = Math.min(4, Math.ceil(Math.abs(t) * 4));
    return `${t < 0 ? 'n' : 'p'}${k}`;
  });
}

function buildLegend(keys, lowLabel, highLabel) {
  const wrap = document.createElement('div');
  wrap.className = 'legend';
  const lo = document.createElement('span'); lo.textContent = lowLabel;
  const ramp = document.createElement('span'); ramp.className = 'legend-ramp'; ramp.setAttribute('aria-hidden', 'true');
  for (const k of keys) { const sw = document.createElement('i'); sw.style.setProperty('--c', `var(--${k})`); ramp.append(sw); }
  const hi = document.createElement('span'); hi.textContent = highLabel;
  const none = document.createElement('i'); none.className = 'none'; none.style.marginLeft = '12px';
  const noneWrap = document.createElement('span'); noneWrap.className = 'legend-ramp'; noneWrap.append(none);
  const noneLabel = document.createElement('span'); noneLabel.textContent = 'No data';
  wrap.append(lo, ramp, hi, noneWrap, noneLabel);
  return wrap;
}

export const legend = (low = 'Less', high = 'More') => buildLegend(Array.from({ length: STEPS }, (_, i) => `s${i}`), low, high);
export const divergingLegend = () => buildLegend(['n4', 'n3', 'n2', 'n1', 'mid', 'p1', 'p2', 'p3', 'p4'], 'Below typical', 'Above typical');

/**
 * Weekly heatmap. values: 168 numbers (null = no data). ranks: Map(slot -> 1..3).
 * tipLines(slot) returns the tooltip text lines.
 */
export function renderHeatmap(container, { values, ranks = new Map(), tipLines, dayNames, hourLabel, label, center = null }) {
  const steps = center === null ? quantize(values) : divergingSteps(values, center);
  const grid = document.createElement('div');
  grid.className = 'heatmap';
  grid.setAttribute('role', 'grid');
  grid.setAttribute('aria-label', label);
  for (let h = 0; h < 24; h++) {
    const c = document.createElement('div');
    c.className = `hm-col${h % 3 ? ' minor' : ''}`;
    c.style.setProperty('--h', h);
    c.textContent = hourLabel(h);
    c.setAttribute('aria-hidden', 'true');
    grid.append(c);
  }
  const cells = [];
  for (let d = 0; d < 7; d++) {
    const r = document.createElement('div');
    r.className = 'hm-row';
    r.style.setProperty('--d', d);
    r.textContent = dayNames[d].slice(0, 3);
    r.setAttribute('aria-hidden', 'true');
    grid.append(r);
    for (let h = 0; h < 24; h++) {
      const slot = d * 24 + h;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cell';
      b.style.setProperty('--d', d);
      b.style.setProperty('--h', h);
      if (steps[slot] !== null) b.style.setProperty('--c', typeof steps[slot] === 'number' ? `var(--s${steps[slot]})` : `var(--${steps[slot]})`);
      b.tabIndex = slot === 0 ? 0 : -1;
      b.dataset.slot = slot;
      const lines = tipLines(slot);
      b.setAttribute('aria-label', lines.join('. '));
      const rank = ranks.get(slot);
      if (rank) {
        const badge = document.createElement('span');
        badge.className = 'rank';
        badge.textContent = `#${rank}`;
        b.append(badge);
      }
      cells.push(b);
      grid.append(b);
    }
  }
  const showFor = (b) => {
    const r = b.getBoundingClientRect();
    showTip(tipLines(Number(b.dataset.slot)), r.left + r.width / 2, r.top);
  };
  grid.addEventListener('pointerover', (e) => { const b = e.target.closest('.cell'); if (b) showFor(b); });
  grid.addEventListener('pointerleave', hideTip);
  grid.addEventListener('focusin', (e) => { const b = e.target.closest('.cell'); if (b) showFor(b); });
  grid.addEventListener('focusout', hideTip);
  grid.addEventListener('keydown', (e) => {
    const b = e.target.closest('.cell');
    if (!b) return;
    const slot = Number(b.dataset.slot);
    let d = Math.floor(slot / 24), h = slot % 24;
    const move = { ArrowRight: [0, 1], ArrowLeft: [0, -1], ArrowDown: [1, 0], ArrowUp: [-1, 0], Home: [0, -h], End: [0, 23 - h] }[e.key];
    if (!move) return;
    e.preventDefault();
    d = Math.max(0, Math.min(6, d + move[0]));
    h = Math.max(0, Math.min(23, h + move[1]));
    b.tabIndex = -1;
    const next = cells[d * 24 + h];
    next.tabIndex = 0;
    next.focus();
  });
  container.replaceChildren(grid);
}

function niceTicks(max, count = 4) {
  if (max <= 0) return [0];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const ticks = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(+v.toFixed(6));
  if (ticks[ticks.length - 1] < max) ticks.push(+(ticks[ticks.length - 1] + step).toFixed(6));
  return ticks;
}

/** Hour-of-day area chart with crosshair. values: 24 numbers or nulls. */
/** Draw at the container's real width so 14px text stays 14px on phones. */
function chartWidth(container) {
  return Math.max(280, Math.min(900, Math.round(container.clientWidth || 640)));
}

export function renderArea(container, { values, xLabel, yFormat, tipLines, reference = null, referenceLabel = '', label }) {
  const W = chartWidth(container), H = 240, m = { t: 12, r: 12, b: 28, l: 44 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const nums = values.filter((v) => v !== null);
  const ticks = niceTicks(Math.max(...nums, reference ?? 0, 0.0001));
  const yMax = ticks[ticks.length - 1];
  const x = (i) => m.l + (i / 23) * iw;
  const y = (v) => m.t + ih - (v / yMax) * ih;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': label });
  const g = el('g', { class: 'grid' }, svg);
  const ax = el('g', { class: 'axis' }, svg);
  for (const t of ticks) {
    el('line', { x1: m.l, x2: W - m.r, y1: y(t), y2: y(t) }, g);
    const tx = el('text', { x: m.l - 8, y: y(t) + 4, 'text-anchor': 'end' }, ax);
    tx.textContent = yFormat(t);
  }
  const every = W < 480 ? 6 : 3;
  for (let i = 0; i < 24; i += every) {
    const tx = el('text', { x: x(i), y: H - 8, 'text-anchor': i === 0 ? 'start' : 'middle' }, ax);
    tx.textContent = xLabel(i);
  }
  const pts = values.map((v, i) => (v === null ? null : [x(i), y(v)]));
  const segs = [];
  let cur = [];
  pts.forEach((p) => { if (p) cur.push(p); else if (cur.length) { segs.push(cur); cur = []; } });
  if (cur.length) segs.push(cur);
  const plot = el('g', { class: 'plot' }, svg);
  for (const s of segs) {
    const d = s.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
    el('path', { class: 'area', d: `${d}L${s[s.length - 1][0].toFixed(1)},${y(0)}L${s[0][0].toFixed(1)},${y(0)}Z` }, plot);
    el('path', { class: 'line', d }, plot);
  }
  el('line', { class: 'baseline', x1: m.l, x2: W - m.r, y1: y(0), y2: y(0) }, svg);
  if (reference !== null) {
    el('line', { class: 'avg-line', x1: m.l, x2: W - m.r, y1: y(reference), y2: y(reference) }, svg);
    const t = el('text', { class: 'avg-label', x: W - m.r, y: y(reference) - 6, 'text-anchor': 'end' }, svg);
    t.textContent = referenceLabel;
  }
  const cross = el('line', { class: 'crosshair', y1: m.t, y2: m.t + ih, opacity: 0 }, svg);
  const dot = el('circle', { class: 'dot', r: 5, opacity: 0 }, svg);
  const hit = el('rect', { class: 'hit', x: m.l, y: m.t, width: iw, height: ih, tabindex: 0 }, svg);
  let focusIndex = 12;
  const showAt = (i, clientX, clientY) => {
    if (values[i] === null) { cross.setAttribute('opacity', 0); dot.setAttribute('opacity', 0); hideTip(); return; }
    cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('opacity', 1);
    dot.setAttribute('cx', x(i)); dot.setAttribute('cy', y(values[i])); dot.setAttribute('opacity', 1);
    showTip(tipLines(i), clientX, clientY);
  };
  hit.addEventListener('pointermove', (e) => {
    const r = svg.getBoundingClientRect();
    const sx = ((e.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(23, Math.round(((sx - m.l) / iw) * 23)));
    focusIndex = i;
    showAt(i, e.clientX, values[i] === null ? e.clientY : r.top + (y(values[i]) / H) * r.height);
  });
  const clear = () => { cross.setAttribute('opacity', 0); dot.setAttribute('opacity', 0); hideTip(); };
  hit.addEventListener('pointerleave', clear);
  hit.addEventListener('blur', clear);
  const keyShow = () => {
    const r = svg.getBoundingClientRect();
    const v = values[focusIndex];
    showAt(focusIndex, r.left + (x(focusIndex) / W) * r.width, r.top + ((v === null ? m.t : y(v)) / H) * r.height);
  };
  hit.addEventListener('focus', keyShow);
  hit.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    focusIndex = Math.max(0, Math.min(23, focusIndex + (e.key === 'ArrowRight' ? 1 : -1)));
    keyShow();
  });
  container.replaceChildren(svg);
}

/** Vertical bars, one per category, with a per-bar tooltip and the best bar emphasized. */
export function renderBars(container, { values, labels, yFormat, tipLines, best = -1, reference = null, referenceLabel = '', label }) {
  const n = values.length;
  const W = chartWidth(container), H = 240, m = { t: 22, r: 12, b: 28, l: 44 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const nums = values.filter((v) => v !== null);
  const ticks = niceTicks(Math.max(...nums, reference ?? 0, 0.0001));
  const yMax = ticks[ticks.length - 1];
  const y = (v) => m.t + ih - (v / yMax) * ih;
  const band = iw / n;
  const bw = Math.min(52, band * 0.62);
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': label });
  const g = el('g', { class: 'grid' }, svg);
  const ax = el('g', { class: 'axis' }, svg);
  for (const t of ticks) {
    el('line', { x1: m.l, x2: W - m.r, y1: y(t), y2: y(t) }, g);
    const tx = el('text', { x: m.l - 8, y: y(t) + 4, 'text-anchor': 'end' }, ax);
    tx.textContent = yFormat(t);
  }
  values.forEach((v, i) => {
    const cx = m.l + band * i + band / 2;
    const tx = el('text', { x: cx, y: H - 8, 'text-anchor': 'middle' }, ax);
    tx.textContent = labels[i];
    if (v === null) return;
    const top = y(v), h = Math.max(0, y(0) - top);
    // Rounded top, square base: path with 4px radius on the data end only.
    const r = Math.min(4, h, bw / 2);
    const x0 = cx - bw / 2, x1 = cx + bw / 2, base = y(0);
    const d = `M${x0},${base}V${top + r}Q${x0},${top} ${x0 + r},${top}H${x1 - r}Q${x1},${top} ${x1},${top + r}V${base}Z`;
    el('path', { class: `bar${i === best ? ' best' : ''}`, d, style: `--i:${i}` }, svg);
    if (i === best) {
      const vl = el('text', { class: 'value-label', x: cx, y: top - 6, 'text-anchor': 'middle' }, svg);
      vl.textContent = yFormat(v);
    }
    const hit = el('rect', { class: 'hit', x: m.l + band * i, y: m.t, width: band, height: ih, tabindex: 0, 'aria-label': tipLines(i).join('. ') }, svg);
    const show = (e) => {
      const rr = svg.getBoundingClientRect();
      showTip(tipLines(i), e?.clientX ?? rr.left + (cx / W) * rr.width, rr.top + (top / H) * rr.height);
    };
    hit.addEventListener('pointermove', show);
    hit.addEventListener('focus', () => show());
    hit.addEventListener('pointerleave', hideTip);
    hit.addEventListener('blur', hideTip);
  });
  el('line', { class: 'baseline', x1: m.l, x2: W - m.r, y1: y(0), y2: y(0) }, svg);
  if (reference !== null) {
    el('line', { class: 'avg-line', x1: m.l, x2: W - m.r, y1: y(reference), y2: y(reference) }, svg);
    const t = el('text', { class: 'avg-label', x: W - m.r, y: y(reference) - 6, 'text-anchor': 'end' }, svg);
    t.textContent = referenceLabel;
  }
  container.replaceChildren(svg);
}
