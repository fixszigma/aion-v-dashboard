/**
 * GAC Aion V 602 — OBD2 UDS protocol & decoder (JavaScript port of aion_v_602_obd_decoder.py)
 *
 * Source references:
 * - Protocol & ELM327 setup: https://www.aionv.app/pages/OBD-HOW-TO-READ.html
 * - ECU Module Map:          https://www.aionv.app/pages/OBD-MODULES.html
 * - Decoded DIDs & Formulas: https://www.aionv.app/pages/OBD-ITEMS.html
 * - Polling schedule:        https://www.aionv.app/pages/OBD-LOGGING.html
 *
 * This module is DOM-free so it can be unit-tested with Node (node --test).
 */

export const BATTERY_NOMINAL_KWH = 75.3; // CATL LFP 75.3 kWh
export const CELL_COUNT = 112;
export const TEMP_SENSOR_COUNT = 24;
export const BMU_TEMP_COUNT = 16;

/** Read-only policy: only these UDS services may ever be transmitted. */
export const ALLOWED_UDS_SERVICES = Object.freeze([0x22, 0x19, 0x3e]);

// ---------------------------------------------------------------------------
// 1. ECU CAN ID mapping (ISO 15765-4 CAN, 11-bit, 500 kbit/s)
// ---------------------------------------------------------------------------
export const ECU_MODULES = Object.freeze({
  BMS: { key: 'BMS', name: 'Battery Management System', systemName: 'A12_UAES_BMS', tx: '7E2', rx: '7EA', partNumber: '2520105CVN1201', multiDid: true },
  VCU: { key: 'VCU', name: 'Vehicle Control Unit', systemName: 'VCU-UAES', tx: '7E3', rx: '7EB', partNumber: '1110003CVN0211', multiDid: true },
  MCU: { key: 'MCU', name: 'Motor Controller', systemName: 'MCU', tx: '7E4', rx: '7EC', partNumber: '1510046CVN4200', multiDid: true },
  CCU: { key: 'CCU', name: 'Charger & DC-DC Converter', systemName: 'EVT_6D6_CCU_B', tx: '7E6', rx: '7EE', partNumber: '2730003CVN0601', multiDid: true },
  IBCM: { key: 'IBCM', name: 'Body Control Module', systemName: 'Continental_IBCM', tx: '720', rx: '7A0', partNumber: '8045025CVN0501', multiDid: true },
  IPB: { key: 'IPB', name: 'Brakes & Stability System', systemName: 'Bosch_IPB', tx: '710', rx: '790', partNumber: '8085004ERD0002', multiDid: false },
  EPB: { key: 'EPB', name: 'Parking Brake', systemName: 'WBTLEPB-20', tx: '711', rx: '791', partNumber: '8080003CVN0100', multiDid: true },
  DOOR_R: { key: 'DOOR_R', name: 'Door Module Right (Driver RHD)', systemName: 'DOOR_R', tx: '719', rx: '799', partNumber: '8065004', multiDid: true },
  DOOR_L: { key: 'DOOR_L', name: 'Door Module Left', systemName: 'DOOR_L', tx: '718', rx: '798', partNumber: '8065005', multiDid: true },
  IC: { key: 'IC', name: 'Instrument Cluster', systemName: 'AY5G_IC2254', tx: '72B', rx: '7AB', partNumber: '8545003CVN0403', multiDid: true },
  TBOX: { key: 'TBOX', name: 'Telematics Box', systemName: 'GAEI_TBOX', tx: '72D', rx: '7AD', partNumber: '8550003CVN1903', multiDid: true },
  GWM: { key: 'GWM', name: 'Gateway Module', systemName: '+GWM30', tx: '74F', rx: '7CF', partNumber: '8045196ERD0303', multiDid: true },
});

const ECU_BY_TX = Object.fromEntries(Object.values(ECU_MODULES).map((e) => [e.tx, e]));
export const ecuByTx = (tx) => ECU_BY_TX[String(tx).toUpperCase()];

