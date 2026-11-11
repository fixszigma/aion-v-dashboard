/**
 * GAC Aion V 602 — OBD2 BLE Dashboard (UI controller)
 */
import { POLL_GROUPS, POLL_CATEGORIES, DID_REGISTRY, getDid, BATTERY_NOMINAL_KWH } from './decoder.js';
import { Elm327 } from './elm327.js';
import { BleTransport } from './ble.js';
import { SimTransport } from './simulator.js';
import { Poller } from './poller.js';
import { Telemetry } from './telemetry.js';
import { ArcGauge, drawHistory, drawCells, drawG, tempColor } from './charts.js';

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];

// ============================================================================ settings
const SETTINGS_KEY = 'aionv.settings.v1';
const DEFAULTS = {
  fastMs: 500,
  slowS: 20,
  categories: Object.keys(POLL_CATEGORIES),
  caf0: false,
  capacity: BATTERY_NOMINAL_KWH,
  turboLights: false,
  headlightLowMask: 0,   // User-learned bitmask on live 720:2101 (0 = unconfigured in live mode)
  headlightHighMask: 0,  // User-learned bitmask on live 720:2101
};
const settings = (() => {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; } catch { return { ...DEFAULTS }; }
})();
const saveSettings = () => localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));

// ============================================================================ state
const tel = new Telemetry();
tel.capacityKwh = settings.capacity;
let transport = null;
let elm = null;
let poller = null;
let mode = 'idle'; // idle | connecting | live | demo
let lastValuesAt = 0;
let lastLog = null;
let wakeLock = null;
let voltTimer = null;
let learnBase2101 = null;
const gTrail = [];

// name -> poll tier (for staleness)
const TIER = {};
for (const g of POLL_GROUPS) for (const d of g.dids) TIER[getDid(g.tx, d).name] = g.tier;

