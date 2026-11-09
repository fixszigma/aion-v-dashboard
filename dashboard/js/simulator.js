/**
 * Demo mode: an ELM327 emulator + GAC Aion V 602 vehicle model.
 *
 * Simulates all ECU modules per https://www.aionv.app/pages/OBD-MODULES.html and AGENTS.md:
 * - BMS (7E2): Pack V, Pack I, Cell V (112 cells), Battery temps (24 points), BMU temps (16 points), SoC, SoH, CEC/CED
 * - VCU (7E3): 4 wheel speeds (FL/FR/RL/RR with Ackermann geometry), Gear (P/R/N/D), SoC 0.5%, AC, Motor temps, Limits
 * - MCU (7E4): Motor RPM (signed around 32767), Motor torque (around 1100), Inverter DC-Bus
 * - CCU (7E6): 12V DC-DC output, target, charger temp
 * - IBCM (720): TPMS (4 wheels psi/°C), Doors bitmask, Pedal/Park switch, Turn signals (L/R/Hazard), Brake/Reverse lights
 * - IPB (710): Steering angle, lateral accel, lon accel, yaw rate, brake pressure
 * - Door R/L (719/718): Lock status, windows percentage
 *
 * Supports two modes:
 * - 'auto': Runs a pre-recorded realistic city & highway driving cycle.
 * - 'manual': Full interactive real-time control (Gas pedal, Brake pedal, P/R/N/D gears, Turn signals, Steering, Doors).
 */
import { ecuByTx, ALLOWED_UDS_SERVICES, CELL_COUNT, TEMP_SENSOR_COUNT, BMU_TEMP_COUNT, BATTERY_NOMINAL_KWH } from './decoder.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const be16 = (v) => { v = clamp(Math.round(v), 0, 0xffff); return [(v >> 8) & 0xff, v & 0xff]; };
const be24 = (v) => { v = clamp(Math.round(v), 0, 0xffffff); return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]; };
const b8 = (v) => clamp(Math.round(v), 0, 0xff);
const hex2 = (x) => x.toString(16).toUpperCase().padStart(2, '0');

// Keyframes for auto mode: [time s, speed km/h (negative = reverse), gear]
const CYCLE = [
  [0, 0, 'P'], [10, 0, 'P'], [12, 0, 'D'], [35, 80, 'D'], [85, 88, 'D'], [100, 40, 'D'], [140, 45, 'D'],
  [160, 0, 'D'], [172, 0, 'D'], [174, 0, 'R'], [179, -6, 'R'], [184, 0, 'R'], [186, 0, 'P'], [200, 0, 'P'],
  [202, 0, 'D'], [214, 110, 'D'], [240, 112, 'D'], [262, 0, 'D'], [266, 0, 'P'], [275, 0, 'P'],
];
const CYCLE_LEN = CYCLE[CYCLE.length - 1][0];

function cycleAt(t) {
  const tc = t % CYCLE_LEN;
  for (let i = 0; i < CYCLE.length - 1; i++) {
    const [t0, v0, g0] = CYCLE[i];
    const [t1, v1] = CYCLE[i + 1];
    if (tc >= t0 && tc < t1) return { tc, speed: v0 + ((v1 - v0) * (tc - t0)) / (t1 - t0), gear: g0 };
  }
  return { tc, speed: 0, gear: 'P' };
}

