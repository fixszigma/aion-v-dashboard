// Run: node --test dashboard/tests
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseUds62Payload, parseElmResponse, buildUdsReadCommand, assertReadOnly, POLL_GROUPS, getDid,
  expectedResponseLength, isoTpFrameCount, ecuByTx,
} from '../js/decoder.js';
import { SimTransport } from '../js/simulator.js';
import { Elm327 } from '../js/elm327.js';
import { Telemetry } from '../js/telemetry.js';

test('vectors from aion_v_602_obd_decoder.py self-test', () => {
  assert.deepEqual(parseUds62Payload('7E2', '62 11 1A 00 57'), { soc_display: 87 });
  assert.deepEqual(parseUds62Payload('7E2', '62 10 02 27 10'), { soh: 100 });
  assert.deepEqual(parseUds62Payload('7E2', '62 14 01 0E 8D'), { pack_voltage: 372.5 });
  assert.deepEqual(parseUds62Payload('7E3', '62 14 77 00 00 14 78 00 00 14 79 00 00'), { wheel_speed_fl: 0, wheel_speed_fr: 0, wheel_speed_rl: 0 });
  assert.deepEqual(parseUds62Payload('720', '62 11 FF B2 51 C1 4D B1 57 AF 57'), {
    tpms: { tire_1_psi: 35.6, tire_1_c: 31, tire_2_psi: 38.6, tire_2_c: 27, tire_3_psi: 35.4, tire_3_c: 37, tire_4_psi: 35, tire_4_c: 37 },
  });
});

test('vectors from AGENTS.md tables', () => {
  assert.equal(parseUds62Payload('7E2', '62 14 04 1F 4E').pack_current, 1.4);
  assert.equal(parseUds62Payload('7E2', '62 20 20 20 89').cell_max_mv, 3329);
  assert.equal(parseUds62Payload('7E2', '62 20 24 46').bat_temp_max, 30);
  assert.equal(parseUds62Payload('7E2', '62 11 4D 00 05 0E').energy_charged_total, 129.4);
  assert.equal(parseUds62Payload('7E2', '62 11 89 00 02 91').energy_discharged_total, 65.7);
  assert.equal(parseUds62Payload('7E2', '62 10 00 84').aux_12v_bms, 13.2);
  assert.equal(parseUds62Payload('7E3', '62 14 6B AE').soc_precise, 87);
  assert.equal(parseUds62Payload('7E3', '62 21 03 06').gear, 'P');
  assert.equal(parseUds62Payload('7E3', '62 14 4D 00 48').motor_temp_1, 32);
  assert.equal(parseUds62Payload('7E3', '62 23 13 00 C9').discharge_power_limit, 201);
  assert.equal(parseUds62Payload('7E4', '62 11 10 7F FF').motor_rpm, 0);
  assert.equal(parseUds62Payload('7E4', '62 14 08 04 65').motor_torque, 25);
  assert.equal(parseUds62Payload('7E4', '62 11 00 01 74').inverter_dc_bus_v, 372);
  assert.equal(parseUds62Payload('7E6', '62 10 00 05 44').dcdc_output_v, 13.48);
  assert.equal(parseUds62Payload('7E6', '62 14 02 37 DC').dcdc_target_v, 14.3);
  assert.equal(parseUds62Payload('719', '62 12 03 94 00').lock_state, 'UNLOCKED');
  assert.equal(parseUds62Payload('720', '62 12 01 80').doors.front_right_open, true);
  const dyn = parseUds62Payload('710', '62 11 01 FF FF 03 1C 03 1E 03 D6 0A DA').dynamics;
  assert.deepEqual(dyn, { steering_angle_deg: null, lateral_accel_ms2: 0.1, longitudinal_accel_ms2: 0.05, yaw_rate_degs: 0.1, brake_pressure_raw: 0 });
  // Same DID on different ECUs must not collide
  assert.equal(parseUds62Payload('7E2', '62 11 01 6C').cell_max_index, 108);
});

test('command building & read-only policy', () => {
  assert.equal(buildUdsReadCommand('7E2', ['111A']), '22111A 1');
  assert.equal(buildUdsReadCommand('7E3', ['1477', '1478', '1479']), '22147714781479 2');
  assert.equal(buildUdsReadCommand('7E2', ['111A'], { caf0: true }), '0322111A 1');
  assert.equal(buildUdsReadCommand('7E2', ['1151']), '221151'); // 44 frames → no hint
  assert.throws(() => buildUdsReadCommand('710', ['1101', '1102']));
  assert.throws(() => buildUdsReadCommand('7E2', ['1', '2', '3', '4']));
  for (const sid of ['2E', '31', '2F', '10', '11', '27']) assert.throws(() => assertReadOnly(`${sid}0102`));
  for (const sid of ['22', '19', '3E']) assert.doesNotThrow(() => assertReadOnly(`${sid}00`));
});