// ============================================================================ derived values
const dyn = () => tel.get('dynamics') || {};
const cellsStat = (fn) => {
  const c = tel.get('cell_voltages');
  if (!Array.isArray(c) || !c.length) return null;
  if (fn === 'avg') return Math.round(c.reduce((a, b) => a + b, 0) / c.length);
  const v = fn === 'min' ? Math.min(...c) : Math.max(...c);
  return `${v} (#${c.indexOf(v) + 1})`;
};
const fmtDuration = (ms) => {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h} ชม. ${m} น.` : `${m} น. ${s % 60} ว.`;
};

const DERIVED = {
  speed: [() => tel.speedKmh, 'wheel_speed_fl'],
  power: [() => tel.powerKw, 'pack_current'],
  soc: [() => tel.soc, 'soc_precise'],
  range: [() => tel.rangeKm, 'soc_display'],
  remaining_kwh: [() => tel.remainingKwh, 'soc_display'],
  trip_km: [() => tel.trip.km],
  trip_kwh: [() => tel.trip.kwh],
  trip_regen: [() => tel.trip.regenKwh],
  efficiency: [() => tel.efficiencyKwh100],
  odo_km: [() => tel.odoKm],
  trip_time: [() => fmtDuration(Date.now() - tel.trip.startedAt)],
  cell_delta: [() => tel.cellDeltaMv, 'cell_max_mv'],
  cells_min: [() => cellsStat('min'), 'cell_voltages'],
  cells_max: [() => cellsStat('max'), 'cell_voltages'],
  cells_avg: [() => cellsStat('avg'), 'cell_voltages'],
  lat_g: [() => (dyn().lateral_accel_ms2 ?? null) !== null ? dyn().lateral_accel_ms2 / 9.81 : null, 'dynamics'],
  lon_g: [() => (dyn().longitudinal_accel_ms2 ?? null) !== null ? dyn().longitudinal_accel_ms2 / 9.81 : null, 'dynamics'],
  steering_angle: [() => dyn().steering_angle_deg ?? null, 'dynamics'],
  yaw_rate: [() => dyn().yaw_rate_degs ?? null, 'dynamics'],
  brake_pressure: [() => dyn().brake_pressure_raw ?? null, 'dynamics'],
  equiv_cycles: [() => (tel.get('energy_discharged_total') != null ? tel.get('energy_discharged_total') / tel.capacityKwh : null), 'energy_discharged_total'],
  tpms_t1_bar: [() => (tel.get('tpms')?.tire_1_psi != null ? tel.get('tpms').tire_1_psi / 14.5038 : null), 'tpms'],
  tpms_t2_bar: [() => (tel.get('tpms')?.tire_2_psi != null ? tel.get('tpms').tire_2_psi / 14.5038 : null), 'tpms'],
  tpms_t3_bar: [() => (tel.get('tpms')?.tire_3_psi != null ? tel.get('tpms').tire_3_psi / 14.5038 : null), 'tpms'],
  tpms_t4_bar: [() => (tel.get('tpms')?.tire_4_psi != null ? tel.get('tpms').tire_4_psi / 14.5038 : null), 'tpms'],
};

function resolve(key) {
  if (DERIVED[key]) return DERIVED[key][0]();
  const [head, ...rest] = key.split('.');
  let v = tel.get(head);
  for (const k of rest) v = v?.[k];
  return v;
}

function isStale(key) {
  if (mode === 'idle') return false;
  const src = DERIVED[key] ? DERIVED[key][1] : key.split('.')[0];
  if (!src) return false;
  const age = tel.age(src);
  if (age === Infinity) return false;
  return age > (TIER[src] === 'slow' ? settings.slowS * 3000 + 10000 : 5000);
}

function fmt(v, d, sign) {
  if (v == null || (typeof v === 'number' && Number.isNaN(v))) return '–';
  if (typeof v === 'boolean') return v ? 'เปิด' : 'ปิด';
  if (typeof v !== 'number') return String(v);
  const s = d != null ? v.toFixed(d) : String(v);
  return sign && v > 0 ? `+${s}` : s;
}

// ============================================================================ DOM bindings
const bindings = $$('[data-v]').map((el) => ({
  el,
  key: el.dataset.v,
  d: el.dataset.d != null ? Number(el.dataset.d) : null,
  sign: el.hasAttribute('data-sign'),
  warn: el.dataset.warn != null ? Number(el.dataset.warn) : null,
  last: null,
}));
const barBindings = $$('[data-bar]').map((el) => ({ el, key: el.dataset.bar }));

const gaugeSpeed = new ArcGauge($('#gaugeSpeed'), { min: 0, max: 180, step: 20 });
const gaugePower = new ArcGauge($('#gaugePower'), { min: -80, max: 200, step: 40 });

function buildHeatGrid(container, n) {
  container.innerHTML = '';
  return Array.from({ length: n }, (_, i) => {
    const d = document.createElement('div');
    d.className = 'empty';
    d.innerHTML = `<small>${i + 1}</small><span>–</span>`;
    container.appendChild(d);
    return d;
  });
}
const tempCells = buildHeatGrid($('#tempGrid'), 24);
const bmuCells = buildHeatGrid($('#bmuGrid'), 16);

function updateHeatGrid(cells, values, hiIdx, loIdx) {
  if (!Array.isArray(values)) return;
  cells.forEach((d, i) => {
    const t = values[i];
    if (t == null) return;
    d.classList.remove('empty');
    d.lastChild.textContent = t;
    d.style.background = tempColor(t);
    d.classList.toggle('hi', i + 1 === hiIdx || i + 1 === loIdx);
  });
}

// ============================================================================ render loop
function activeTab() { return $('.tab-page.active')?.id.replace('tab-', ''); }

function renderBindings() {
  for (const b of bindings) {
    const v = resolve(b.key);
    const text = fmt(v, b.d, b.sign);
    if (text !== b.last) { b.el.textContent = text; b.last = text; }
    b.el.classList.toggle('stale', isStale(b.key));
    if (b.warn != null) b.el.classList.toggle('warn', typeof v === 'number' && v > b.warn);
  }
  for (const b of barBindings) {
    const v = resolve(b.key);
    b.el.style.width = `${Math.max(0, Math.min(100, v ?? 0))}%`;
  }
}

function renderOverview() {
  const speed = tel.speedKmh ?? 0;
  if (gaugeSpeed) gaugeSpeed.set(speed);
  if (gaugePower) gaugePower.set(tel.powerKw ?? 0);
  const gear = tel.get('gear') || 'P';
  $$('#gearStrip span').forEach((s) => s.classList.toggle('on', s.textContent === gear));
  const soc = tel.soc ?? 79;
  const ring = $('#socRingFg');
  if (ring) {
    ring.style.strokeDashoffset = soc == null ? 314.16 : 314.16 * (1 - Math.max(0, Math.min(100, soc)) / 100);
    ring.style.stroke = soc == null ? '' : soc < 15 ? 'var(--red)' : soc < 30 ? 'var(--amber)' : 'var(--green)';
  }
  const hist = $('#historyChart');
  if (hist) drawHistory(hist, tel.history);

  // =========================================================================
  // Cockpit IVI Telemetry Instruments (Matching IMG_20261110_100100.jpg)
  // =========================================================================

  // 1. Big Gear Selector
  const bigGearEl = $('#cockpitBigGear');
  if (bigGearEl) {
    bigGearEl.textContent = gear;
    bigGearEl.setAttribute('data-gear', gear);
    const gearLbl = $('#cockpitGearLabel');
    if (gearLbl) {
      gearLbl.textContent = { P: 'Park', R: 'Reverse', N: 'Neutral', D: 'Drive' }[gear] || 'Park';
    }
  }

  // 2. Speedometer Needle & Active Glow Arc
  const speedArc = $('#cockpitSpeedArc');
  const speedNeedle = $('#cockpitSpeedNeedle');
  if (speedArc && speedNeedle) {
    const s = Math.max(0, Math.min(200, speed));
    const frac = s / 200;
    speedArc.style.strokeDashoffset = (100 - frac * 100).toFixed(1);
    speedNeedle.style.transform = `rotate(${(-135 + frac * 270).toFixed(1)}deg)`;
  }

  // 3. Battery Circular Ring & 3D Glass Cylinder
  const cpRing = $('#cockpitSocRingVal');
  const cpFluid = $('#cockpitBatteryFluid');
  if (cpRing && soc != null) {
    const s = Math.max(0, Math.min(100, soc));
    cpRing.style.strokeDashoffset = (100 - s).toFixed(1);
    cpRing.style.stroke = s <= 15 ? '#ef4444' : s <= 30 ? '#f59e0b' : '#06b6d4';
  }
  if (cpFluid && soc != null) {
    cpFluid.style.height = `${Math.max(4, Math.min(100, soc))}%`;
  }

  // 4. Vertical Thermometer
  const tMercury = $('#cockpitThermoMercury');
  if (tMercury) {
    const outT = tel.get('temp_outside') ?? 33;
    const ratio = Math.max(0, Math.min(1, (outT - -20) / 60));
    const h = Math.max(4, Math.round(ratio * 64));
    tMercury.setAttribute('height', h);
    tMercury.setAttribute('y', 72 - h);
  }

  // 5. Marathons Estimator
  const marathonEl = $('#cockpitMarathons');
  if (marathonEl) {
    const range = tel.rangeKm ?? 265;
    marathonEl.textContent = (range / 42.195).toFixed(1);
  }

  // 6. Door Lock Status
  const isLocked = tel.get('doors_locked') ?? (gear === 'D' || speed > 0);
  const doorStatusEl = $('#cockpitDoorStatus');
  const lockBadge = $('#cockpitLockBadge');
  if (doorStatusEl) {
    doorStatusEl.textContent = isLocked ? 'Locked' : 'Unlocked';
    doorStatusEl.className = `lock-state-big ${isLocked ? 'locked' : 'unlocked'}`;
  }
  if (lockBadge) {
    lockBadge.textContent = isLocked ? 'Locked' : 'Unlocked';
    lockBadge.className = `c-badge ${isLocked ? 'c-badge-locked' : 'c-badge-unlocked'}`;
  }

  // 7. Charging State
  const chargeEl = $('#cockpitChargeStatus');
  const plugTag = $('#cockpitPlugTag');
  if (chargeEl) {
    const isCharging = tel.get('charging_state') || (gear === 'P' && speed === 0 && (tel.powerKw ?? 0) < -1);
    chargeEl.textContent = isCharging ? 'Charging' : 'Not charging';
    if (plugTag) plugTag.textContent = isCharging ? 'Plugged' : 'Unplugged';
  }

  // 8. Full-Car Realtime Lighting Card
  renderLightingRealtime();
}

/**
 * Determines Headlight level from 720:2101:
 * - Demo mode uses simulator bits 0x0001 (DRL), 0x0002 (Low), 0x0004 (High).
 * - Live car mode uses user-learned masks (headlightLowMask / headlightHighMask)
 *   so unverified bits are never assumed silently.
 */
function resolveHeadlightsState() {
  const lights = tel.get('lights');
  if (!lights || lights.raw == null) return { level: 'unknown', label: 'รอข้อมูล OBD2', badge: 'WAIT', source: '–' };
  const raw = lights.raw;

  if (mode === 'demo') {
    if (raw & 0x0004) return { level: 'high', label: 'ไฟสูง (HIGH BEAM)', badge: 'HIGH', source: 'Demo · 2101' };
    if (raw & 0x0002) return { level: 'low', label: 'ไฟต่ำ (LOW BEAM)', badge: 'LOW', source: 'Demo · 2101' };
    if (raw & 0x0001) return { level: 'drl', label: 'ไฟหรี่ / DRL', badge: 'DRL', source: 'Demo · 2101' };
    return { level: 'off', label: 'ไฟหน้าปิด (OFF)', badge: 'OFF', source: 'Demo · 2101' };
  }

  const hiM = settings.headlightHighMask || 0;
  const loM = settings.headlightLowMask || 0;
  if (hiM && (raw & hiM) === hiM) return { level: 'high', label: 'ไฟสูง (HIGH BEAM)', badge: 'HIGH', source: `Mask 0x${hiM.toString(16).toUpperCase()}` };
  if (loM && (raw & loM) === loM) return { level: 'low', label: 'ไฟต่ำ (LOW BEAM)', badge: 'LOW', source: `Mask 0x${loM.toString(16).toUpperCase()}` };
  if (loM || hiM) return { level: 'off', label: 'ไฟหน้าปิด (OFF)', badge: 'OFF', source: `Mask Configured` };
  return { level: 'unmapped', label: `ค่าดิบ 0x${lights.raw_hex || '----'}`, badge: 'UNMAPPED', source: 'กดจับคู่บิต' };
}

function fmtBits16(v) {
  if (v == null) return '–––– –––– –––– ––––';
  const s = v.toString(2).padStart(16, '0');
  return `${s.slice(0, 4)} ${s.slice(4, 8)} ${s.slice(8, 12)} ${s.slice(12, 16)}`;
}

function renderLightingRealtime() {
  const turn = tel.get('turn_signals') || {};
  const lights = tel.get('lights') || {};
  const pedal = tel.get('pedal_park') || {};
  const doors = tel.get('doors') || {};
  const body2102 = tel.get('body_status_2102') || {};

  const leftOn = !!turn.left;
  const rightOn = !!turn.right;
  const hazardOn = leftOn && rightOn;
  const brakeOn = !!lights.brake_light;
  const reverseOn = !!lights.reverse_light;
  const head = resolveHeadlightsState();
  const drlOn = head.level === 'drl' || head.level === 'low' || head.level === 'high';
  const lowOn = head.level === 'low' || head.level === 'high';
  const highOn = head.level === 'high';

  // Full-Car SVG Optical Beams & Lamps
  $('#rtBeamLow').classList.toggle('on', lowOn);
  $('#rtBeamHigh').classList.toggle('on', highOn);
  ['rtDrlL', 'rtDrlR'].forEach((id) => $(`#${id}`).classList.toggle('on', drlOn));
  ['rtHeadL', 'rtHeadR'].forEach((id) => {
    const el = $(`#${id}`);
    el.classList.toggle('low', head.level === 'low');
    el.classList.toggle('high', head.level === 'high');
  });

  ['rtTurnFL', 'rtMirrorTurnL', 'rtTurnRL'].forEach((id) => $(`#${id}`).classList.toggle('on', leftOn));
  ['rtTurnFR', 'rtMirrorTurnR', 'rtTurnRR'].forEach((id) => $(`#${id}`).classList.toggle('on', rightOn));
  ['rtBrakeHigh', 'rtBrakeBar', 'rtBrakeL', 'rtBrakeR', 'rtBrakeGlow'].forEach((id) => $(`#${id}`).classList.toggle('on', brakeOn));
  ['rtRevL', 'rtRevR'].forEach((id) => $(`#${id}`).classList.toggle('on', reverseOn));

  // Swinging doors on Full-Car Stage
  const dMap = { rtDoorFL: doors.front_left_open, rtDoorFR: doors.front_right_open, rtDoorRL: doors.rear_left_open, rtDoorRR: doors.rear_right_open, rtDoorBoot: doors.boot_open };
  let openCount = 0;
  for (const [id, isOpen] of Object.entries(dMap)) {
    $(`#${id}`).classList.toggle('open', !!isOpen);
    if (isOpen) openCount++;
  }
  $('#rtDoorsQuickTag').textContent = openCount ? `เปิดอยู่ ${openCount} จุด` : 'ประตูปิดสนิท';

  // Status Pillars
  $('#rtBoxHeadlight').classList.toggle('on-cyan', lowOn || highOn || drlOn);
  $('#rtHeadlightText').textContent = head.label;
  $('#rtHeadlightBadge').textContent = head.badge;

  $('#rtBoxTurn').classList.toggle('on-amber', leftOn || rightOn);
  $('#rtPillTurnL').classList.toggle('on', leftOn && !hazardOn);
  $('#rtPillTurnR').classList.toggle('on', rightOn && !hazardOn);
  $('#rtPillHazard').classList.toggle('on', hazardOn);
  $('#rtTurnHex').textContent = turn.raw != null ? `0x${turn.raw.toString(16).toUpperCase().padStart(2, '0')}` : '0x00';

  $('#rtBoxBrake').classList.toggle('on-red', brakeOn);
  $('#rtBrakeText').textContent = brakeOn ? 'ไฟเบรกติด (BRAKE ON)' : 'ไฟเบรกดับ';
  $('#rtReverseBadge').textContent = reverseOn ? 'ถอย: ติด (R)' : 'ถอย: ดับ';
  $('#rtPedalBadge').textContent = pedal.brake_pedal ? 'เหยียบเบรก' : pedal.park ? 'เกียร์ P' : 'ปล่อยเบรก';

  // Raw Bit Monitor
  $('#rtRaw2100').textContent = turn.raw != null ? `0x${turn.raw.toString(16).toUpperCase().padStart(2, '0')}` : '–';
  $('#rtRaw2101').textContent = lights.raw_hex ? `0x${lights.raw_hex}` : '–';
  $('#rtRaw2102').textContent = body2102.raw != null ? `0x${body2102.raw.toString(16).toUpperCase().padStart(2, '0')}` : '–';
  $('#rtRawBits2101').textContent = fmtBits16(lights.raw);
  $('#rtSavedMaskLabel').textContent =
    mode === 'demo'
      ? 'Demo (0x01/02/04)'
      : settings.headlightLowMask || settings.headlightHighMask
        ? `Low 0x${(settings.headlightLowMask || 0).toString(16).toUpperCase()} / High 0x${(settings.headlightHighMask || 0).toString(16).toUpperCase()}`
        : 'ยังไม่ตั้งค่า (รถจริง)';
}

