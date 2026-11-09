/**
 * Telemetry store: latest values, derived metrics (power, speed, trip/odometer integration,
 * efficiency, range estimate), short history for charts, and CSV logging. DOM-free.
 */
import { BATTERY_NOMINAL_KWH } from './decoder.js';

const MAX_GAP_S = 5; // don't integrate across gaps longer than this
const HISTORY_S = 180;
const STORE_KEY = 'aionv.trip.v1';

export class Telemetry {
  constructor(storage = globalThis.localStorage ?? null) {
    this.storage = storage;
    this.values = {};
    this.ts = {};
    this.history = []; // { t, speed, power, soc }
    this.log = null; // { rows: [], startedAt }
    this.capacityKwh = BATTERY_NOMINAL_KWH;
    const saved = this._load();
    this.trip = { km: 0, kwh: 0, regenKwh: 0, startedAt: Date.now(), ...saved.trip };
    this.odoKm = saved.odoKm ?? 0;
    this._lastSpeedTs = null;
    this._lastPowerTs = null;
    this._lastSave = 0;
  }

  _load() {
    try { return JSON.parse(this.storage?.getItem(STORE_KEY) ?? '{}') || {}; } catch { return {}; }
  }

  _save(force = false) {
    const now = Date.now();
    if (!force && now - this._lastSave < 10000) return;
    this._lastSave = now;
    try { this.storage?.setItem(STORE_KEY, JSON.stringify({ trip: this.trip, odoKm: this.odoKm })); } catch { /* ignore */ }
  }

  resetTrip() {
    this.trip = { km: 0, kwh: 0, regenKwh: 0, startedAt: Date.now() };
    this._save(true);
  }

  resetOdo() {
    this.odoKm = 0;
    this._save(true);
  }

  get(name) { return this.values[name]; }
  age(name) { return this.ts[name] ? Date.now() - this.ts[name] : Infinity; }

  /** Merge freshly decoded values. */
  update(values, ts = Date.now()) {
    for (const [k, v] of Object.entries(values)) {
      this.values[k] = v;
      this.ts[k] = ts;
    }
    if ('wheel_speed_fl' in values || 'wheel_speed_rr' in values) this._integrateDistance(ts);
    if ('pack_current' in values || 'pack_voltage' in values) this._integrateEnergy(ts);
    this._save();
  }

  /** Vehicle speed = mean of the 4 wheel speeds (signed by motor direction). */
  get speedKmh() {
    const w = ['wheel_speed_fl', 'wheel_speed_fr', 'wheel_speed_rl', 'wheel_speed_rr'].map((k) => this.values[k]).filter((x) => typeof x === 'number');
    if (!w.length) return null;
    return w.reduce((a, b) => a + b, 0) / w.length;
  }

  get powerKw() {
    const v = this.values.pack_voltage;
    const i = this.values.pack_current;
    return typeof v === 'number' && typeof i === 'number' ? (v * i) / 1000 : null;
  }

  get cellDeltaMv() {
    const { cell_max_mv: mx, cell_min_mv: mn, cell_voltages: cells } = this.values;
    if (Array.isArray(cells) && cells.length) return Math.max(...cells) - Math.min(...cells);
    return typeof mx === 'number' && typeof mn === 'number' ? mx - mn : null;
  }

  get efficiencyKwh100() {
    return this.trip.km >= 0.5 ? (this.trip.kwh / this.trip.km) * 100 : null;
  }

  get soc() {
    return this.values.soc_precise ?? this.values.soc_display ?? this.values.soc_display_alt ?? null;
  }

  /** Remaining energy & range estimate (uses trip efficiency, falls back to 15.5 kWh/100 km). */
  get remainingKwh() {
    const soc = this.soc;
    if (soc == null) return null;
    const soh = this.values.soh ?? 100;
    return (soc / 100) * this.capacityKwh * (soh / 100);
  }

  get rangeKm() {
    const e = this.remainingKwh;
    if (e == null) return null;
    let eff = this.efficiencyKwh100;
    if (eff == null || eff < 8 || eff > 40) eff = 15.5;
    return (e / eff) * 100;
  }

  _integrateDistance(ts) {
    const v = this.speedKmh;
    if (this._lastSpeedTs != null && v != null) {
      const dt = (ts - this._lastSpeedTs) / 1000;
      if (dt > 0 && dt < MAX_GAP_S) {
        const d = (Math.abs(v) / 3600) * dt;
        this.trip.km += d;
        this.odoKm += d;
      }
    }
    this._lastSpeedTs = ts;
    this._pushHistory(ts);
  }

  _integrateEnergy(ts) {
    const p = this.powerKw;
    if (this._lastPowerTs != null && p != null) {
      const dt = (ts - this._lastPowerTs) / 1000;
      if (dt > 0 && dt < MAX_GAP_S) {
        const e = (p * dt) / 3600;
        this.trip.kwh += e;
        if (e < 0) this.trip.regenKwh += -e;
      }
    }
    this._lastPowerTs = ts;
  }

  _pushHistory(ts) {
    this.history.push({ t: ts, speed: this.speedKmh ?? 0, power: this.powerKw ?? 0, soc: this.soc });
    const cutoff = ts - HISTORY_S * 1000;
    while (this.history.length && this.history[0].t < cutoff) this.history.shift();
  }

  // ---------------------------------------------------------------- CSV logging
  startLog() { this.log = { rows: [], startedAt: Date.now() }; }
  stopLog() { const l = this.log; this.log = null; return l; }

  /** Flattened scalar snapshot (arrays are summarized, objects expanded). */
  snapshot() {
    const row = { time: new Date().toISOString(), speed_kmh: round2(this.speedKmh), power_kw: round2(this.powerKw), trip_km: round2(this.trip.km), trip_kwh: round2(this.trip.kwh) };
    for (const [k, v] of Object.entries(this.values)) {
      if (Array.isArray(v)) continue;
      if (v && typeof v === 'object') for (const [k2, v2] of Object.entries(v)) row[`${k}.${k2}`] = v2;
      else row[k] = v;
    }
    return row;
  }

  logRow() {
    if (!this.log) return;
    this.log.rows.push(this.snapshot());
    if (this.log.rows.length > 200000) this.log.rows.shift();
  }

  static toCsv(rows) {
    const cols = [...rows.reduce((s, r) => { Object.keys(r).forEach((k) => s.add(k)); return s; }, new Set())];
    const esc = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
  }
}

const round2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