export class SimVehicle {
  constructor() {
    this.driveMode = 'auto'; // 'auto' | 'manual'
    this.t = 0;

    // Interactive user inputs (used in 'manual' mode)
    this.inputThrottle = 0; // 0.0 to 1.0 (accelerator pedal)
    this.inputBrake = 0;    // 0.0 to 1.0 (brake pedal)
    this.inputGear = 'P';   // 'P', 'R', 'N', 'D'
    this.inputSteer = 0;    // -450° to +450° (steering wheel angle, - = left, + = right)
    this.inputTurnSignal = 'off'; // 'off' | 'left' | 'right' | 'hazard'
    this.manualDoors = 0;   // Bitmask: 0x80 FR, 0x40 FL, 0x20 RL, 0x10 RR, 0x08 Boot
    this.manualLocked = null; // null = auto by speed, true = locked, false = unlocked

    // Vehicle physics state
    this.soc = 87.4;
    this.soh = 99.12;
    this.cec = 129.4;
    this.ced = 65.7;
    this.speed = 0;       // km/h (signed)
    this.accel = 0;       // m/s²
    this.gear = 'P';
    this.powerKw = 0;
    this.current = 0;
    this.voltage = 372.5;
    this.torqueNm = 0;
    this.motorTemp = 32;
    this.batTempBase = 29;
    this.tireTempRise = 0;
    this.steer = 0;       // degrees
    this.yaw = 0;         // deg/s
    this.lat = 0;         // m/s²
    this.brake = 0;       // raw brake pressure in IPB (0 - 2500)
    this.brakeSwitch = false; // brake pedal switch bit
    this.acActive = true;
    this.noise = Math.random;

    // Fixed realistic cell deviations (mV) — cell 41 weakest, cell 108 strongest (1-based)
    this.cellOffsets = Array.from({ length: CELL_COUNT }, (_, i) => Math.round(Math.sin(i * 1.7) * 2));
    this.cellOffsets[40] = -5;
    this.cellOffsets[107] = 4;
    this.tempOffsets = Array.from({ length: TEMP_SENSOR_COUNT }, (_, i) => (i % 6 === 2 ? 1.5 : 0) + Math.cos(i) * 0.8);
  }

  /**
   * Physics simulation step.
   * @param {number} dt Time step in seconds.
   */
  step(dt) {
    this.t += dt;
    const prevSpeed = this.speed;

    if (this.driveMode === 'manual') {
      this._stepManual(dt, prevSpeed);
    } else {
      this._stepAuto(dt, prevSpeed);
    }

    const v = Math.abs(this.speed) / 3.6; // m/s

    // Thermal model
    this.motorTemp += ((32 + Math.abs(this.torqueNm) * 0.12 + v * 0.05 - this.motorTemp) * dt) / 90;
    this.batTempBase += ((29 + Math.abs(this.powerKw) * 0.035 - this.batTempBase) * dt) / 300;
    this.tireTempRise += ((v * 0.15 - this.tireTempRise) * dt) / 120;

    // Lateral dynamics (Ackermann steering geometry: wheelbase L=2.83m, steering ratio ~15:1)
    const steerWheel = this.steer;
    const roadWheelRad = ((steerWheel / 15.0) * Math.PI) / 180;
    const yawRad = (v / 2.83) * Math.tan(roadWheelRad);
    this.yaw = (yawRad * 180) / Math.PI;
    this.lat = v * yawRad;
  }

  _stepAuto(dt, prevSpeed) {
    const c = cycleAt(this.t);
    this.speed = c.speed + (c.speed > 20 ? Math.sin(this.t * 0.7) * 1.2 : 0);
    this.gear = c.gear;
    this.tc = c.tc;
    this.accel = (Math.abs(this.speed) - Math.abs(prevSpeed)) / 3.6 / dt;
    const v = Math.abs(this.speed) / 3.6;

    // Power model (m = 1900 kg, CdA = 0.7, Crr = 0.010)
    const force = 1900 * this.accel + 0.5 * 1.2 * 0.7 * v * v + 0.010 * 1900 * 9.81 * (v > 0.1 ? 1 : 0);
    let pMech = (force * v) / 1000;
    let pBat = pMech >= 0 ? pMech / 0.9 : Math.max(pMech * 0.7, -60);
    this.regenLimited = pMech < 0 && pMech * 0.7 < -60;
    pBat += 0.6 + 1.4; // aux + A/C
    this.powerKw = pBat;
    this.torqueNm = (force * 0.36) / 9.6;

    const ocv = CELL_COUNT * (3.2 + 0.15 * (this.soc / 100));
    this.current = (pBat * 1000) / ocv;
    this.voltage = ocv - this.current * 0.08;
    this.current = (pBat * 1000) / this.voltage;

    const dE = (pBat * dt) / 3600;
    this.soc = clamp(this.soc - (dE / BATTERY_NOMINAL_KWH) * 100, 5, 100);
    if (dE > 0) this.ced += dE; else this.cec -= dE;

    const tc = c.tc;
    this.steer = tc > 105 && tc < 150 ? Math.sin((tc - 105) * 0.35) * 85 : tc > 174 && tc < 184 ? -220 : Math.sin(this.t * 0.3) * 2;
    this.brake = this.accel < -1.6 ? (-this.accel - 1.6) * 600 : this.gear === 'D' && v < 0.1 ? 120 : 0;
    this.brakeSwitch = this.brake > 50 || this.accel < -0.5;
  }