function renderBattery() {
  drawCells($('#cellChart'), tel.get('cell_voltages'));
  updateHeatGrid(tempCells, tel.get('battery_temps'), tel.get('bat_temp_max_index'), tel.get('bat_temp_min_index'));
  const bmu = tel.get('bmu_temps');
  updateHeatGrid(bmuCells, bmu, null, null);
}

function renderDrive() {
  drawG($('#gChart'), gTrail);
  const a = dyn().steering_angle_deg;
  $('#steerWheel').style.transform = `rotate(${-(a ?? 0)}deg)`;
  $('#brakeBar').style.width = `${Math.min(100, (dyn().brake_pressure_raw ?? 0) / 20)}%`;
}

function renderBody() {
  const doors = tel.get('doors') || {};
  const map = { door_fl: doors.front_left_open, door_fr: doors.front_right_open, door_rl: doors.rear_left_open, door_rr: doors.rear_right_open, door_boot: doors.boot_open };
  for (const [id, open] of Object.entries(map)) $(`#${id}`).classList.toggle('open', !!open);

  const turn = tel.get('turn_signals') || {};
  ['turn_fl', 'turn_rl'].forEach((id) => $(`#${id}`).classList.toggle('on', !!turn.left));
  ['turn_fr', 'turn_rr'].forEach((id) => $(`#${id}`).classList.toggle('on', !!turn.right));
  const lights = tel.get('lights') || {};
  const pedal = tel.get('pedal_park') || {};
  const head = resolveHeadlightsState();
  ['tabBodyHeadL', 'tabBodyHeadR'].forEach((id) => {
    const h = $(`#${id}`);
    h.classList.toggle('on', head.level === 'low' || head.level === 'high' || head.level === 'drl');
    h.classList.toggle('high', head.level === 'high');
  });
  ['brake_l', 'brake_r'].forEach((id) => $(`#${id}`).classList.toggle('on', !!lights.brake_light));
  $('#reverse_lamp').classList.toggle('on', !!lights.reverse_light);

  const lock = tel.get('lock_state') ?? tel.get('lock_state_l');
  const badge = $('#lockBadge');
  badge.textContent = lock === 'LOCKED' ? '🔒 ล็อกแล้ว' : lock === 'UNLOCKED' ? '🔓 ปลดล็อก' : lock ?? '–';
  badge.className = `lock-badge ${lock === 'LOCKED' ? 'locked' : lock === 'UNLOCKED' ? 'unlocked' : ''}`;

  const tpms = tel.get('tpms');
  for (let i = 1; i <= 4; i++) {
    const p = tpms?.[`tire_${i}_psi`];
    const box = $(`.tpms.t${i}`);
    box.classList.toggle('low', p != null && (p < 30 || p > 42));
    box.classList.toggle('crit', p != null && (p < 26 || p > 46));
  }

  const flags = [
    ['ประตูหน้าขวา (คนขับ)', doors.front_right_open, 'เปิด', 'ปิด'],
    ['ประตูหน้าซ้าย', doors.front_left_open, 'เปิด', 'ปิด'],
    ['ประตูหลังขวา', doors.rear_right_open, 'เปิด', 'ปิด'],
    ['ประตูหลังซ้าย', doors.rear_left_open, 'เปิด', 'ปิด'],
    ['ฝาท้าย', doors.boot_open, 'เปิด', 'ปิด'],
    ['เหยียบเบรก', pedal.brake_pedal, 'ใช่', 'ไม่'],
    ['สวิตช์เกียร์ P', pedal.park, 'P', '–'],
    ['ไฟเบรก', lights.brake_light, 'ติด', 'ดับ'],
    ['ไฟถอย', lights.reverse_light, 'ติด', 'ดับ'],
    ['ไฟเลี้ยวซ้าย', turn.left, 'กระพริบ', 'ดับ'],
    ['ไฟเลี้ยวขวา', turn.right, 'กระพริบ', 'ดับ'],
  ];
  const html = flags.map(([n, on, a, b]) => `<li class="${on ? 'on' : ''}"><span>${n}</span><span>${on == null ? '–' : on ? a : b}</span></li>`).join('');
  const ul = $('#bodyFlags');
  if (ul._html !== html) { ul.innerHTML = html; ul._html = html; }
}

