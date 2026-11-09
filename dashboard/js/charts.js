/** SVG gauges and canvas charts (no external libraries — works offline in the car). */

const NS = 'http://www.w3.org/2000/svg';
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const rad = (deg) => (deg * Math.PI) / 180;

function el(tag, attrs = {}, parent = null) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}

function arcPath(cx, cy, r, a0, a1) {
  if (a1 < a0) [a0, a1] = [a1, a0];
  if (a1 - a0 < 0.3) return '';
  const p0 = [cx + r * Math.cos(rad(a0)), cy + r * Math.sin(rad(a0))];
  const p1 = [cx + r * Math.cos(rad(a1)), cy + r * Math.sin(rad(a1))];
  return `M${p0[0].toFixed(2)} ${p0[1].toFixed(2)} A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${p1[0].toFixed(2)} ${p1[1].toFixed(2)}`;
}

/** 270° arc gauge. For bidirectional gauges (min < 0) the value arc starts at zero. */
export class ArcGauge {
  constructor(svg, { min = 0, max = 180, step = 20, colorPos = '#22d3ee', colorNeg = '#34d399' } = {}) {
    Object.assign(this, { svg, min, max, colorPos, colorNeg });
    this.cx = 110; this.cy = 108; this.r = 84; this.a0 = 135; this.sweep = 270;
    svg.innerHTML = '';
    el('path', { class: 'g-bg', d: arcPath(this.cx, this.cy, this.r, this.a0, this.a0 + this.sweep) }, svg);
    for (let v = min; v <= max + 1e-9; v += step) {
      const a = rad(this.angle(v));
      const [c, s] = [Math.cos(a), Math.sin(a)];
      el('line', { class: 'g-tick', x1: this.cx + c * (this.r - 12), y1: this.cy + s * (this.r - 12), x2: this.cx + c * (this.r - 18), y2: this.cy + s * (this.r - 18) }, svg);
      const t = el('text', { class: 'g-label', x: this.cx + c * (this.r - 29), y: this.cy + s * (this.r - 29) + 3.5 }, svg);
      t.textContent = v;
    }
    this.val = el('path', { class: 'g-val', d: '' }, svg);
    this.needle = el('circle', { r: 5, fill: '#e6edf5', cx: -10, cy: -10 }, svg);
  }

  angle(v) {
    return this.a0 + ((clamp(v, this.min, this.max) - this.min) / (this.max - this.min)) * this.sweep;
  }

  set(v) {
    if (v == null || Number.isNaN(v)) { this.val.setAttribute('d', ''); this.needle.setAttribute('cx', -10); return; }
    const zero = this.angle(Math.max(0, this.min));
    const a = this.angle(v);
    this.val.setAttribute('d', arcPath(this.cx, this.cy, this.r, zero, a));
    this.val.setAttribute('stroke', v < 0 ? this.colorNeg : this.colorPos);
    this.needle.setAttribute('cx', this.cx + this.r * Math.cos(rad(a)));
    this.needle.setAttribute('cy', this.cy + this.r * Math.sin(rad(a)));
  }
}

// ----------------------------------------------------------------------------- canvas helpers
function prep(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return null;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.font = '11px system-ui, sans-serif';
  return { ctx, w, h };
}

const GRID = '#1e2a37';
const MUTED = '#8396ab';

function emptyMsg(ctx, w, h, msg) {
  ctx.fillStyle = MUTED;
  ctx.textAlign = 'center';
  ctx.fillText(msg, w / 2, h / 2);
}

/** Speed (left axis) & power (right axis) over time. */
export function drawHistory(canvas, history) {
  const c = prep(canvas);
  if (!c) return;
  const { ctx, w, h } = c;
  const pad = { l: 38, r: 42, t: 10, b: 22 };
  const pw = w - pad.l - pad.r;
  const ph = h - pad.t - pad.b;
  if (history.length < 2) return emptyMsg(ctx, w, h, 'รอข้อมูล…');

  const now = history[history.length - 1].t;
  const span = 180000;
  const vMax = Math.max(60, Math.ceil(Math.max(...history.map((p) => p.speed)) / 20) * 20);
  const pMax = Math.max(40, Math.ceil(Math.max(...history.map((p) => p.power)) / 20) * 20);
  const pMin = Math.min(-20, Math.floor(Math.min(...history.map((p) => p.power)) / 20) * 20);
  const x = (t) => pad.l + pw * (1 - (now - t) / span);
  const yv = (v) => pad.t + ph * (1 - v / vMax);
  const yp = (p) => pad.t + ph * (1 - (p - pMin) / (pMax - pMin));

  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;
  ctx.fillStyle = MUTED;
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + (ph * i) / 4;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
    ctx.textAlign = 'right'; ctx.fillText(Math.round(vMax * (1 - i / 4)), pad.l - 6, y + 4);
    ctx.textAlign = 'left'; ctx.fillText(Math.round(pMax - ((pMax - pMin) * i) / 4), w - pad.r + 6, y + 4);
  }
  ctx.textAlign = 'center';
  for (let s = 0; s <= 180; s += 30) ctx.fillText(s ? `-${s}s` : 'ตอนนี้', x(now - s * 1000), h - 6);

  // zero power line
  ctx.strokeStyle = '#3b4b5e'; ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(pad.l, yp(0)); ctx.lineTo(w - pad.r, yp(0)); ctx.stroke(); ctx.setLineDash([]);

  const line = (fn, color, fill) => {
    ctx.beginPath();
    history.forEach((p, i) => (i ? ctx.lineTo(x(p.t), fn(p)) : ctx.moveTo(x(p.t), fn(p))));
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();
    if (fill) {
      ctx.lineTo(x(now), pad.t + ph); ctx.lineTo(x(history[0].t), pad.t + ph); ctx.closePath();
      const g = ctx.createLinearGradient(0, pad.t, 0, pad.t + ph);
      g.addColorStop(0, 'rgba(34,211,238,.25)'); g.addColorStop(1, 'rgba(34,211,238,0)');
      ctx.fillStyle = g; ctx.fill();
    }
  };
  line((p) => yv(p.speed), '#22d3ee', true);
  line((p) => yp(p.power), '#fbbf24', false);
}