  _stepManual(dt, prevSpeed) {
    this.gear = this.inputGear;
    this.steer = this.inputSteer;
    const throttle = clamp(this.inputThrottle, 0, 1);
    const brake = clamp(this.inputBrake, 0, 1);
    this.brakeSwitch = brake > 0.05;
    this.brake = Math.round(brake * 1800);

    const m = 1900; // kg
    let v = this.speed / 3.6; // signed velocity (m/s)

    // Road resistances
    const fDrag = 0.5 * 1.2 * 0.7 * v * Math.abs(v);
    const fRr = 0.010 * m * 9.81 * (Math.abs(v) > 0.02 ? Math.sign(v) : 0);
    let fMotor = 0;
    let pMech = 0;

    if (this.gear === 'P') {
      // Park lock engaged
      this.speed = 0;
      this.accel = 0;
      this.torqueNm = 0;
      fMotor = 0;
      pMech = 0;
    } else if (this.gear === 'N') {
      // Neutral: freewheeling, engine can rev with gas pedal but no wheel torque
      const fBrake = brake * m * 7.5 * (Math.abs(v) > 0.02 ? Math.sign(v) : 0);
      const fTotal = -(fDrag + fRr + fBrake);
      const a = fTotal / m;
      v += a * dt;
      if (Math.sign(v) !== Math.sign(prevSpeed) && prevSpeed !== 0) v = 0;
      this.speed = v * 3.6;
      this.accel = a;
      this.torqueNm = 0;
      pMech = throttle * 12.0; // slight idle electrical drain when revving in N
    } else if (this.gear === 'D') {
      // Drive: forward
      let tMotor = 0;
      if (throttle > 0) {
        // Accelerating in D (max 225 Nm, 150 kW)
        const tMax = Math.min(225, (150 * 1000) / Math.max(10, Math.abs(v) / 0.36 * 9.6));
        tMotor = throttle * tMax;
      } else if (brake === 0) {
        // Creep torque up to ~7 km/h, mild coasting regen above that
        if (this.speed < 7.0) {
          tMotor = clamp((7.0 - this.speed) * 8.0, 0, 45);
        } else {
          tMotor = -18; // gentle regen coast
        }
      }

      // Braking: blended regen + friction
      let fBrake = 0;
      if (brake > 0) {
        const tRegen = -Math.min(130, brake * 180);
        tMotor += tRegen;
        fBrake = brake * m * 7.0; // friction brakes
      }

      this.torqueNm = tMotor;
      fMotor = (tMotor * 9.6) / 0.36; // gear ratio 9.6:1, tyre radius 0.36m
      const fTotal = fMotor - fBrake - fDrag - fRr;
      const a = fTotal / m;
      v = Math.max(0, Math.min(165 / 3.6, v + a * dt));
      if (brake > 0.1 && v < 0.1) v = 0;
      this.speed = v * 3.6;
      this.accel = (this.speed - prevSpeed) / 3.6 / dt;
      pMech = (fMotor * v) / 1000;
    } else if (this.gear === 'R') {
      // Reverse: backward (capped at -25 km/h)
      let tMotor = 0;
      if (throttle > 0) {
        tMotor = -throttle * 120; // reverse torque
      } else if (brake === 0) {
        if (this.speed > -5.0) tMotor = clamp((-5.0 - this.speed) * 6.0, -35, 0);
      }

      let fBrake = 0;
      if (brake > 0) fBrake = brake * m * 7.0;

      this.torqueNm = tMotor;
      fMotor = (tMotor * 9.6) / 0.36;
      const fTotal = fMotor + (v < -0.05 ? fBrake : 0) - fDrag - fRr;
      const a = fTotal / m;
      v = Math.max(-25 / 3.6, Math.min(0, v + a * dt));
      if (brake > 0.1 && v > -0.1) v = 0;
      this.speed = v * 3.6;
      this.accel = (this.speed - prevSpeed) / 3.6 / dt;
      pMech = Math.abs(fMotor * v) / 1000;
    }

    // Battery pack voltage & current model
    let pBat = pMech >= 0 ? pMech / 0.91 : Math.max(pMech * 0.72, -60);
    pBat += 0.6 + (this.acActive ? 1.4 : 0); // 12V auxiliary + AC compressor
    this.powerKw = pBat;

    const ocv = CELL_COUNT * (3.20 + 0.15 * (this.soc / 100));
    this.current = (pBat * 1000) / ocv;
    this.voltage = ocv - this.current * 0.08;
    this.current = (pBat * 1000) / this.voltage;

    // Energy integration
    const dE = (pBat * dt) / 3600;
    this.soc = clamp(this.soc - (dE / BATTERY_NOMINAL_KWH) * 100, 5, 100);
    if (dE > 0) this.ced += dE; else this.cec -= dE;
  }