test('poll plan is valid', () => {
  for (const g of POLL_GROUPS) {
    assert.ok(g.dids.length >= 1 && g.dids.length <= 3, `group size ${g.tx} ${g.dids}`);
    if (!ecuByTx(g.tx).multiDid) assert.equal(g.dids.length, 1);
    for (const d of g.dids) assert.ok(getDid(g.tx, d), `missing DID ${g.tx}:${d}`);
  }
  assert.equal(isoTpFrameCount(expectedResponseLength('7E2', ['1150'])), 9);
  assert.equal(isoTpFrameCount(expectedResponseLength('7E2', ['1151'])), 44);
  assert.equal(isoTpFrameCount(expectedResponseLength('720', ['11FF'])), 2);
});

test('ELM response parsing: single, multi-frame, NRC, errors', () => {
  assert.deepEqual(Array.from(parseElmResponse('7EA0562111A0057AAAA', '7EA').payload), [0x62, 0x11, 0x1a, 0x00, 0x57]);
  const mf = parseElmResponse('7A0 10 0B 62 11 FF B2 51 C1\r7A0 21 4D B1 57 AF 57 AA AA\r', '7A0');
  assert.equal(mf.ok, true);
  assert.equal(mf.payload.length, 11);
  assert.equal(parseUds62Payload('720', mf.payload).tpms.tire_4_psi, 35);
  const nrc = parseElmResponse('7EA037F2231AAAAAAAA', '7EA');
  assert.equal(nrc.ok, false);
  assert.equal(nrc.nrc, 0x31);
  assert.equal(parseElmResponse('NO DATA', '7EA').error, 'NO DATA');
  // Response pending (0x78) followed by real answer
  assert.equal(parseElmResponse('7EA037F2278\r7EA0562111A0057', '7EA').ok, true);
  // Frames from other ECUs are filtered
  assert.equal(parseElmResponse('7EB0562111A0057', '7EA').ok, false);
});

test('simulator CAF0 mode returns only the first frame of multi-frame responses', () => {
  const sim = new SimTransport();
  sim.handleCommand('ATH1'); sim.handleCommand('ATS0'); sim.handleCommand('ATCAF0'); sim.handleCommand('ATSH7E2');
  const lines = sim.handleCommand('0322111A 1');
  assert.match(lines, /^7EA0562111A/);
  const mf = sim.handleCommand('03221151');
  assert.equal(mf.split('\r').length, 1);
});

test('end-to-end: Elm327 driver + simulator reads every poll group', async () => {
  const sim = new SimTransport({ latencyMs: [1, 3] });
  const elm = new Elm327(sim);
  await sim.connect();
  for (let i = 0; i < 400; i++) sim.vehicle.step(0.1); // drive 40 s into the cycle
  const version = await elm.init();
  assert.match(version, /ELM327/);
  const tel = new Telemetry(null);
  for (const g of POLL_GROUPS) {
    const res = await elm.readDids(g.tx, g.dids);
    assert.equal(res.error, undefined, `${g.tx} ${g.dids}: ${res.error}`);
    assert.equal(Object.keys(res.values).length, g.dids.length, `${g.tx} ${g.dids}`);
    tel.update(res.values);
  }
  await sim.disconnect();
  assert.equal(tel.get('cell_voltages').length, 112);
  assert.equal(tel.get('battery_temps').length, 24);
  assert.equal(tel.get('bmu_temps').length, 16);
  assert.equal(tel.get('cell_min_index'), 41);
  assert.equal(tel.get('gear'), 'D');
  assert.ok(tel.speedKmh > 50, `speed ${tel.speedKmh}`);
  assert.ok(Math.abs(tel.get('pack_voltage') - tel.get('inverter_dc_bus_v')) < 2);
  assert.ok(tel.powerKw > 0);
  assert.ok(tel.rangeKm > 100);
});

test('telemetry trip integration', () => {
  const tel = new Telemetry(null);
  const t0 = 1_000_000;
  for (let i = 0; i <= 3600; i++) {
    tel.update({ wheel_speed_fl: 60, wheel_speed_fr: 60, wheel_speed_rl: 60, wheel_speed_rr: 60, pack_voltage: 360, pack_current: 25 }, t0 + i * 1000);
  }
  assert.ok(Math.abs(tel.trip.km - 60) < 0.01);
  assert.ok(Math.abs(tel.trip.kwh - 9) < 0.01);
  assert.ok(Math.abs(tel.efficiencyKwh100 - 15) < 0.01);
  const csv = Telemetry.toCsv([tel.snapshot()]);
  assert.match(csv.split('\n')[0], /speed_kmh/);
});