let lastTable = 0;
function renderTable() {
  if (Date.now() - lastTable < 1000) return;
  lastTable = Date.now();
  const rows = [];
  for (const d of DID_REGISTRY.values()) {
    if (!(d.name in tel.values)) continue;
    let v = tel.values[d.name];
    if (Array.isArray(v)) v = `[${v.length}] ${v.slice(0, 12).join(', ')}${v.length > 12 ? ' …' : ''}`;
    else if (v && typeof v === 'object') v = Object.entries(v).map(([k, x]) => `${k}=${x}`).join('  ');
    const age = tel.age(d.name);
    rows.push(`<tr><td>${d.tx}</td><td>${d.did}</td><td>${d.label}</td><td title="${escapeHtml(String(v))}">${escapeHtml(String(v))}</td><td>${d.unit}</td><td>${(age / 1000).toFixed(1)}s</td></tr>`);
  }
  $('#valuesTable tbody').innerHTML = rows.join('') || '<tr><td colspan="6" style="color:var(--muted)">ยังไม่มีข้อมูล</td></tr>';
  $('#logRows').textContent = tel.log?.rows.length ?? lastLog?.rows.length ?? 0;
}

function render() {
  renderBindings();
  const tab = activeTab();
  if (tab === 'overview') renderOverview();
  else if (tab === 'battery') renderBattery();
  else if (tab === 'drive') renderDrive();
  else if (tab === 'body') renderBody();
  else if (tab === 'log') renderTable();

  if ((mode === 'live' || mode === 'demo') && lastValuesAt && Date.now() - lastValuesAt > 8000) {
    showBanner('ไม่ได้รับข้อมูลจากรถเกิน 8 วินาที — ตรวจสอบว่ารถอยู่ในสถานะ ON/READY หรือลองเปิด "โหมดดองเกิลโคลน (ATCAF0)" ในหน้าตั้งค่า');
  } else if (mode !== 'idle') hideBanner();

  if (mode === 'demo') syncDemoControllerUI();
}
setInterval(render, 200);

// ============================================================================ console
const consoleLines = [];
const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
let consoleDirty = false;
function consoleLog(kind, text) {
  const t = new Date().toLocaleTimeString('th-TH', { hour12: false });
  const prefix = kind === 'tx' ? '→' : kind === 'rx' ? '←' : '!';
  consoleLines.push(`<span class="${kind}">${t} ${prefix} ${escapeHtml(text.replace(/\n/g, ' | '))}</span>`);
  if (consoleLines.length > 400) consoleLines.splice(0, consoleLines.length - 400);
  consoleDirty = true;
}
setInterval(() => {
  if (!consoleDirty || activeTab() !== 'log' || $('#consolePause').checked) return;
  const pre = $('#console');
  pre.innerHTML = consoleLines.join('\n');
  pre.scrollTop = pre.scrollHeight;
  consoleDirty = false;
}, 500);
$('#btnClearConsole').onclick = () => { consoleLines.length = 0; $('#console').innerHTML = ''; };

// ============================================================================ status / banner / toast
function setStatus(kind, text, meta = '') {
  const pill = $('#statusPill');
  pill.className = `status-pill ${kind}`;
  $('#statusText').textContent = text;
  $('#adapterInfo').textContent = meta;
}
function showBanner(msg) { const b = $('#banner'); b.textContent = msg; b.classList.remove('hidden'); }
function hideBanner() { $('#banner').classList.add('hidden'); }
let toastTimer;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast${isError ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 4500);
}