  // State helpers
  get doors() {
    if (this.driveMode === 'manual') return this.manualDoors;
    const tc = this.tc ?? 0;
    let b = 0;
    if (tc > 2 && tc < 7) b |= 0x80; // driver door (RHD = front right)
    if (tc > 4 && tc < 6) b |= 0x40;
    if (tc > 188 && tc < 196) b |= 0x08; // boot
    return b;
  }

  get locked() {
    if (this.manualLocked !== null) return this.manualLocked;
    return Math.abs(this.speed) > 15 || (this.driveMode === 'auto' && (this.tc ?? 0) > 268);
  }

  get turn() {
    const on = Math.floor(this.t * 3) % 2 === 0;
    if (this.driveMode === 'manual') {
      if (!on) return 0;
      if (this.inputTurnSignal === 'left') return 0x80;
      if (this.inputTurnSignal === 'right') return 0x08;
      if (this.inputTurnSignal === 'hazard') return 0x88;
      return 0;
    }
    const tc = this.tc ?? 0;
    if (!on) return 0;
    if (tc > 112 && tc < 122) return 0x80;
    if (tc > 135 && tc < 142) return 0x08;
    return 0;
  }

  get driverWindow() {
    if (this.driveMode === 'manual') return 0;
    const tc = this.tc ?? 0;
    return tc > 50 && tc < 80 ? 40 : tc >= 45 && tc <= 50 ? (tc - 45) * 8 : 0;
  }

  /**
   * Calculates individual wheel speeds with Ackermann differential steering geometry.
   * @param {number} wheelIdx 0: FL, 1: FR, 2: RL, 3: RR
   */
  _wheelSpeed(wheelIdx) {
    const vBase = Math.abs(this.speed);
    if (vBase < 0.2) return 0;
    const roadWheelRad = ((this.steer / 15.0) * Math.PI) / 180;
    if (Math.abs(roadWheelRad) < 0.005) {
      // Straight line
      const k = [0, 0.001, -0.001, 0.002][wheelIdx];
      return vBase * (1 + k);
    }
    const L = 2.83; // wheelbase (m)
    const W = 1.62; // track width (m)
    const absR = Math.max(W / 2 + 0.5, L / Math.tan(Math.abs(roadWheelRad)));
    const isLeft = roadWheelRad < 0;

    const rLeft = isLeft ? absR - W / 2 : absR + W / 2;
    const rRight = isLeft ? absR + W / 2 : absR - W / 2;

    let factor = 1.0;
    if (wheelIdx === 0) factor = Math.sqrt(rLeft ** 2 + L ** 2) / absR; // FL
    else if (wheelIdx === 1) factor = Math.sqrt(rRight ** 2 + L ** 2) / absR; // FR
    else if (wheelIdx === 2) factor = rLeft / absR; // RL
    else if (wheelIdx === 3) factor = rRight / absR; // RR
    return Math.abs(vBase * factor);
  }

