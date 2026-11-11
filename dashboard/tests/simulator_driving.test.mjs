import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SimVehicle } from '../js/simulator.js';
import { parseUds62Payload } from '../js/decoder.js';

test('SimVehicle: manual mode gear shifting, throttle acceleration and braking', () => {
  const v = new SimVehicle();
  v.driveMode = 'manual';

  // 1. Initial Park
  v.inputGear = 'P';
  v.step(0.1);
  assert.equal(v.speed, 0);
  assert.equal(v.gear, 'P');
  // Check IBCM 1200 (Pedal & Park switch: bit 0x0010 = Park)
  const parkBytes = v.encode('720', '1200');
  const parkVal = (parkBytes[0] << 8) | parkBytes[1];
  assert.ok(parkVal & 0x0010, 'Park switch bit 0x0010 must be set in P');

  // Check VCU 2103 (Gear: P = 6)
  assert.equal(v.encode('7E3', '2103')[0], 6);

  // 2. Shift to D and Accelerate
  v.inputGear = 'D';
  v.inputThrottle = 0.8;
  v.inputBrake = 0.0;

  // Step 2 seconds of acceleration
  for (let i = 0; i < 20; i++) v.step(0.1);

  assert.ok(v.speed > 10, `Speed should increase, got ${v.speed} km/h`);
  assert.equal(v.gear, 'D');
  assert.equal(v.encode('7E3', '2103')[0], 1, 'Gear D code in VCU is 1');

  // Check MCU: Motor Torque > 1100, Motor RPM > 32767
  const torqueRaw = (v.encode('7E4', '1408')[0] << 8) | v.encode('7E4', '1408')[1];
  const rpmRaw = (v.encode('7E4', '1110')[0] << 8) | v.encode('7E4', '1110')[1];
  assert.ok(torqueRaw > 1100, `Torque raw should be > 1100 under acceleration, got ${torqueRaw}`);
  assert.ok(rpmRaw > 32767, `RPM raw should be > 32767 in D, got ${rpmRaw}`);

  // Check BMS: Pack current > 8000 (discharging under load)
  const currentRaw = (v.encode('7E2', '1404')[0] << 8) | v.encode('7E2', '1404')[1];
  assert.ok(currentRaw > 8000, `Current raw should be > 8000 under acceleration, got ${currentRaw}`);

  // 3. Apply Brake
  v.inputThrottle = 0.0;
  v.inputBrake = 0.7;
  v.step(0.1);

  // Check IBCM 1200: Brake switch bit 0x0020 active
  const brakePedalBytes = v.encode('720', '1200');
  const brakePedalVal = (brakePedalBytes[0] << 8) | brakePedalBytes[1];
  assert.ok(brakePedalVal & 0x0020, 'Brake pedal switch bit 0x0020 must be set when braking');

  // Check IBCM 2101: Brake lights bit 0x0800 active
  const lightsBytes = v.encode('720', '2101');
  const lightsVal = (lightsBytes[0] << 8) | lightsBytes[1];
  assert.ok(lightsVal & 0x0800, 'Brake lights bit 0x0800 must be set when braking');

  // Check IPB 1101: Brake pressure > 0 and decel
  const ipbBytes = v.encode('710', '1101');
  const dyn = parseUds62Payload('710', new Uint8Array([0x62, 0x11, 0x01, ...ipbBytes])).dynamics;
  assert.ok(dyn.brake_pressure_raw > 500, `Brake pressure raw should be > 500, got ${dyn.brake_pressure_raw}`);

  // Step braking until stopped
  for (let i = 0; i < 40; i++) v.step(0.1);
  assert.equal(Math.round(v.speed), 0, 'Car should stop under braking');

  // 4. Shift to R (Reverse)
  v.inputBrake = 0.0;
  v.inputGear = 'R';
  v.inputThrottle = 0.5;
  for (let i = 0; i < 15; i++) v.step(0.1);

  assert.ok(v.speed < 0, `Speed should be negative in Reverse, got ${v.speed} km/h`);
  assert.equal(v.encode('7E3', '2103')[0], 5, 'Gear R code in VCU is 5');

  // Check Reverse light bit 0x0100 in IBCM 2101
  const rLightsBytes = v.encode('720', '2101');
  const rLightsVal = (rLightsBytes[0] << 8) | rLightsBytes[1];
  assert.ok(rLightsVal & 0x0100, 'Reverse light bit 0x0100 must be set in Reverse');

  // Motor RPM in Reverse < 32767
  const rRpmRaw = (v.encode('7E4', '1110')[0] << 8) | v.encode('7E4', '1110')[1];
  assert.ok(rRpmRaw < 32767, `RPM raw in Reverse should be < 32767, got ${rRpmRaw}`);
});

test('SimVehicle: turn signals, steering differential and doors', () => {
  const v = new SimVehicle();
  v.driveMode = 'manual';
  v.t = 0.1; // Math.floor(0.1 * 3) = 0 -> on phase (true)

  // Turn signal Left
  v.inputTurnSignal = 'left';
  assert.equal(v.encode('720', '2100')[0], 0x80, 'Left turn signal bit 0x80');

  // Turn signal Right
  v.inputTurnSignal = 'right';
  assert.equal(v.encode('720', '2100')[0], 0x08, 'Right turn signal bit 0x08');

  // Hazard
  v.inputTurnSignal = 'hazard';
  assert.equal(v.encode('720', '2100')[0], 0x88, 'Hazard turn signal bits 0x88');

  // Off
  v.inputTurnSignal = 'off';
  assert.equal(v.encode('720', '2100')[0], 0x00, 'Turn signal off is 0x00');

  // Steering & Ackermann differential wheel speeds
  v.inputGear = 'D';
  v.speed = 40.0;
  v.inputSteer = -120; // Turn left
  v.step(0.1);

  const spdFL = (v.encode('7E3', '1477')[0] << 8 | v.encode('7E3', '1477')[1]) / 200.0;
  const spdFR = (v.encode('7E3', '1478')[0] << 8 | v.encode('7E3', '1478')[1]) / 200.0;
  assert.ok(spdFL < spdFR, `Turning left: inner FL (${spdFL}) must be slower than outer FR (${spdFR})`);

  // Doors
  v.manualDoors = 0x80 | 0x08; // Front right (driver) and Boot
  assert.equal(v.encode('720', '1201')[0], 0x88);

  // Headlights simulation bits on IBCM 720:2101 (preserving 0x0800 brake & 0x0100 reverse)
  v.inputBrake = 0;
  v.inputGear = 'D';
  v.inputHeadlights = 'off';
  v.step(0.1);
  let hlRaw = (v.encode('720', '2101')[0] << 8) | v.encode('720', '2101')[1];
  assert.equal(hlRaw & 0x0007, 0x0000);

  v.inputHeadlights = 'low';
  hlRaw = (v.encode('720', '2101')[0] << 8) | v.encode('720', '2101')[1];
  assert.equal(hlRaw & 0x0003, 0x0003);

  v.inputHeadlights = 'high';
  hlRaw = (v.encode('720', '2101')[0] << 8) | v.encode('720', '2101')[1];
  assert.equal(hlRaw & 0x0007, 0x0007);
});