function setButtons() {
  const connected = mode === 'live' || mode === 'demo';
  const busy = mode === 'connecting';
  $('#btnBle').classList.toggle('hidden', connected);
  $('#btnDemo').classList.toggle('hidden', connected);
  $('#btnBle').disabled = $('#btnDemo').disabled = busy;
  $('#btnDisconnect').classList.toggle('hidden', !connected && !busy);
  $('#btnRec').disabled = !connected;
  $('#demoController').classList.toggle('hidden', mode !== 'demo');
}

// ============================================================================ demo simulator controls
function getSimVehicle() {
  return mode === 'demo' && transport?.vehicle ? transport.vehicle : null;
}

let isGasHolding = false;
let isBrakeHolding = false;

function syncDemoControllerUI() {
  const veh = getSimVehicle();
  if (!veh) return;

  const isAuto = veh.driveMode === 'auto';
  $('#demoController').classList.toggle('auto-mode', isAuto);
  $('#demoModeAuto').classList.toggle('active', isAuto);
  $('#demoModeManual').classList.toggle('active', !isAuto);

  // Gears
  const currentGear = veh.gear;
  $$('.btn-gear').forEach((btn) => btn.classList.toggle('active', btn.dataset.gear === currentGear));
  const gearHints = {
    P: 'เกียร์ P: ล้อล็อก จอดนิ่ง ปลอดภัย (IBCM 1200 bit 0x0010)',
    R: 'เกียร์ R: ถอยหลัง ไฟถอยติด ความเร็วจำกัด 25 km/h (IBCM 2101 bit 0x0100)',
    N: 'เกียร์ N: เกียร์ว่าง ปล่อยไหล ไม่ส่งกำลังไปที่ล้อ',
    D: 'เกียร์ D: เดินหน้า เหยียบคันเร่งเพื่อออกตัว หรือปล่อยเบรกเพื่อ Creep',
  };
  $('#demoGearHint').textContent = isAuto ? 'โหมดอัตโนมัติ: กำลังจำลองการขับขี่ตามวัฏจักรเมือง/ทางด่วน' : (gearHints[currentGear] || '');

  // Pedals
  if (!isGasHolding) {
    const gasPct = Math.round(veh.inputThrottle * 100);
    $('#demoValGas').textContent = `${gasPct}%`;
  }
  if (!isBrakeHolding) {
    const brakePct = Math.round(veh.inputBrake * 100);
    $('#demoValBrake').textContent = `${brakePct}%`;
  }

  // Steering
  $('#demoValSteer').textContent = `${Math.round(veh.steer)}°`;

  // Turn signal
  const turnSig = veh.inputTurnSignal;
  $('#demoTurnLeft').classList.toggle('active', turnSig === 'left');
  $('#demoTurnOff').classList.toggle('active', turnSig === 'off');
  $('#demoTurnRight').classList.toggle('active', turnSig === 'right');
  $('#demoTurnHazard').classList.toggle('active', turnSig === 'hazard');

  // Headlights
  const headSig = veh.inputHeadlights;
  $('#demoHeadOff').classList.toggle('active', headSig === 'off');
  $('#demoHeadDrl').classList.toggle('active', headSig === 'drl');
  $('#demoHeadLow').classList.toggle('active', headSig === 'low');
  $('#demoHeadHigh').classList.toggle('active', headSig === 'high');
  $('#demoHeadAuto').classList.toggle('active', headSig === 'auto');

  // Doors
  const doors = veh.doors;
  $('#demoDoorFR').classList.toggle('open', !!(doors & 0x80));
  $('#demoDoorFL').classList.toggle('open', !!(doors & 0x40));
  $('#demoDoorRR').classList.toggle('open', !!(doors & 0x10));
  $('#demoDoorRL').classList.toggle('open', !!(doors & 0x20));
  $('#demoDoorBoot').classList.toggle('open', !!(doors & 0x08));

  // AC & Lock
  $('#demoAcToggle').textContent = veh.acActive ? '❄ แอร์ A/C: เปิด' : '❄ แอร์ A/C: ปิด';
  const locked = veh.locked;
  $('#demoLockToggle').textContent = locked ? '🔒 ล็อกแล้ว' : '🔓 ปลดล็อก';
}