// ---------------------------------------------------------------------------
// 2. Decoding helpers (big-endian)
// ---------------------------------------------------------------------------
export const u8 = (b) => b[0];
export const u16 = (b) => ((b[0] << 8) | b[1]) >>> 0;
export const u24 = (b) => ((b[0] << 16) | (b[1] << 8) | b[2]) >>> 0;
export const round = (v, digits = 0) => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

export function decodeCellVoltages(b) {
  const out = [];
  const n = Math.min(b.length, CELL_COUNT * 2);
  for (let i = 0; i + 1 < n; i += 2) out.push(u16(b.subarray(i, i + 2)) - 5000);
  return out;
}

export const decodeBatteryTemps = (b) => Array.from(b.subarray(0, TEMP_SENSOR_COUNT), (x) => x - 40);
export const decodeBmuTemps = (b) => Array.from(b.subarray(0, BMU_TEMP_COUNT), (x) => x - 40);

export function decodeTpms(b) {
  const r = {};
  for (let i = 0; i < 4; i++) {
    r[`tire_${i + 1}_psi`] = round(b[i * 2] / 5.0, 1);
    r[`tire_${i + 1}_c`] = b[i * 2 + 1] - 50;
  }
  return r;
}

export function decodeDoors(b) {
  const x = b[0];
  return {
    front_right_open: !!(x & 0x80),
    front_left_open: !!(x & 0x40),
    rear_left_open: !!(x & 0x20),
    rear_right_open: !!(x & 0x10),
    boot_open: !!(x & 0x08),
  };
}

const GEAR_MAP = { 6: 'P', 1: 'D', 5: 'R', 4: 'N' };
export const decodeGear = (b) => GEAR_MAP[b[0]] ?? `?${b[0]}`;

export function decodeIpbDynamics(b) {
  const v = (i) => u16(b.subarray(i, i + 2));
  const steer = v(0);
  return {
    steering_angle_deg: steer === 0xffff ? null : round((15610 - steer) * 0.1, 1),
    lateral_accel_ms2: round((v(2) - 792) * 0.025, 3),
    longitudinal_accel_ms2: round((v(4) - 796) * 0.025, 3),
    yaw_rate_degs: round((v(6) - 981) * 0.1, 1),
    brake_pressure_raw: Math.max(0, v(8) - 2778),
  };
}

export function decodeLockState(b) {
  const v = u16(b);
  if (v === 0xa800) return 'LOCKED';
  if (v === 0x9400) return 'UNLOCKED';
  return `0x${v.toString(16).toUpperCase().padStart(4, '0')}`;
}

const MOTION = { 0: 'stop', 1: 'up', 2: 'down' };
export const decodeWindows = (b) => ({
  front_pct: round(b[1] / 2.0, 1),
  front_motion: MOTION[b[2]] ?? 'stop',
  rear_pct: round(b[5] / 2.0, 1),
  rear_motion: MOTION[b[6]] ?? 'stop',
});

/** 2313 / 2314: spec says "value or value / 100" → scale down when obviously in 0.01 kW units. */
export const decodePowerLimit = (b) => {
  const v = u16(b);
  return v > 1000 ? round(v / 100.0, 2) : v;
};

// ---------------------------------------------------------------------------
// 3. DID registry
// ---------------------------------------------------------------------------
/** @type {Map<string, object>} key = `${tx}:${did}` */
export const DID_REGISTRY = new Map();

function def(ecuKey, did, name, label, unit, byteLength, decode, minLength = byteLength) {
  const ecu = ECU_MODULES[ecuKey];
  const entry = Object.freeze({ ecu: ecuKey, tx: ecu.tx, rx: ecu.rx, did, name, label, unit, byteLength, minLength, decode });
  DID_REGISTRY.set(`${ecu.tx}:${did}`, entry);
  return entry;
}