  /** Returns the raw data bytes for one DID, or null if unsupported. */
  encode(tx, did) {
    const n = () => (this.noise() - 0.5);
    const cellAvg = (this.voltage / CELL_COUNT) * 1000;
    const cells = this.cellOffsets.map((o) => Math.round(cellAvg + o));
    const temps = this.tempOffsets.map((o) => Math.round(this.batTempBase + o));
    const bmu = Array.from({ length: 16 }, (_, i) => Math.round(this.batTempBase + 8 + (i % 4) * 0.5));
    const key = `${tx}:${did}`;

    switch (key) {
      // BMS (7E2)
      case '7E2:111A': case '7E2:141E': return be16(Math.round(this.soc));
      case '7E2:111B': return be16(Math.round(this.soc) - 1);
      case '7E2:1114': return [b8(this.soc - 1)];
      case '7E2:1002': return be16(this.soh * 100);
      case '7E2:1401': case '7E2:1105': return be16(this.voltage * 10);
      case '7E2:1106': return be16((cells.reduce((a, b) => a + b, 0) / 1000) * 10);
      case '7E2:1404': return be16(this.current * 10 + 8000);
      case '7E2:2020': return be16(Math.max(...cells) + 5000);
      case '7E2:2022': return be16(Math.min(...cells) + 5000);
      case '7E2:2023': return be16(cellAvg + 5000);
      case '7E2:1101': return [cells.indexOf(Math.max(...cells)) + 1];
      case '7E2:1103': return [cells.indexOf(Math.min(...cells)) + 1];
      case '7E2:2024': return [b8(Math.max(...temps) + 40)];
      case '7E2:2026': return [b8(Math.min(...temps) + 40)];
      case '7E2:1115': return [temps.indexOf(Math.max(...temps)) + 1];
      case '7E2:1116': return [temps.indexOf(Math.min(...temps)) + 1];
      case '7E2:1150': return [...temps.map((x) => b8(x + 40)), ...new Array(30).fill(0)];
      case '7E2:1151': return [...cells.flatMap((mv) => be16(mv + 5000)), ...new Array(300 - CELL_COUNT * 2).fill(0)];
      case '7E2:1180': return [...bmu.map((x) => b8(x + 40)), ...new Array(16).fill(0)];
      case '7E2:1181': return [b8(Math.max(...bmu) + 40)];
      case '7E2:1182': return [b8(Math.min(...bmu) + 40)];
      case '7E2:1183': return [b8(bmu.reduce((a, b) => a + b, 0) / bmu.length + 40)];
      case '7E2:114D': return be24(this.cec * 10);
      case '7E2:1189': return be24(this.ced * 10);
      case '7E2:1136': return [118];
      case '7E2:1000': return [b8(132 + n())];

      // VCU (7E3)
      case '7E3:1477': return be16(this._wheelSpeed(0) * 200); // FL
      case '7E3:1478': return be16(this._wheelSpeed(1) * 200); // FR
      case '7E3:1479': return be16(this._wheelSpeed(2) * 200); // RL
      case '7E3:147A': return be16(this._wheelSpeed(3) * 200); // RR
      case '7E3:146B': return [b8(Math.round(this.soc * 2))];
      case '7E3:2103': return [{ P: 6, D: 1, R: 5, N: 4 }[this.gear]];
      case '7E3:2104': return [this.acActive ? 6 : 2];
      case '7E3:144D': return be16(this.motorTemp + 40);
      case '7E3:144E': return be16(this.motorTemp + 41);
      case '7E3:2313': return be16(201);
      case '7E3:2314': return be16(this.soc > 95 ? 20 : 90);

      // MCU (7E4)
      case '7E4:1110': {
        let rpm = 0;
        if (this.gear === 'D') rpm = this.speed * 70.7;
        else if (this.gear === 'R') rpm = this.speed * 70.7; // negative
        else if (this.gear === 'N') rpm = this.inputThrottle * 3200;
        return be16(32767 + rpm);
      }
      case '7E4:1408': return be16(1100 + this.torqueNm * 0.5 * Math.sign(this.speed || 1));
      case '7E4:1100': return be16(this.voltage - 0.5);

      // CCU (7E6)
      case '7E6:1000': return be16((13.48 + n() * 0.04) * 100);
      case '7E6:1402': return be16(14300);
      case '7E6:110C': return [b8(29 + this.batTempBase * 0.1 + 40)];

      // IBCM (720)
      case '720:11FF': {
        const p = [35.6, 38.6, 35.4, 35.0].map((x) => b8((x + this.tireTempRise * 0.08) * 5));
        const t = [31, 27, 37, 37].map((x) => b8(x + this.tireTempRise + 50));
        return [p[0], t[0], p[1], t[1], p[2], t[2], p[3], t[3]];
      }
      case '720:1201': return [this.doors];
      case '720:1200': return be16((this.gear === 'P' ? 0x0010 : 0) | (this.brakeSwitch ? 0x0020 : 0));
      case '720:2100': return [this.turn];
      case '720:2101': return be16((this.brakeSwitch || this.brake > 50 || this.accel < -0.5 ? 0x0800 : 0) | (this.gear === 'R' ? 0x0100 : 0));

      // Door modules (719 / 718)
      case '719:1203': case '718:1203': return this.locked ? [0xa8, 0x00] : [0x94, 0x00];
      case '719:1208': return [1, b8(this.driverWindow * 2), 0, 0, 1, 0, 0, 0];
      case '718:1208': return [1, 0, 0, 0, 1, 0, 0, 0];

      // IPB (710)
      case '710:1101': return [
        ...be16(15610 - this.steer * 10),
        ...be16(792 + this.lat / 0.025),
        ...be16(796 + this.accel / 0.025),
        ...be16(981 + this.yaw / 0.1),
        ...be16(2778 + this.brake),
      ];

      default: return null;
    }
  }
}