function initDemoControls() {
  $('#demoToggleCollapse').onclick = () => {
    $('#demoBody').classList.toggle('collapsed');
  };

  $('#demoModeAuto').onclick = () => {
    const veh = getSimVehicle();
    if (veh) veh.driveMode = 'auto';
    syncDemoControllerUI();
  };

  $('#demoModeManual').onclick = () => {
    const veh = getSimVehicle();
    if (veh) {
      veh.driveMode = 'manual';
      veh.inputGear = veh.gear || 'D';
    }
    syncDemoControllerUI();
  };

  // Gears
  $$('.btn-gear').forEach((btn) => {
    btn.onclick = () => {
      const veh = getSimVehicle();
      if (!veh || veh.driveMode !== 'manual') return;
      const g = btn.dataset.gear;
      veh.inputGear = g;
      syncDemoControllerUI();
    };
  });

  // Accelerator Pedal button (hold down)
  const gasBtn = $('#demoBtnGas');
  const gasSlider = $('#demoSliderGas');
  const pressGas = (e) => {
    e.preventDefault();
    const veh = getSimVehicle();
    if (!veh || veh.driveMode !== 'manual') return;
    isGasHolding = true;
    gasBtn.classList.add('holding');
    veh.inputThrottle = 1.0;
    $('#demoValGas').textContent = '100%';
  };
  const releaseGas = () => {
    if (!isGasHolding) return;
    const veh = getSimVehicle();
    isGasHolding = false;
    gasBtn.classList.remove('holding');
    if (veh) veh.inputThrottle = Number(gasSlider.value) / 100;
    $('#demoValGas').textContent = `${gasSlider.value}%`;
  };
  gasBtn.addEventListener('pointerdown', pressGas);
  window.addEventListener('pointerup', releaseGas);
  window.addEventListener('pointercancel', releaseGas);

  gasSlider.oninput = () => {
    const veh = getSimVehicle();
    const val = Number(gasSlider.value);
    $('#demoValGas').textContent = `${val}%`;
    if (veh && !isGasHolding && veh.driveMode === 'manual') {
      veh.inputThrottle = val / 100;
    }
  };

  // Brake Pedal button (hold down)
  const brakeBtn = $('#demoBtnBrake');
  const brakeSlider = $('#demoSliderBrake');
  const pressBrake = (e) => {
    e.preventDefault();
    const veh = getSimVehicle();
    if (!veh || veh.driveMode !== 'manual') return;
    isBrakeHolding = true;
    brakeBtn.classList.add('holding');
    veh.inputBrake = 1.0;
    $('#demoValBrake').textContent = '100%';
  };
  const releaseBrake = () => {
    if (!isBrakeHolding) return;
    const veh = getSimVehicle();
    isBrakeHolding = false;
    brakeBtn.classList.remove('holding');
    if (veh) veh.inputBrake = Number(brakeSlider.value) / 100;
    $('#demoValBrake').textContent = `${brakeSlider.value}%`;
  };
  brakeBtn.addEventListener('pointerdown', pressBrake);
  window.addEventListener('pointerup', releaseBrake);
  window.addEventListener('pointercancel', releaseBrake);

  brakeSlider.oninput = () => {
    const veh = getSimVehicle();
    const val = Number(brakeSlider.value);
    $('#demoValBrake').textContent = `${val}%`;
    if (veh && !isBrakeHolding && veh.driveMode === 'manual') {
      veh.inputBrake = val / 100;
    }
  };

  // Steering
  const steerSlider = $('#demoSliderSteer');
  steerSlider.oninput = () => {
    const veh = getSimVehicle();
    const deg = Number(steerSlider.value);
    $('#demoValSteer').textContent = `${deg}°`;
    if (veh && veh.driveMode === 'manual') {
      veh.inputSteer = deg;
    }
  };
  $('#demoSteerLeft').onclick = () => {
    steerSlider.value = -90;
    steerSlider.dispatchEvent(new Event('input'));
  };
  $('#demoSteerCenter').onclick = () => {
    steerSlider.value = 0;
    steerSlider.dispatchEvent(new Event('input'));
  };
  $('#demoSteerRight').onclick = () => {
    steerSlider.value = 90;
    steerSlider.dispatchEvent(new Event('input'));
  };

  // Turn signals
  const setTurn = (sig) => {
    const veh = getSimVehicle();
    if (veh) {
      if (veh.driveMode !== 'manual') veh.driveMode = 'manual';
      veh.inputTurnSignal = sig;
      syncDemoControllerUI();
    }
  };
  $('#demoTurnLeft').onclick = () => setTurn('left');
  $('#demoTurnOff').onclick = () => setTurn('off');
  $('#demoTurnRight').onclick = () => setTurn('right');
  $('#demoTurnHazard').onclick = () => setTurn('hazard');

  // Headlights (simulated into IBCM 720:2101)
  const setHead = (h) => {
    const veh = getSimVehicle();
    if (veh) {
      if (veh.driveMode !== 'manual') veh.driveMode = 'manual';
      veh.inputHeadlights = h;
      syncDemoControllerUI();
    }
  };
  $('#demoHeadOff').onclick = () => setHead('off');
  $('#demoHeadDrl').onclick = () => setHead('drl');
  $('#demoHeadLow').onclick = () => setHead('low');
  $('#demoHeadHigh').onclick = () => setHead('high');
  $('#demoHeadAuto').onclick = () => setHead('auto');

  // Doors
  const toggleDoor = (mask) => {
    const veh = getSimVehicle();
    if (veh) {
      if (veh.driveMode !== 'manual') veh.driveMode = 'manual';
      veh.manualDoors ^= mask;
      syncDemoControllerUI();
    }
  };
  $('#demoDoorFR').onclick = () => toggleDoor(0x80);
  $('#demoDoorFL').onclick = () => toggleDoor(0x40);
  $('#demoDoorRR').onclick = () => toggleDoor(0x10);
  $('#demoDoorRL').onclick = () => toggleDoor(0x20);
  $('#demoDoorBoot').onclick = () => toggleDoor(0x08);

  // Misc
  $('#demoAcToggle').onclick = () => {
    const veh = getSimVehicle();
    if (veh) {
      veh.acActive = !veh.acActive;
      syncDemoControllerUI();
    }
  };
  $('#demoLockToggle').onclick = () => {
    const veh = getSimVehicle();
    if (veh) {
      veh.manualLocked = !veh.locked;
      syncDemoControllerUI();
    }
  };

  // Keyboard controls
  window.addEventListener('keydown', (e) => {
    if (mode !== 'demo') return;
    if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
    const veh = getSimVehicle();
    if (!veh) return;

    if (e.code === 'KeyW' || e.code === 'ArrowUp') {
      e.preventDefault();
      if (!isGasHolding) {
        if (veh.driveMode !== 'manual') veh.driveMode = 'manual';
        isGasHolding = true;
        gasBtn.classList.add('holding');
        veh.inputThrottle = 1.0;
        $('#demoValGas').textContent = '100%';
      }
    } else if (e.code === 'KeyS' || e.code === 'ArrowDown' || e.code === 'Space') {
      e.preventDefault();
      if (!isBrakeHolding) {
        if (veh.driveMode !== 'manual') veh.driveMode = 'manual';
        isBrakeHolding = true;
        brakeBtn.classList.add('holding');
        veh.inputBrake = 1.0;
        $('#demoValBrake').textContent = '100%';
      }
    } else if (e.code === 'Digit1') {
      $('#demoGearP').click();
    } else if (e.code === 'Digit2') {
      $('#demoGearR').click();
    } else if (e.code === 'Digit3') {
      $('#demoGearN').click();
    } else if (e.code === 'Digit4') {
      $('#demoGearD').click();
    } else if (e.code === 'KeyA' || e.code === 'ArrowLeft') {
      const v = Math.max(-450, Number(steerSlider.value) - 30);
      steerSlider.value = v;
      steerSlider.dispatchEvent(new Event('input'));
    } else if (e.code === 'KeyD' || e.code === 'ArrowRight') {
      const v = Math.min(450, Number(steerSlider.value) + 30);
      steerSlider.value = v;
      steerSlider.dispatchEvent(new Event('input'));
    } else if (e.code === 'KeyQ') {
      setTurn(veh.inputTurnSignal === 'left' ? 'off' : 'left');
    } else if (e.code === 'KeyE') {
      setTurn(veh.inputTurnSignal === 'right' ? 'off' : 'right');
    } else if (e.code === 'KeyH') {
      setTurn(veh.inputTurnSignal === 'hazard' ? 'off' : 'hazard');
    } else if (e.code === 'KeyL') {
      const order = ['off', 'drl', 'low', 'high', 'auto'];
      const cur = veh.inputHeadlights || 'auto';
      setHead(order[(order.indexOf(cur) + 1) % order.length]);
    }
  });

  window.addEventListener('keyup', (e) => {
    if (mode !== 'demo') return;
    const veh = getSimVehicle();
    if (e.code === 'KeyW' || e.code === 'ArrowUp') {
      isGasHolding = false;
      gasBtn.classList.remove('holding');
      if (veh) veh.inputThrottle = Number(gasSlider.value) / 100;
      $('#demoValGas').textContent = `${gasSlider.value}%`;
    } else if (e.code === 'KeyS' || e.code === 'ArrowDown' || e.code === 'Space') {
      isBrakeHolding = false;
      brakeBtn.classList.remove('holding');
      if (veh) veh.inputBrake = Number(brakeSlider.value) / 100;
      $('#demoValBrake').textContent = `${brakeSlider.value}%`;
    }
  });
}

