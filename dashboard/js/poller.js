/**
 * High-speed Polling Scheduler for GAC Aion V 602 UDS Telemetry
 *
 * Modes:
 * 1. Normal Tiered Priority Mode:
 *    - Fast tier every cycle (wheel speeds, motor, pack V/I, gear, body flags, IPB).
 *    - Interleaves EXPRESS_LIGHTS_TARGET (720: 2100, 2101, 2102) mid-cycle & post-slow
 *      so turn signals, brake lights, and lamp outputs refresh at ~2-3x cadence (~200 ms).
 *    - Slow tier every ~20 s, interleaved 1-2 requests per fast cycle.
 * 2. Turbo Lights Lock-On Mode (`setTurboLights(true)`):
 *    - Locks ELM327/vLinker sticky header onto IBCM (720) with ZERO ECU switches,
 *      looping `22 2100 2101 2102 2` back-to-back at maximum bus/BLE speed (~25-45 Hz).
 */
import { POLL_GROUPS, EXPRESS_LIGHTS_TARGET } from './decoder.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Poller {
  constructor(
    elm,
    {
      fastIntervalMs = 500,
      slowIntervalMs = 20000,
      turboLights = false,
      turboIntervalMs = 15,
      categories = null,
      onValues = () => {},
      onStatus = () => {},
    } = {},
  ) {
    this.elm = elm;
    this.fastIntervalMs = fastIntervalMs;
    this.slowIntervalMs = slowIntervalMs;
    this.turboLights = turboLights;
    this.turboIntervalMs = turboIntervalMs;
    this.categories = categories; // Set of enabled categories, or null = all
    this.onValues = onValues;
    this.onStatus = onStatus;
    this.running = false;
    this.slowQueue = [];
    this.lastSlowFill = -Infinity;
    this.cycleMs = 0;
    this.lightsMs = 0;
    this.lightsHz = 0;
    this._lastLightsAt = 0;
    this.groupErrors = new Map();
  }

  setTurboLights(enabled) {
    this.turboLights = !!enabled;
  }

  _enabled(g) {
    if (this.categories && !this.categories.has(g.category)) return false;
    const errs = this.groupErrors.get(g) ?? 0;
    if (errs >= 3) {
      this.groupErrors.set(g, errs + 1);
      return errs % 5 === 0;
    }
    return true;
  }

  async _run(group) {
    const t0 = performance.now();
    try {
      const res = await this.elm.readDids(group.tx, group.dids);
      const elapsed = Math.round(performance.now() - t0);
      if (Object.keys(res.values).length) {
        this.groupErrors.set(group, 0);
        const now = performance.now();
        if (group.tx === EXPRESS_LIGHTS_TARGET.tx && group.dids.includes('2101')) {
          this.lightsMs = elapsed;
          if (this._lastLightsAt > 0) {
            const dt = now - this._lastLightsAt;
            if (dt > 0) this.lightsHz = Math.round((1000 / dt) * 10) / 10;
          }
          this._lastLightsAt = now;
          this.onStatus({ type: 'lights-tick', ms: this.lightsMs, hz: this.lightsHz, turbo: this.turboLights });
        }
        this.onValues(res.values, { group, ts: Date.now(), payloadHex: res.payloadHex, error: res.error, elapsedMs: elapsed });
      } else {
        this.groupErrors.set(group, (this.groupErrors.get(group) ?? 0) + 1);
        this.onStatus({ type: 'group-error', group, error: res.error });
      }
    } catch (e) {
      this.groupErrors.set(group, (this.groupErrors.get(group) ?? 0) + 1);
      this.onStatus({ type: 'group-error', group, error: e.message });
    }
  }

  async start() {
    if (this.running) return;
    this.running = true;
    const fast = POLL_GROUPS.filter((g) => g.tier === 'fast');
    const slow = POLL_GROUPS.filter((g) => g.tier === 'slow');
    const lightsGroup = fast.find((g) => g.priority === 'lights') ?? EXPRESS_LIGHTS_TARGET;

    while (this.running) {
      // Dedicated ultra-fast lock-on loop for real-time Headlights / Turn Signals / Brake Lights
      if (this.turboLights) {
        const t0 = performance.now();
        await this._run(lightsGroup);
        this.cycleMs = Math.round(performance.now() - t0);
        this.onStatus({ type: 'cycle', cycleMs: this.cycleMs, slowPending: this.slowQueue.length, turbo: true });
        if (this.turboIntervalMs > 0) await sleep(this.turboIntervalMs);
        continue;
      }

      const t0 = performance.now();
      const nonLightFast = fast.filter((g) => g !== lightsGroup);
      const midIdx = Math.floor(nonLightFast.length / 2);

      // Run lights first for crisp edge responsiveness
      if (this._enabled(lightsGroup)) await this._run(lightsGroup);

      for (let i = 0; i < nonLightFast.length; i++) {
        if (!this.running || this.turboLights) break;
        const g = nonLightFast[i];
        if (this._enabled(g)) await this._run(g);
        // Interleave an extra lights refresh mid-cycle so turn signals/brakes stay 2x faster
        if (i === midIdx && !this.turboLights && this._enabled(lightsGroup)) {
          await this._run(lightsGroup);
        }
      }

      if (!this.turboLights && !this.slowQueue.length && t0 - this.lastSlowFill >= this.slowIntervalMs) {
        this.slowQueue = [...slow];
        this.lastSlowFill = t0;
      }
      // Interleave 1 slow request per fast cycle (skip heavy cell reads while turbo toggle flipped)
      if (!this.turboLights && this.slowQueue.length && this.running) {
        const sg = this.slowQueue.shift();
        if (this._enabled(sg)) await this._run(sg);
      }

      this.cycleMs = Math.round(performance.now() - t0);
      this.onStatus({ type: 'cycle', cycleMs: this.cycleMs, slowPending: this.slowQueue.length, turbo: false });
      const wait = this.fastIntervalMs - (performance.now() - t0);
      if (wait > 0 && !this.turboLights) await sleep(wait);
    }
  }

  /** Forces an immediate refresh of all slow-tier data. */
  refreshSlow() {
    this.slowQueue = [];
    this.lastSlowFill = -Infinity;
  }

  stop() {
    this.running = false;
  }
}