export class SimTransport {
  constructor({ latencyMs = [10, 25], chunkSize = 20 } = {}) {
    this.name = 'Demo Simulator';
    this.profile = 'ELM327 v1.5 emulator';
    this.latencyMs = latencyMs;
    this.chunkSize = chunkSize;
    this.onData = () => {};
    this.onDisconnect = () => {};
    this.vehicle = new SimVehicle();
    this.inbuf = '';
    this.timer = null;
    this.reset();
  }

  reset() {
    this.echo = true;
    this.headers = false;
    this.spaces = true;
    this.caf = true;
    this.sh = '7DF';
    this.cra = null;
  }

  async connect() {
    let last = performance.now();
    this.timer = setInterval(() => {
      const now = performance.now();
      this.vehicle.step(Math.min(0.5, (now - last) / 1000));
      last = now;
    }, 100);
  }

  async disconnect() {
    clearInterval(this.timer);
    this.timer = null;
  }

  async write(text) {
    this.inbuf += text;
    let i;
    while ((i = this.inbuf.indexOf('\r')) !== -1) {
      const line = this.inbuf.slice(0, i).trim();
      this.inbuf = this.inbuf.slice(i + 1);
      if (line) this._respond(line);
    }
  }

  _respond(line) {
    const body = this.handleCommand(line);
    const out = (this.echo ? line + '\r' : '') + body + '\r\r>';
    const [lo, hi] = this.latencyMs;
    const delay = lo + Math.random() * (hi - lo) + Math.floor(out.length / 40) * 2;
    setTimeout(() => {
      for (let i = 0; i < out.length; i += this.chunkSize) this.onData(out.slice(i, i + this.chunkSize));
    }, delay);
  }