// BMS (7E2 -> 7EA)
def('BMS', '111A', 'soc_display', 'SoC (หน้าจอ)', '%', 2, (b) => u16(b));
def('BMS', '141E', 'soc_display_alt', 'SoC (หน้าจอ, สำรอง)', '%', 2, (b) => u16(b));
def('BMS', '111B', 'soc_bms', 'SoC ภายใน BMS', '%', 2, (b) => u16(b));
def('BMS', '1114', 'soc_cell_avg', 'SoC เฉลี่ยของเซลล์', '%', 1, (b) => u8(b));
def('BMS', '1002', 'soh', 'SoH สุขภาพแบตเตอรี่', '%', 2, (b) => round(u16(b) / 100.0, 2));
def('BMS', '1401', 'pack_voltage', 'แรงดันแพ็ก', 'V', 2, (b) => round(u16(b) / 10.0, 1));
def('BMS', '1105', 'pack_voltage_alt', 'แรงดันแพ็ก (สำรอง)', 'V', 2, (b) => round(u16(b) / 10.0, 1));
def('BMS', '1106', 'cell_sum_voltage', 'ผลรวมแรงดันเซลล์', 'V', 2, (b) => round(u16(b) / 10.0, 1));
def('BMS', '1404', 'pack_current', 'กระแสแพ็ก (+ = ใช้ไฟ)', 'A', 2, (b) => round((u16(b) - 8000) / 10.0, 1));
def('BMS', '2020', 'cell_max_mv', 'แรงดันเซลล์สูงสุด', 'mV', 2, (b) => u16(b) - 5000);
def('BMS', '2022', 'cell_min_mv', 'แรงดันเซลล์ต่ำสุด', 'mV', 2, (b) => u16(b) - 5000);
def('BMS', '2023', 'cell_avg_mv', 'แรงดันเซลล์เฉลี่ย', 'mV', 2, (b) => u16(b) - 5000);
def('BMS', '1101', 'cell_max_index', 'เซลล์แรงดันสูงสุด #', '#', 1, (b) => u8(b));
def('BMS', '1103', 'cell_min_index', 'เซลล์แรงดันต่ำสุด #', '#', 1, (b) => u8(b));
def('BMS', '2024', 'bat_temp_max', 'อุณหภูมิแบตสูงสุด', '°C', 1, (b) => u8(b) - 40);
def('BMS', '2026', 'bat_temp_min', 'อุณหภูมิแบตต่ำสุด', '°C', 1, (b) => u8(b) - 40);
def('BMS', '1115', 'bat_temp_max_index', 'เซนเซอร์อุณหภูมิสูงสุด #', '#', 1, (b) => u8(b));
def('BMS', '1116', 'bat_temp_min_index', 'เซนเซอร์อุณหภูมิต่ำสุด #', '#', 1, (b) => u8(b));
def('BMS', '1150', 'battery_temps', 'อุณหภูมิแบต 24 จุด', '°C', 54, decodeBatteryTemps, TEMP_SENSOR_COUNT);
def('BMS', '1151', 'cell_voltages', 'แรงดันรายเซลล์ 112 เซลล์', 'mV', 300, decodeCellVoltages, CELL_COUNT * 2);
def('BMS', '1180', 'bmu_temps', 'อุณหภูมิแผงวงจร BMU 16 จุด', '°C', 32, decodeBmuTemps, BMU_TEMP_COUNT);
def('BMS', '1181', 'bmu_temp_max', 'อุณหภูมิ BMU สูงสุด', '°C', 1, (b) => u8(b) - 40);
def('BMS', '1182', 'bmu_temp_min', 'อุณหภูมิ BMU ต่ำสุด', '°C', 1, (b) => u8(b) - 40);
def('BMS', '1183', 'bmu_temp_avg', 'อุณหภูมิ BMU เฉลี่ย', '°C', 1, (b) => u8(b) - 40);
def('BMS', '114D', 'energy_charged_total', 'พลังงานชาร์จเข้าสะสม (CEC)', 'kWh', 3, (b) => round(u24(b) / 10.0, 1));
def('BMS', '1189', 'energy_discharged_total', 'พลังงานจ่ายออกสะสม (CED)', 'kWh', 3, (b) => round(u24(b) / 10.0, 1));
def('BMS', '1136', 'cc2_voltage', 'แรงดัน CC2 (สายชาร์จ)', 'V', 1, (b) => round(u8(b) / 10.0, 1));
def('BMS', '1000', 'aux_12v_bms', 'ไฟ 12V ที่ BMS', 'V', 1, (b) => round(u8(b) / 10.0, 1));

