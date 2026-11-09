/**
 * ELM327 / STN driver over an abstract text transport (BLE or simulator).
 *
 * Transport interface:
 *   connect(): Promise<void>
 *   disconnect(): Promise<void>
 *   write(text: string): Promise<void>
 *   onData: (chunk: string) => void          (assigned by the driver)
 *   onDisconnect: () => void                 (assigned by the driver)
 *   name: string
 */
import { buildUdsReadCommand, ecuByTx, parseElmResponse, parseUds62Payload, assertReadOnly, bytesToHex } from './decoder.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Elm327 {
  constructor(transport, { caf0 = false, log = () => {} } = {}) {
    this.transport = transport;
    this.caf0 = caf0;
    this.log = log;
    this.buffer = '';
    this.pending = null;
    this.queue = Promise.resolve();
    this.currentTx = null;
    this.version = '';
    this.fcSupported = true;
    this.stats = { commands: 0, timeouts: 0, errors: 0, lastLatencyMs: 0 };

    transport.onData = (chunk) => this._onData(chunk);
  }

  _onData(chunk) {
    this.buffer += chunk;
    const idx = this.buffer.indexOf('>');
    if (idx === -1) return;
    const text = this.buffer.slice(0, idx);
    this.buffer = this.buffer.slice(idx + 1);
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      clearTimeout(p.timer);
      p.resolve(text);
    }
  }

  /** Sends a raw line and resolves with the response text (before the '>' prompt). Serialized. */
  send(cmd, timeoutMs = 2000) {
    const run = async () => {
      const t0 = performance.now();
      this.buffer = '';
      const result = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending = null;
          this.stats.timeouts++;
          reject(new Error(`TIMEOUT: ${cmd}`));
        }, timeoutMs);
        this.pending = { resolve, reject, timer };
      });
      this.log('tx', cmd);
      await this.transport.write(cmd + '\r');
      try {
        let text = await result;
        // Strip echo (ATZ re-enables echo until ATE0 is processed)
        text = text
          .split(/[\r\n]+/)
          .filter((l) => l.trim() && l.trim().replace(/\s+/g, '').toUpperCase() !== cmd.replace(/\s+/g, '').toUpperCase())
          .join('\n');
        this.stats.commands++;
        this.stats.lastLatencyMs = Math.round(performance.now() - t0);
        this.log('rx', text || '(empty)');
        return text;
      } catch (e) {
        this.log('err', e.message);
        await sleep(250); // let any late response drain
        this.buffer = '';
        throw e;
      }
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  async init() {
    const atz = await this.send('ATZ', 4000).catch(() => '');
    await sleep(300);
    const m = /ELM327\s*v?[\d.]+|STN\d+[^\n]*/i.exec(atz);
    const cmds = ['ATE0', 'ATL0', 'ATS0', 'ATH1', 'ATSP6', this.caf0 ? 'ATCAF0' : 'ATCAF1', 'ATAT1'];
    for (const c of cmds) await this.send(c);
    const ati = await this.send('ATI').catch(() => '');
    this.version = (m?.[0] || ati || 'ELM327').trim();

    // Flow control: send FC frames to the ECU request ID (needed for 720/7A0-style +0x80 pairs).
    const r1 = await this.send('ATFCSH 7E2');
    const r2 = await this.send('ATFCSD 30 00 00');
    const r3 = await this.send('ATFCSM 1');
    this.fcSupported = ![r1, r2, r3].some((r) => r.includes('?'));
    if (!this.fcSupported) this.log('warn', 'Adapter does not support ATFCSH/ATFCSM — multi-frame from non 7Ex ECUs may fail');
    this.currentTx = null;
    return this.version;
  }

  async readVoltage() {
    const r = await this.send('ATRV');
    const m = /([\d.]+)\s*V/i.exec(r);
    return m ? parseFloat(m[1]) : null;
  }

  async selectEcu(tx) {
    tx = tx.toUpperCase();
    if (this.currentTx === tx) return;
    const ecu = ecuByTx(tx);
    if (!ecu) throw new Error(`Unknown ECU ${tx}`);
    await this.send(`ATSH ${ecu.tx}`);
    await this.send(`ATCRA ${ecu.rx}`);
    if (this.fcSupported) await this.send(`ATFCSH ${ecu.tx}`);
    this.currentTx = tx;
  }

  /**
   * Reads up to 3 DIDs from one ECU via UDS 0x22.
   * @returns {Promise<{ values: Record<string, any>, payloadHex?: string, error?: string, incomplete?: boolean }>}
   */
  async readDids(tx, dids) {
    await this.selectEcu(tx);
    const cmd = buildUdsReadCommand(tx, dids, { caf0: this.caf0 });
    assertReadOnly(this.caf0 ? cmd.slice(2) : cmd);
    const big = dids.some((d) => ['1150', '1151', '1180'].includes(d));
    const text = await this.send(cmd, big ? 5000 : 2000);
    const res = parseElmResponse(text, ecuByTx(tx).rx);
    if (!res.ok || !res.payload) {
      this.stats.errors++;
      return { values: {}, error: res.error };
    }
    try {
      return { values: parseUds62Payload(tx, res.payload), payloadHex: bytesToHex(res.payload), incomplete: res.incomplete, error: res.incomplete ? res.error : undefined };
    } catch (e) {
      this.stats.errors++;
      return { values: {}, error: e.message };
    }
  }
}
