/**
 * Polling scheduler (AGENTS.md §5.3)
 * - Fast tier every ~0.6 s (wheel speeds, motor, pack V/I, gear, body flags, IPB)
 * - Slow tier every ~20 s, interleaved one request per fast cycle so the fast cadence is preserved.
 */
import { POLL_GROUPS } from './decoder.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Poller {
  constructor(elm, { fastIntervalMs = 600, slowIntervalMs = 20000, categories = null, onValues = () => {}, onStatus = () => {} } = {}) {
    this.elm = elm;
    this.fastIntervalMs = fastIntervalMs;
    this.slowIntervalMs = slowIntervalMs;
    this.categories = categories; // Set of enabled categories, or null = all
    this.onValues = onValues;
    this.onStatus = onStatus;
    this.running = false;
    this.slowQueue = [];
    this.lastSlowFill = -Infinity;
    this.cycleMs = 0;
    this.groupErrors = new Map();
  }

  _enabled(g) {
    if (this.categories && !this.categories.has(g.category)) return false;
    // Back off groups that keep failing (e.g. ECU asleep / DID not supported): skip 4 of 5 cycles.
    const errs = this.groupErrors.get(g) ?? 0;
    if (errs >= 3) {
      this.groupErrors.set(g, errs + 1);
      return errs % 5 === 0;
    }
    return true;
  }

  async _run(group) {
    try {
      const res = await this.elm.readDids(group.tx, group.dids);
      if (Object.keys(res.values).length) {
        this.groupErrors.set(group, 0);
        this.onValues(res.values, { group, ts: Date.now(), payloadHex: res.payloadHex, error: res.error });
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

    while (this.running) {
      const t0 = performance.now();
      for (const g of fast) {
        if (!this.running) return;
        if (this._enabled(g)) await this._run(g);
      }
      if (!this.slowQueue.length && t0 - this.lastSlowFill >= this.slowIntervalMs) {
        this.slowQueue = [...slow];
        this.lastSlowFill = t0;
      }
      // Interleave up to 2 slow requests per fast cycle
      for (let i = 0; i < 2 && this.slowQueue.length && this.running; i++) {
        const g = this.slowQueue.shift();
        if (this._enabled(g)) await this._run(g);
      }
      this.cycleMs = Math.round(performance.now() - t0);
      this.onStatus({ type: 'cycle', cycleMs: this.cycleMs, slowPending: this.slowQueue.length });
      const wait = this.fastIntervalMs - (performance.now() - t0);
      if (wait > 0) await sleep(wait);
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