// VCU (7E3 -> 7EB)
def('VCU', '1477', 'wheel_speed_fl', 'ความเร็วล้อหน้าซ้าย', 'km/h', 2, (b) => round(u16(b) / 200.0, 2));
def('VCU', '1478', 'wheel_speed_fr', 'ความเร็วล้อหน้าขวา', 'km/h', 2, (b) => round(u16(b) / 200.0, 2));
def('VCU', '1479', 'wheel_speed_rl', 'ความเร็วล้อหลังซ้าย', 'km/h', 2, (b) => round(u16(b) / 200.0, 2));
def('VCU', '147A', 'wheel_speed_rr', 'ความเร็วล้อหลังขวา', 'km/h', 2, (b) => round(u16(b) / 200.0, 2));
def('VCU', '146B', 'soc_precise', 'SoC ละเอียด 0.5%', '%', 1, (b) => round(u8(b) / 2.0, 1));
def('VCU', '2103', 'gear', 'ตำแหน่งเกียร์', '', 1, decodeGear);
def('VCU', '2104', 'ac_active', 'ระบบปรับอากาศ', '', 1, (b) => b[0] === 5 || b[0] === 6);
def('VCU', '144D', 'motor_temp_1', 'อุณหภูมิมอเตอร์ 1', '°C', 2, (b) => u16(b) - 40);
def('VCU', '144E', 'motor_temp_2', 'อุณหภูมิมอเตอร์ 2', '°C', 2, (b) => u16(b) - 40);
def('VCU', '2313', 'discharge_power_limit', 'ลิมิตกำลังจ่ายไฟ', 'kW', 2, decodePowerLimit);
def('VCU', '2314', 'charge_power_limit', 'ลิมิตกำลังชาร์จ/Regen', 'kW', 2, decodePowerLimit);

// MCU (7E4 -> 7EC)
def('MCU', '1110', 'motor_rpm', 'รอบมอเตอร์', 'rpm', 2, (b) => u16(b) - 32767);
def('MCU', '1408', 'motor_torque', 'แรงบิดมอเตอร์ (ประมาณ)', 'raw', 2, (b) => u16(b) - 1100);
def('MCU', '1100', 'inverter_dc_bus_v', 'แรงดัน DC-Bus อินเวอร์เตอร์', 'V', 2, (b) => u16(b));

// CCU (7E6 -> 7EE)
def('CCU', '1000', 'dcdc_output_v', 'แรงดันขาออก DC-DC', 'V', 2, (b) => round(u16(b) / 100.0, 2));
def('CCU', '1402', 'dcdc_target_v', 'แรงดันเป้าหมาย DC-DC', 'V', 2, (b) => round(u16(b) / 1000.0, 2));
def('CCU', '110C', 'charger_temp', 'อุณหภูมิชุดชาร์จ/DC-DC', '°C', 1, (b) => u8(b) - 40);