/** 112-cell voltage bar chart. */
export function drawCells(canvas, cells) {
  const c = prep(canvas);
  if (!c) return;
  const { ctx, w, h } = c;
  if (!cells?.length) return emptyMsg(ctx, w, h, 'รอข้อมูลแรงดันรายเซลล์ (อ่านทุกรอบความถี่ต่ำ)…');
  const pad = { l: 44, r: 8, t: 10, b: 22 };
  const pw = w - pad.l - pad.r;
  const ph = h - pad.t - pad.b;
  const mn = Math.min(...cells);
  const mx = Math.max(...cells);
  const avg = cells.reduce((a, b) => a + b, 0) / cells.length;
  const lo = Math.floor((mn - 5) / 5) * 5;
  const hi = Math.ceil((mx + 5) / 5) * 5;
  const y = (v) => pad.t + ph * (1 - (v - lo) / (hi - lo));
  const bw = pw / cells.length;

  ctx.strokeStyle = GRID; ctx.fillStyle = MUTED; ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const v = lo + ((hi - lo) * i) / 4;
    ctx.beginPath(); ctx.moveTo(pad.l, y(v)); ctx.lineTo(w - pad.r, y(v)); ctx.stroke();
    ctx.fillText(Math.round(v), pad.l - 6, y(v) + 4);
  }
  const iMin = cells.indexOf(mn);
  const iMax = cells.indexOf(mx);
  cells.forEach((v, i) => {
    const dev = clamp((v - avg) / Math.max(3, (mx - mn) / 2), -1, 1);
    ctx.fillStyle = i === iMin ? '#f87171' : i === iMax ? '#a78bfa' : `hsl(${175 + dev * 25}, 70%, ${48 + dev * 8}%)`;
    const top = y(v);
    ctx.fillRect(pad.l + i * bw + bw * 0.12, top, Math.max(1, bw * 0.76), pad.t + ph - top);
  });
  ctx.strokeStyle = '#e6edf5'; ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(pad.l, y(avg)); ctx.lineTo(w - pad.r, y(avg)); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = MUTED; ctx.textAlign = 'center';
  for (let i = 0; i < cells.length; i += 8) ctx.fillText(i + 1, pad.l + (i + 0.5) * bw, h - 6);
}

/** Friction-circle style G-force plot (x = lateral, y = longitudinal). */
export function drawG(canvas, trail) {
  const c = prep(canvas);
  if (!c) return;
  const { ctx, w, h } = c;
  const cx = w / 2;
  const cy = h / 2;
  const r = Math.min(w, h) / 2 - 14;
  const scale = r / 1.0; // 1 g at the outer ring
  ctx.strokeStyle = GRID; ctx.lineWidth = 1;
  for (const g of [0.25, 0.5, 0.75, 1]) { ctx.beginPath(); ctx.arc(cx, cy, g * scale, 0, Math.PI * 2); ctx.stroke(); }
  ctx.beginPath(); ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy); ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r); ctx.stroke();
  ctx.fillStyle = MUTED; ctx.textAlign = 'center';
  ctx.fillText('เร่ง', cx, cy - r - 2); ctx.fillText('เบรก', cx, cy + r + 11);
  ctx.fillText('0.5g', cx + 0.5 * scale + 14, cy - 4);
  trail.forEach((p, i) => {
    const a = (i + 1) / trail.length;
    ctx.fillStyle = `rgba(34,211,238,${a * 0.5})`;
    ctx.beginPath(); ctx.arc(cx + clamp(p.x, -1.2, 1.2) * scale, cy - clamp(p.y, -1.2, 1.2) * scale, 2.5, 0, Math.PI * 2); ctx.fill();
  });
  const last = trail[trail.length - 1];
  if (last) {
    ctx.fillStyle = '#22d3ee'; ctx.shadowColor = '#22d3ee'; ctx.shadowBlur = 10;
    ctx.beginPath(); ctx.arc(cx + clamp(last.x, -1.2, 1.2) * scale, cy - clamp(last.y, -1.2, 1.2) * scale, 7, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
  }
}

/** Temperature → background colour (blue 10 °C … green 28 °C … red 50 °C). */
export function tempColor(t) {
  const hue = clamp(220 - ((t - 10) / 40) * 220, 0, 220);
  return `hsl(${hue}, 75%, 58%)`;
}