// ============================================================================ connection
async function connect(kind) {
  if (mode !== 'idle') return;
  mode = 'connecting';
  setButtons();
  setStatus('connecting', kind === 'ble' ? 'กำลังเชื่อมต่อดองเกิล…' : 'กำลังเริ่มโหมดสาธิต…');
  hideBanner();
  try {
    transport = kind === 'ble' ? new BleTransport() : new SimTransport();
    await transport.connect();
    transport.onDisconnect = () => disconnect('อุปกรณ์ BLE ตัดการเชื่อมต่อ');
    consoleLog('warn', `Connected: ${transport.name} [${transport.profile}]`);
    setStatus('connecting', 'กำลังตั้งค่า ELM327…', transport.name);

    elm = new Elm327(transport, { caf0: settings.caf0, log: consoleLog });
    const version = await elm.init();
    const volts = await elm.readVoltage().catch(() => null);
    $('#perfVolt').textContent = volts?.toFixed(1) ?? '–';

    poller = new Poller(elm, {
      fastIntervalMs: settings.fastMs,
      slowIntervalMs: settings.slowS * 1000,
      turboLights: !!settings.turboLights,
      categories: new Set(settings.categories),
      onValues: (values, meta) => {
        tel.update(values, meta.ts);
        lastValuesAt = meta.ts;
        if ('dynamics' in values) {
          const d = values.dynamics;
          gTrail.push({ x: d.lateral_accel_ms2 / 9.81, y: d.longitudinal_accel_ms2 / 9.81 });
          if (gTrail.length > 40) gTrail.shift();
        }
        // Zero-latency realtime update when lighting / turn / brake / door frames arrive
        if ('lights' in values || 'turn_signals' in values || 'doors' in values || 'pedal_park' in values || 'body_status_2102' in values) {
          requestAnimationFrame(() => {
            renderLightingRealtime();
            if (activeTab() === 'body') renderBody();
          });
        }
      },
      onStatus: (s) => {
        if (s.type === 'cycle') {
          $('#perfCycle').textContent = s.cycleMs;
          $('#perfLatency').textContent = elm?.stats.lastLatencyMs ?? '–';
          tel.logRow();
        } else if (s.type === 'lights-tick') {
          $('#rtLightsMs').textContent = s.ms ?? '–';
          $('#rtLightsHz').textContent = s.hz || '–';
        }
      },
    });
    lastValuesAt = Date.now();
    poller.start();
    voltTimer = setInterval(async () => {
      const v = await elm?.readVoltage().catch(() => null);
      if (v != null) $('#perfVolt').textContent = v.toFixed(1);
    }, 30000);

    mode = kind === 'ble' ? 'live' : 'demo';
    if (mode === 'demo' && transport?.vehicle) {
      transport.vehicle.driveMode = 'manual';
      transport.vehicle.inputGear = 'D';
      syncDemoControllerUI();
    }
    setStatus(mode, kind === 'ble' ? 'เชื่อมต่อแล้ว · Live' : 'โหมดสาธิต (จำลอง)', `${transport.name} · ${version}${settings.caf0 ? ' · CAF0' : ''}`);
    requestWakeLock();
  } catch (e) {
    const cancelled = e?.name === 'NotFoundError' || /cancel/i.test(e?.message ?? '');
    consoleLog('err', e?.message ?? String(e));
    await teardown();
    mode = 'idle';
    setStatus(cancelled ? '' : 'error', cancelled ? 'ยังไม่เชื่อมต่อ' : 'เชื่อมต่อไม่สำเร็จ');
    if (!cancelled) toast(e?.message ?? String(e), true);
  }
  setButtons();
}

async function teardown() {
  poller?.stop();
  clearInterval(voltTimer);
  try { await transport?.disconnect(); } catch { /* ignore */ }
  poller = null; elm = null; transport = null;
  releaseWakeLock();
}

async function disconnect(reason) {
  if (mode === 'idle') return;
  if (tel.log) stopRecording();
  await teardown();
  mode = 'idle';
  setStatus('', 'ยังไม่เชื่อมต่อ');
  hideBanner();
  setButtons();
  if (reason) toast(reason);
}

// Screen wake lock keeps the phone display on while driving
async function requestWakeLock() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* not supported */ }
}
function releaseWakeLock() { wakeLock?.release?.(); wakeLock = null; }
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && (mode === 'live' || mode === 'demo')) requestWakeLock();
});

// ============================================================================ recording / export
function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

function startRecording() {
  tel.startLog();
  $('#btnRec').classList.add('on');
  $('#recText').textContent = 'STOP';
  $('#logState').textContent = 'กำลังบันทึก…';
  $('#btnExportCsv').disabled = true;
}
function stopRecording() {
  lastLog = tel.stopLog();
  $('#btnRec').classList.remove('on');
  $('#recText').textContent = 'REC';
  $('#logState').textContent = `หยุดแล้ว (${lastLog?.rows.length ?? 0} แถว)`;
  $('#btnExportCsv').disabled = !lastLog?.rows.length;
  if (lastLog?.rows.length) toast(`บันทึกแล้ว ${lastLog.rows.length} แถว — ดาวน์โหลดได้ที่แท็บ "ข้อมูลดิบ & บันทึก"`);
}
$('#btnRec').onclick = () => (tel.log ? stopRecording() : startRecording());
$('#btnExportCsv').onclick = () => lastLog?.rows.length && download(`aionv-log-${stamp()}.csv`, Telemetry.toCsv(lastLog.rows), 'text/csv');
$('#btnExportJson').onclick = () => download(`aionv-snapshot-${stamp()}.json`, JSON.stringify({ time: new Date().toISOString(), values: tel.values, trip: tel.trip, odoKm: tel.odoKm }, null, 2), 'application/json');

// ============================================================================ tabs
$$('#tabs button').forEach((btn) => {
  btn.onclick = () => {
    $$('#tabs button').forEach((b) => b.classList.toggle('active', b === btn));
    $$('.tab-page').forEach((p) => p.classList.toggle('active', p.id === `tab-${btn.dataset.tab}`));
    consoleDirty = true;
    lastTable = 0;
    render();
  };
});