// IBCM (720 -> 7A0)
def('IBCM', '11FF', 'tpms', 'ลมยาง TPMS', 'psi/°C', 8, decodeTpms);
def('IBCM', '1201', 'doors', 'สถานะประตู/ฝาท้าย', 'flags', 1, decodeDoors);
def('IBCM', '1200', 'pedal_park', 'แป้นเบรก / เกียร์ P', 'flags', 2, (b) => ({ park: !!(u16(b) & 0x0010), brake_pedal: !!(u16(b) & 0x0020) }));
def('IBCM', '2100', 'turn_signals', 'ไฟเลี้ยว', 'flags', 1, (b) => ({ left: !!(b[0] & 0x80), right: !!(b[0] & 0x08) }));
def('IBCM', '2101', 'lights', 'ไฟเบรก / ไฟถอย', 'flags', 2, (b) => ({ brake_light: !!(u16(b) & 0x0800), reverse_light: !!(u16(b) & 0x0100) }));

// Door modules
def('DOOR_R', '1203', 'lock_state', 'สถานะล็อกรถ', '', 2, decodeLockState);
def('DOOR_R', '1208', 'windows_right', 'กระจกฝั่งขวา (คนขับ)', '%', 8, decodeWindows);
def('DOOR_L', '1203', 'lock_state_l', 'สถานะล็อกรถ (ซ้าย)', '', 2, decodeLockState);
def('DOOR_L', '1208', 'windows_left', 'กระจกฝั่งซ้าย', '%', 8, decodeWindows);

// IPB (710 -> 790) — single DID per request only
def('IPB', '1101', 'dynamics', 'เซนเซอร์ทรงตัว (พวงมาลัย/G/Yaw/เบรก)', 'mixed', 10, decodeIpbDynamics);

export const getDid = (tx, did) => DID_REGISTRY.get(`${String(tx).toUpperCase()}:${String(did).toUpperCase()}`);
export const DID_BY_NAME = new Map([...DID_REGISTRY.values()].map((d) => [d.name, d]));

// ---------------------------------------------------------------------------
// 4. Polling plan (AGENTS.md §5.3)
// ---------------------------------------------------------------------------
/** category is used to let the user disable whole sections to speed up polling. */
export const POLL_GROUPS = Object.freeze([
  // Fast tier (~0.5–0.6 s)
  { tier: 'fast', category: 'drive', tx: '7E3', dids: ['1477', '1478', '1479'] },
  { tier: 'fast', category: 'drive', tx: '7E3', dids: ['147A', '2103', '146B'] },
  { tier: 'fast', category: 'drive', tx: '7E4', dids: ['1110', '1408', '1100'] },
  { tier: 'fast', category: 'battery', tx: '7E2', dids: ['1401', '1404'] },
  { tier: 'fast', category: 'body', tx: '720', dids: ['1200', '1201', '2101'] },
  { tier: 'fast', category: 'body', tx: '720', dids: ['2100'] },
  { tier: 'fast', category: 'dynamics', tx: '710', dids: ['1101'] },
  // Slow tier (~15–30 s)
  { tier: 'slow', category: 'battery', tx: '7E2', dids: ['111A', '1002', '111B'] },
  { tier: 'slow', category: 'battery', tx: '7E2', dids: ['1114', '1106', '1000'] },
  { tier: 'slow', category: 'battery', tx: '7E2', dids: ['2020', '2022', '2023'] },
  { tier: 'slow', category: 'battery', tx: '7E2', dids: ['1101', '1103', '2024'] },
  { tier: 'slow', category: 'battery', tx: '7E2', dids: ['2026', '1115', '1116'] },
  { tier: 'slow', category: 'battery', tx: '7E2', dids: ['1181', '1182', '1183'] },
  { tier: 'slow', category: 'battery', tx: '7E2', dids: ['114D', '1189', '1136'] },
  { tier: 'slow', category: 'cells', tx: '7E2', dids: ['1151'] },
  { tier: 'slow', category: 'cells', tx: '7E2', dids: ['1150'] },
  { tier: 'slow', category: 'cells', tx: '7E2', dids: ['1180'] },
  { tier: 'slow', category: 'drive', tx: '7E3', dids: ['2104', '144D', '144E'] },
  { tier: 'slow', category: 'drive', tx: '7E3', dids: ['2313', '2314'] },
  { tier: 'slow', category: 'drive', tx: '7E6', dids: ['1000', '1402', '110C'] },
  { tier: 'slow', category: 'body', tx: '720', dids: ['11FF'] },
  { tier: 'slow', category: 'body', tx: '719', dids: ['1203', '1208'] },
  { tier: 'slow', category: 'body', tx: '718', dids: ['1208'] },
]);

