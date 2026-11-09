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
const DEFAULTS = { fastMs: 600, slowS: 20, categories: Object.keys(POLL_CATEGORIES), caf0: false, capacity: BATTERY_NOMINAL_KWH };
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
  const speed = tel.speedKmh;
  gaugeSpeed.set(speed);
  gaugePower.set(tel.powerKw);
  const gear = tel.get('gear');
  $$('#gearStrip span').forEach((s) => s.classList.toggle('on', s.textContent === gear));
  const soc = tel.soc;
  const ring = $('#socRingFg');
  ring.style.strokeDashoffset = soc == null ? 314.16 : 314.16 * (1 - Math.max(0, Math.min(100, soc)) / 100);
  ring.style.stroke = soc == null ? '' : soc < 15 ? 'var(--red)' : soc < 30 ? 'var(--amber)' : 'var(--green)';
  drawHistory($('#historyChart'), tel.history);
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
      categories: new Set(settings.categories),
      onValues: (values, meta) => {
        tel.update(values, meta.ts);
        lastValuesAt = meta.ts;
        if ('dynamics' in values) {
          const d = values.dynamics;
          gTrail.push({ x: d.lateral_accel_ms2 / 9.81, y: d.longitudinal_accel_ms2 / 9.81 });
          if (gTrail.length > 40) gTrail.shift();
        }
      },
      onStatus: (s) => {
        if (s.type === 'cycle') {
          $('#perfCycle').textContent = s.cycleMs;
          $('#perfLatency').textContent = elm?.stats.lastLatencyMs ?? '–';
          tel.logRow();
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

// ============================================================================ boot
$('#btnBle').onclick = () => connect('ble');
$('#btnDemo').onclick = () => connect('demo');
$('#btnDisconnect').onclick = () => disconnect();
initSettings();
initDemoControls();
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