// ============================================================================ settings UI
function initSettings() {
  const fast = $('#setFast');
  const slow = $('#setSlow');
  const cap = $('#setCapacity');
  const caf0 = $('#setCaf0');
  fast.value = settings.fastMs;
  slow.value = settings.slowS;
  cap.value = settings.capacity;
  caf0.checked = settings.caf0;

  fast.onchange = () => { settings.fastMs = Math.max(200, Number(fast.value) || 600); saveSettings(); if (poller) poller.fastIntervalMs = settings.fastMs; };
  slow.onchange = () => { settings.slowS = Math.max(5, Number(slow.value) || 20); saveSettings(); if (poller) poller.slowIntervalMs = settings.slowS * 1000; };
  cap.onchange = () => { settings.capacity = Number(cap.value) || BATTERY_NOMINAL_KWH; tel.capacityKwh = settings.capacity; saveSettings(); };
  caf0.onchange = () => { settings.caf0 = caf0.checked; saveSettings(); toast('จะมีผลเมื่อเชื่อมต่อครั้งถัดไป'); };

  const fs = $('#setCategories');
  for (const [key, label] of Object.entries(POLL_CATEGORIES)) {
    const l = document.createElement('label');
    l.innerHTML = `<input type="checkbox" value="${key}" ${settings.categories.includes(key) ? 'checked' : ''}/> ${label}`;
    l.querySelector('input').onchange = () => {
      settings.categories = $$('input', fs).filter((i) => i.checked).map((i) => i.value);
      saveSettings();
      if (poller) poller.categories = new Set(settings.categories);
    };
    fs.appendChild(l);
  }

  const resetTrip = () => { tel.resetTrip(); toast('รีเซ็ตทริปแล้ว'); };
  $('#btnResetTrip').onclick = resetTrip;
  $('#btnResetTrip2').onclick = resetTrip;
  $('#btnResetOdo').onclick = () => { if (confirm('รีเซ็ตระยะทางสะสมที่คำนวณได้?')) { tel.resetOdo(); toast('รีเซ็ตระยะสะสมแล้ว'); } };
  $('#btnRefreshSlow').onclick = () => { poller?.refreshSlow(); toast(poller ? 'กำลังดึงข้อมูลความถี่ต่ำ…' : 'ยังไม่ได้เชื่อมต่อ'); };
}

function initRealtimeLightControls() {
  const turboBtn = $('#btnTurboLights');
  const syncTurboBtn = () => {
    const on = !!settings.turboLights;
    turboBtn.classList.toggle('active', on);
    turboBtn.textContent = on ? '⚡ หยุด Turbo (กลับโหมดรวม)' : '⚡ ดึงไฟรถเร็วสุด (Turbo 720)';
  };
  syncTurboBtn();

  turboBtn.onclick = () => {
    settings.turboLights = !settings.turboLights;
    saveSettings();
    syncTurboBtn();
    poller?.setTurboLights(settings.turboLights);
    toast(settings.turboLights ? '⚡ เปิดโหมด Turbo 720: อ่านเฉพาะไฟรถต่อเนื่องความเร็วสูงสุด!' : 'กลับสู่โหมดดึงข้อมูลครบทุกกล่อง');
  };

  $('#btnHeadlightProbe').onclick = () => {
    $('#rtLearnPanel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    $('#rtLearnHint').textContent = 'กำลังพร้อมจับคู่! ปิดไฟหน้าทั้งหมดแล้วกด "1. ฐาน" ได้เลยครับ';
  };

  $('#btnLearnBase').onclick = () => {
    const raw = tel.get('lights')?.raw;
    if (raw == null) { toast('ยังไม่มีข้อมูลจาก 720:2101 (กดเชื่อมต่อหรือโหมดสาธิตก่อน)', true); return; }
    learnBase2101 = raw & ~(0x0800 | 0x0100); // Exclude brake/reverse bits from baseline
    $('#rtLearnHint').textContent = `บันทึกค่าฐานปิดไฟ 0x${learnBase2101.toString(16).toUpperCase().padStart(4, '0')} แล้ว → ขั้นต่อไปเปิดไฟต่ำแล้วกด "2. จับไฟต่ำ"`;
    toast(`บันทึกค่าฐานแล้ว (0x${learnBase2101.toString(16).toUpperCase().padStart(4, '0')})`);
  };

  $('#btnLearnLow').onclick = () => {
    const raw = tel.get('lights')?.raw;
    if (raw == null || learnBase2101 == null) { toast('กรุณากด "1. ฐาน (ปิดไฟ)" ก่อนเปิดไฟต่ำ', true); return; }
    const diff = (raw ^ learnBase2101) & raw & ~(0x0800 | 0x0100);
    if (!diff) { toast('ไม่พบบิตที่เปลี่ยนเป็น 1 ใน 720:2101 (ลองเช็คค่าในคอนโซล)', true); return; }
    settings.headlightLowMask = diff;
    saveSettings();
    renderLightingRealtime();
    toast(`จำบิตไฟต่ำสำเร็จ: 0x${diff.toString(16).toUpperCase()}`);
    $('#rtLearnHint').textContent = `จำไฟต่ำ 0x${diff.toString(16).toUpperCase()} แล้ว! เปิดไฟสูงแล้วกด "3. จับไฟสูง" ต่อได้ทันที`;
  };

  $('#btnLearnHigh').onclick = () => {
    const raw = tel.get('lights')?.raw;
    if (raw == null || learnBase2101 == null) { toast('กรุณากด "1. ฐาน (ปิดไฟ)" ก่อนเปิดไฟสูง', true); return; }
    const diff = (raw ^ learnBase2101) & raw & ~(0x0800 | 0x0100);
    const highOnly = diff & ~(settings.headlightLowMask || 0);
    const mask = highOnly || diff;
    if (!mask) { toast('ไม่พบบิตไฟสูงที่เปลี่ยนใน 720:2101', true); return; }
    settings.headlightHighMask = mask;
    saveSettings();
    renderLightingRealtime();
    toast(`จำบิตไฟสูงสำเร็จ: 0x${mask.toString(16).toUpperCase()}`);
  };

  $('#btnLearnClear').onclick = () => {
    learnBase2101 = null;
    settings.headlightLowMask = 0;
    settings.headlightHighMask = 0;
    saveSettings();
    renderLightingRealtime();
    $('#rtLearnHint').textContent = 'ล้างมาสก์ไฟหน้าแล้ว — พร้อมสำหรับเรียนรู้ใหม่จากรถจริง';
    toast('ล้างค่าบิตไฟหน้าแล้ว');
  };
}

// ============================================================================ boot
$('#btnBle').onclick = () => connect('ble');
$('#btnDemo').onclick = () => connect('demo');
$('#btnDisconnect').onclick = () => disconnect();
initSettings();
initDemoControls();
initRealtimeLightControls();
setButtons();

if (!BleTransport.isSupported()) {
  showBanner(window.isSecureContext
    ? 'เบราว์เซอร์นี้ไม่รองรับ Web Bluetooth — ใช้ Chrome/Edge บน Android หรือคอมพิวเตอร์ (ยังทดลอง "โหมดสาธิต" ได้)'
    : 'Web Bluetooth ต้องเปิดผ่าน https:// หรือ http://localhost — ตอนนี้ใช้ได้เฉพาะ "โหมดสาธิต"');
}

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Demo deep-link: index.html?demo=1
if (new URLSearchParams(location.search).has('demo')) connect('demo');