export const POLL_CATEGORIES = Object.freeze({
  drive: 'ขับขี่ / มอเตอร์ / DC-DC',
  battery: 'แบตเตอรี่ (ค่าสรุป)',
  cells: 'แรงดันรายเซลล์ & อุณหภูมิรายจุด',
  body: 'ตัวถัง / ประตู / TPMS',
  dynamics: 'IPB (พวงมาลัย / G-force)',
});

// ---------------------------------------------------------------------------
// 5. Command building
// ---------------------------------------------------------------------------
/** Total length of a positive 0x62 response for the given DIDs. */
export function expectedResponseLength(tx, dids) {
  return 1 + dids.reduce((sum, d) => sum + 2 + (getDid(tx, d)?.byteLength ?? 0), 0);
}

/** Number of CAN frames an ISO-TP message of `len` bytes occupies. */
export const isoTpFrameCount = (len) => (len <= 7 ? 1 : 1 + Math.ceil((len - 6) / 7));

/** Throws if the hex payload is not an allowed read-only UDS service. */
export function assertReadOnly(udsHex) {
  const clean = udsHex.replace(/\s+/g, '');
  const sid = parseInt(clean.slice(0, 2), 16);
  if (!ALLOWED_UDS_SERVICES.includes(sid)) {
    throw new Error(`Blocked by read-only policy: service 0x${clean.slice(0, 2)} is not allowed`);
  }
}

/**
 * Builds a UDS 0x22 read command for 1–3 DIDs on the same ECU.
 * Example: buildUdsReadCommand('7E2', ['111A']) -> "22111A 1"
 */
export function buildUdsReadCommand(tx, dids, { caf0 = false, frameHint = true } = {}) {
  const ecu = ecuByTx(tx);
  if (dids.length < 1 || dids.length > 3) throw new Error('GAC Aion V modules support 1 to 3 DIDs per request.');
  if (ecu && !ecu.multiDid && dids.length > 1) throw new Error(`${ecu.key} (${tx}) only supports one DID per request.`);
  let payload = '22' + dids.map((d) => d.toUpperCase()).join('');
  assertReadOnly(payload);
  if (caf0) payload = (payload.length / 2).toString(16).toUpperCase().padStart(2, '0') + payload;
  const frames = isoTpFrameCount(expectedResponseLength(tx, dids));
  if (frameHint && frames <= 9) payload += ` ${frames}`;
  return payload;
}

// ---------------------------------------------------------------------------
// 6. ELM327 response parsing & ISO-TP reassembly (ATH1, headers on)
// ---------------------------------------------------------------------------
const ELM_ERRORS = ['NO DATA', 'CAN ERROR', 'BUS INIT', 'BUS ERROR', 'STOPPED', 'UNABLE TO CONNECT', 'BUFFER FULL', 'DATA ERROR', 'RX ERROR', 'FB ERROR', 'LV RESET', 'ACT ALERT', 'ERR'];

export const NRC_NAMES = {
  0x10: 'generalReject', 0x11: 'serviceNotSupported', 0x12: 'subFunctionNotSupported', 0x13: 'incorrectMessageLength',
  0x14: 'responseTooLong', 0x22: 'conditionsNotCorrect', 0x31: 'requestOutOfRange', 0x33: 'securityAccessDenied', 0x78: 'responsePending',
  0x7f: 'serviceNotSupportedInActiveSession',
};