  /** Returns the ELM327 response body (without echo and prompt). Exposed for unit tests. */
  handleCommand(line) {
    const cmd = line.replace(/\s+/g, '').toUpperCase();
    if (cmd.startsWith('AT')) return this._at(cmd.slice(2));
    if (!/^[0-9A-F]+$/.test(cmd)) return '?';
    return this._uds(cmd);
  }

  _at(a) {
    if (a === 'Z' || a === 'WS') { this.reset(); return '\rELM327 v1.5'; }
    if (a === 'I') return 'ELM327 v1.5';
    if (a === 'RV') return `${(this.vehicle.speed !== 0 || this.vehicle.gear !== 'P' ? 13.9 : 12.6).toFixed(1)}V`;
    if (a === 'DP') return 'ISO 15765-4 (CAN 11/500)';
    if (/^E[01]$/.test(a)) { this.echo = a === 'E1'; return 'OK'; }
    if (/^H[01]$/.test(a)) { this.headers = a === 'H1'; return 'OK'; }
    if (/^S[01]$/.test(a)) { this.spaces = a === 'S1'; return 'OK'; }
    if (/^CAF[01]$/.test(a)) { this.caf = a === 'CAF1'; return 'OK'; }
    if (a.startsWith('SH')) { this.sh = a.slice(2).slice(-3); return 'OK'; }
    if (a.startsWith('CRA')) { this.cra = a.slice(3) || null; return 'OK'; }
    if (/^(L[01]|SP\w|AT[012]|ST\w+|FCSH\w+|FCSD\w+|FCSM[012]|D|AR|M[01]|CFC[01])$/.test(a)) return 'OK';
    return '?';
  }

  _uds(hex) {
    if (hex.length % 2 === 1) hex = hex.slice(0, -1); // trailing response-count digit
    let bytes = hex.match(/../g).map((x) => parseInt(x, 16));
    if (!this.caf) bytes = bytes.slice(1, 1 + bytes[0]); // manual PCI in CAF0 mode
    const ecu = ecuByTx(this.sh);
    if (!ecu || !bytes.length) return 'NO DATA';
    if (this.cra && this.cra !== ecu.rx) return 'NO DATA';

    const sid = bytes[0];
    let payload;
    if (!ALLOWED_UDS_SERVICES.includes(sid)) payload = [0x7f, sid, 0x11];
    else if (sid === 0x3e) payload = [0x7e, 0x00];
    else if (sid === 0x19) payload = [0x59, bytes[1] ?? 0x02, 0xff];
    else {
      const dids = [];
      for (let i = 1; i + 1 < bytes.length; i += 2) dids.push(hex2(bytes[i]) + hex2(bytes[i + 1]));
      if (!dids.length || dids.length > 3 || (!ecu.multiDid && dids.length > 1)) payload = [0x7f, 0x22, 0x13];
      else {
        payload = [0x62];
        for (const d of dids) {
          const data = this.vehicle.encode(ecu.tx, d);
          if (!data) { payload = [0x7f, 0x22, 0x31]; break; }
          payload.push(parseInt(d.slice(0, 2), 16), parseInt(d.slice(2), 16), ...data);
        }
      }
    }
    return this._frames(ecu.rx, payload).join('\r');
  }

  _frames(rx, payload) {
    const pad = (f) => { while (f.length < 8) f.push(0xaa); return f; };
    const frames = [];
    if (payload.length <= 7) frames.push(pad([payload.length, ...payload]));
    else {
      frames.push([0x10 | ((payload.length >> 8) & 0x0f), payload.length & 0xff, ...payload.slice(0, 6)]);
      if (this.caf) {
        let seq = 1;
        for (let i = 6; i < payload.length; i += 7) {
          frames.push(pad([0x20 | (seq & 0x0f), ...payload.slice(i, i + 7)]));
          seq++;
        }
      }
    }
    const sep = this.spaces ? ' ' : '';
    return frames.map((f) => (this.headers ? rx + sep : '') + f.map(hex2).join(sep));
  }
}