export const hexToBytes = (hex) => {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  const out = new Uint8Array(clean.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
};
export const bytesToHex = (b, sep = ' ') => Array.from(b, (x) => x.toString(16).toUpperCase().padStart(2, '0')).join(sep);

/**
 * Parses raw ELM327 text output (headers on, spaces on or off) and reassembles ISO-TP.
 * @returns {{ ok: boolean, payload?: Uint8Array, error?: string, nrc?: number, incomplete?: boolean, frames: number }}
 */
export function parseElmResponse(text, rxId = null) {
  const lines = text.split(/[\r\n]+/).map((l) => l.trim().replace(/^>/, '').trim()).filter(Boolean);
  let buf = null;
  let total = 0;
  let nextSeq = 1;
  let frames = 0;
  let error = null;

  for (const line of lines) {
    const upper = line.toUpperCase();
    if (upper === '?') { error = '?'; continue; }
    const elmErr = ELM_ERRORS.find((e) => upper.includes(e));
    if (elmErr) { error = elmErr; continue; }
    if (upper.startsWith('SEARCHING') || upper === 'OK') continue;

    const compact = upper.replace(/\s+/g, '');
    if (!/^[0-9A-F]+$/.test(compact) || compact.length < 5) continue;

    const header = compact.slice(0, 3);
    if (rxId && header !== rxId.toUpperCase()) continue;
    const bytes = hexToBytes(compact.slice(3));
    if (!bytes.length) continue;
    frames++;

    const type = bytes[0] >> 4;
    if (type === 0) {
      const len = bytes[0] & 0x0f;
      const data = bytes.slice(1, 1 + len);
      if (data[0] === 0x7f && data[2] === 0x78) continue; // response pending — keep waiting
      return finish(data, frames);
    } else if (type === 1) {
      total = ((bytes[0] & 0x0f) << 8) | bytes[1];
      buf = Array.from(bytes.slice(2));
      nextSeq = 1;
    } else if (type === 2 && buf) {
      const seq = bytes[0] & 0x0f;
      if (seq !== nextSeq) error = `ISO-TP sequence error (got ${seq}, expected ${nextSeq})`;
      nextSeq = (seq + 1) & 0x0f;
      buf.push(...bytes.slice(1));
      if (buf.length >= total) return finish(Uint8Array.from(buf.slice(0, total)), frames);
    }
    // type 3 = flow control → ignore
  }

  if (buf && buf.length) {
    return { ok: true, payload: Uint8Array.from(buf.slice(0, total)), incomplete: true, frames, error: error ?? 'incomplete multi-frame response' };
  }
  return { ok: false, error: error ?? 'no response', frames };

  function finish(data, n) {
    if (data[0] === 0x7f) return { ok: false, nrc: data[2], error: `NRC 0x${(data[2] ?? 0).toString(16).toUpperCase()} ${NRC_NAMES[data[2]] ?? ''}`.trim(), payload: data, frames: n };
    return { ok: true, payload: data, frames: n };
  }
}

/**
 * Parses a reassembled UDS 0x62 positive response (single or multi-DID).
 * e.g. '62111A0057' or '621477000014780000'.
 * @returns {Record<string, any>} name -> decoded value
 */
export function parseUds62Payload(tx, payload) {
  const raw = typeof payload === 'string' ? hexToBytes(payload) : payload;
  if (!raw.length || raw[0] !== 0x62) throw new Error(`Not a positive UDS 0x62 response: ${bytesToHex(raw)}`);
  const results = {};
  let idx = 1;
  while (idx + 2 <= raw.length) {
    const did = bytesToHex(raw.subarray(idx, idx + 2), '');
    idx += 2;
    const d = getDid(tx, did);
    if (!d) break;
    const available = Math.min(d.byteLength, raw.length - idx);
    if (available < d.minLength) break;
    const val = raw.subarray(idx, idx + available);
    idx += available;
    results[d.name] = d.decode(val);
  }
  return results;
}
