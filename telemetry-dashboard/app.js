/**
 * =============================================================================
 * AION V · Automotive In-Vehicle Telemetry Dashboard (app.js)
 * High-performance, zero-scroll responsive telemetry client for AION V (602 LFP)
 * =============================================================================
 */

(function () {
  'use strict';

  // --- Configuration & Constants ---
  const CONFIG = {
    wsEndpoint: 'ws://localhost:8080/ws',
    reconnect: {
      initialDelayMs: 1000,
      maxDelayMs: 10000,
      multiplier: 1.8,
    },
    batteryCapacityKwh: 75.3, // AION V 602 CATL LFP Pack
    nedcRangeKm: 602,
    marathonKm: 42.195,
    maxSpeedKmH: 200,
    gauge: {
      angleStart: 135, // deg (polar: bottom-left)
      angleSweep: 270, // deg clockwise
      radiusOuter: 80,
      radiusTickMajor: 70,
      radiusTickMinor: 75,
      radiusLabel: 58,
    },
    tpmsThresholds: {
      pressureLowDanger: 1.85,
      pressureLowWarning: 2.05,
      pressureHighWarning: 2.65,
      pressureHighDanger: 2.85,
      tempWarning: 55,
      tempDanger: 70,
    },
    updateIntervalMs: 100, // 10 Hz telemetry loop
    chartPointsMax: 40,
  };

  // --- State Store ---
  const state = {
    connected: false,
    simulating: false,
    lastFrameTime: performance.now(),
    tripStartMs: Date.now(),
    telemetry: {
      speed: 0,
      motorRpm: 0,
      motorTemp: 32,
      powerKw: 0,
      gear: 'P',
      soc: 79,
      remainingKwh: 37.4,
      rangeKm: 265,
      marathonCount: 6.3,
      batteryTemp: 29,
      plugged: false,
      chargingState: 'not_charging', // 'not_charging' | 'ac_charging' | 'dc_charging' | 'complete'
      chargePowerKw: 0,
      cabinTemp: 25.0,
      outsideTemp: 33,
      fanLevel: 1,
      acActive: true,
      locked: false,
      doors: { fl: false, fr: false, rl: false, rr: false, boot: false },
      tpms: {
        fl: { p: 2.3, t: 32 },
        fr: { p: 2.3, t: 32 },
        rl: { p: 2.3, t: 31 },
        rr: { p: 2.3, t: 32 },
      },
      odometerKm: 187384,
      tripKm: 0.0,
      tripSeconds: 0,
      efficiencyKmPerKwh: 7.2,
      efficiencyHistory: [7.1, 7.2, 7.3, 7.2, 7.0, 7.1, 7.2, 7.4, 7.3, 7.2],
    },
  };

  // --- DOM Elements Cache ---
  const el = {};

  function cacheDomElements() {
    // Car Top Module
    el.carSoc = document.getElementById('car-soc');
    el.rangeVal = document.getElementById('range-val');
    el.lockBadge = document.getElementById('lock-badge');
    el.healthBadge = document.getElementById('health-badge');
    el.marathonVal = document.getElementById('marathon-val');
    el.marathonRange = document.getElementById('marathon-range');
    el.gearVal = document.getElementById('gear-val');
    el.gearLabel = document.getElementById('gear-label');
    el.gearStripSpans = document.querySelectorAll('#gear-strip span');
    el.linkStatus = document.getElementById('link-status');
    el.linkText = document.getElementById('link-text');

    // Speed Module
    el.speedVal = document.getElementById('speed-val');
    el.speedArc = document.getElementById('speed-arc');
    el.speedNeedle = document.getElementById('speed-needle');
    el.speedTicks = document.getElementById('speed-ticks');
    el.powerVal = document.getElementById('power-val');
    el.motorRpm = document.getElementById('motor-rpm');
    el.motorTemp = document.getElementById('motor-temp');

    // Battery Module
    el.socVal = document.getElementById('soc-val');
    el.socRing = document.getElementById('soc-ring');
    el.kwhVal = document.getElementById('kwh-val');
    el.batteryTempTag = document.getElementById('battery-temp-tag');
    el.plugTag = document.getElementById('plug-tag');
    el.batteryFill = document.getElementById('battery-fill');

    // Charging Module
    el.chargingStatus = document.getElementById('charging-status');
    el.chargingDetail = document.getElementById('charging-detail');

    // Climate Module
    el.cabinTemp = document.getElementById('cabin-temp');
    el.fanLevel = document.getElementById('fan-level');
    el.outsideTemp = document.getElementById('outside-temp');
    el.thermoFill = document.getElementById('thermo-fill');
    el.acPill = document.getElementById('ac-pill');

    // Tires Module
    el.tires = {
      fl: {
        root: document.getElementById('tire-fl'),
        p: document.getElementById('tire-fl-p'),
        t: document.getElementById('tire-fl-t'),
      },
      fr: {
        root: document.getElementById('tire-fr'),
        p: document.getElementById('tire-fr-p'),
        t: document.getElementById('tire-fr-t'),
      },
      rl: {
        root: document.getElementById('tire-rl'),
        p: document.getElementById('tire-rl-p'),
        t: document.getElementById('tire-rl-t'),
      },
      rr: {
        root: document.getElementById('tire-rr'),
        p: document.getElementById('tire-rr-p'),
        t: document.getElementById('tire-rr-t'),
      },
    };

    // Odometer & Efficiency Module
    el.odoVal = document.getElementById('odo-val');
    el.tripVal = document.getElementById('trip-val');
    el.tripTime = document.getElementById('trip-time');
    el.effVal = document.getElementById('eff-val');
    el.effChart = document.getElementById('eff-chart');

    // Fallback images
    initImageFallbacks();
  }

  // --- Speedometer SVG Ticks & Labels Generator ---
  function buildSpeedometerTicks() {
    if (!el.speedTicks) return;
    const { angleStart, angleSweep, radiusOuter, radiusTickMajor, radiusTickMinor, radiusLabel } = CONFIG.gauge;
    const maxSpeed = CONFIG.maxSpeedKmH;
    const stepMinor = 10;
    const stepMajor = 20;

    const fragment = document.createDocumentFragment();
    const svgNs = 'http://www.w3.org/2000/svg';

    for (let speed = 0; speed <= maxSpeed; speed += stepMinor) {
      const isMajor = speed % stepMajor === 0;
      const progress = speed / maxSpeed;
      const angleDeg = angleStart + progress * angleSweep;
      const angleRad = (angleDeg * Math.PI) / 180;

      const cos = Math.cos(angleRad);
      const sin = Math.sin(angleRad);

      const rInner = isMajor ? radiusTickMajor : radiusTickMinor;

      // Tick line
      const line = document.createElementNS(svgNs, 'line');
      line.setAttribute('x1', (100 + radiusOuter * cos).toFixed(2));
      line.setAttribute('y1', (100 + radiusOuter * sin).toFixed(2));
      line.setAttribute('x2', (100 + rInner * cos).toFixed(2));
      line.setAttribute('y2', (100 + rInner * sin).toFixed(2));
      line.setAttribute('class', isMajor ? 'g-tick major' : 'g-tick');
      fragment.appendChild(line);

      // Major label (only at key increments: 0, 40, 80, 120, 160, 200 or all majors)
      if (isMajor && (speed % 40 === 0 || speed === 0)) {
        const text = document.createElementNS(svgNs, 'text');
        text.setAttribute('x', (100 + radiusLabel * cos).toFixed(2));
        text.setAttribute('y', (100 + radiusLabel * sin).toFixed(2));
        text.setAttribute('class', 'g-label');
        text.textContent = String(speed);
        fragment.appendChild(text);
      }
    }

    el.speedTicks.innerHTML = '';
    el.speedTicks.appendChild(fragment);
  }

  // --- Real-time WebSocket Client with Auto-reconnect ---
  let socket = null;
  let reconnectTimer = null;
  let currentDelayMs = CONFIG.reconnect.initialDelayMs;

  function connectWebSocket() {
    if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) {
      return;
    }

    setLinkStatus('connecting', 'Connecting…');

    try {
      socket = new WebSocket(CONFIG.wsEndpoint);
    } catch (err) {
      handleSocketFailure();
      return;
    }

    socket.onopen = function () {
      state.connected = true;
      currentDelayMs = CONFIG.reconnect.initialDelayMs;
      setLinkStatus('live', 'Live OBD');
      stopSimulation();
    };

    socket.onmessage = function (event) {
      try {
        const payload = JSON.parse(event.data);
        handleTelemetryMessage(payload);
      } catch (e) {
        console.warn('[Telemetry] Bad JSON frame:', e);
      }
    };

    socket.onerror = function () {
      // socket.onclose will trigger next
    };

    socket.onclose = function () {
      state.connected = false;
      handleSocketFailure();
    };
  }

  function handleSocketFailure() {
    if (!state.simulating) {
      // Failover immediately to smooth live simulation
      startSimulation();
      setLinkStatus('sim', 'Simulation Mode');
    }

    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(function () {
      connectWebSocket();
    }, currentDelayMs);

    currentDelayMs = Math.min(CONFIG.reconnect.maxDelayMs, currentDelayMs * CONFIG.reconnect.multiplier);
  }

  function setLinkStatus(stateAttr, text) {
    if (!el.linkStatus) return;
    el.linkStatus.setAttribute('data-state', stateAttr);
    if (el.linkText) el.linkText.textContent = text;
  }

  // --- Telemetry Message Parser & Safe Mapping ---
  function handleTelemetryMessage(data) {
    if (!data || typeof data !== 'object') return;
    const t = state.telemetry;

    // Direct mapping with fallbacks and multiple naming support
    if (data.speed !== undefined || data.speed_kmh !== undefined) {
      t.speed = Math.max(0, Math.min(CONFIG.maxSpeedKmH, Number(data.speed ?? data.speed_kmh) || 0));
    }

    if (data.motor_rpm !== undefined || data.rpm !== undefined) {
      t.motorRpm = Math.round(Number(data.motor_rpm ?? data.rpm) || 0);
    }

    if (data.motor_temp !== undefined || data.motor_temp_c !== undefined) {
      t.motorTemp = Math.round(Number(data.motor_temp ?? data.motor_temp_c) || 0);
    }

    if (data.power !== undefined || data.power_kw !== undefined) {
      t.powerKw = Number(data.power ?? data.power_kw) || 0;
    }

    if (data.gear !== undefined) {
      const g = String(data.gear).toUpperCase().trim();
      if (['P', 'R', 'N', 'D'].includes(g)) t.gear = g;
    }

    if (data.soc !== undefined || data.battery_soc !== undefined) {
      t.soc = Math.max(0, Math.min(100, Number(data.soc ?? data.battery_soc) || 0));
    }

    if (data.remaining_kwh !== undefined || data.battery_kwh !== undefined) {
      t.remainingKwh = Number(data.remaining_kwh ?? data.battery_kwh) || 0;
    }

    if (data.range_km !== undefined || data.range !== undefined) {
      t.rangeKm = Math.round(Number(data.range_km ?? data.range) || 0);
      t.marathonCount = (t.rangeKm / CONFIG.marathonKm).toFixed(1);
    }

    if (data.battery_temp !== undefined || data.battery_temp_c !== undefined) {
      t.batteryTemp = Math.round(Number(data.battery_temp ?? data.battery_temp_c) || 0);
    }

    if (data.plug_state !== undefined || data.plugged !== undefined) {
      t.plugged = Boolean(data.plug_state ?? data.plugged);
    }

    if (data.charging_state !== undefined || data.charge_state !== undefined) {
      t.chargingState = String(data.charging_state ?? data.charge_state);
    }

    if (data.cabin_temp !== undefined || data.cabin_temp_c !== undefined) {
      t.cabinTemp = Number(data.cabin_temp ?? data.cabin_temp_c) || 25;
    }

    if (data.outside_temp !== undefined || data.outside_temp_c !== undefined) {
      t.outsideTemp = Math.round(Number(data.outside_temp ?? data.outside_temp_c) || 30);
    }

    if (data.fan_level !== undefined) {
      t.fanLevel = Number(data.fan_level) || 1;
    }

    if (data.ac_active !== undefined) {
      t.acActive = Boolean(data.ac_active);
    }

    if (data.locked !== undefined) {
      t.locked = Boolean(data.locked);
    }

    if (data.tpms) {
      ['fl', 'fr', 'rl', 'rr'].forEach((pos) => {
        if (data.tpms[pos]) {
          if (data.tpms[pos].p !== undefined || data.tpms[pos].pressure !== undefined) {
            t.tpms[pos].p = Number(data.tpms[pos].p ?? data.tpms[pos].pressure);
          }
          if (data.tpms[pos].t !== undefined || data.tpms[pos].temp !== undefined) {
            t.tpms[pos].t = Number(data.tpms[pos].t ?? data.tpms[pos].temp);
          }
        }
      });
    }

    if (data.odometer_km !== undefined || data.odometer !== undefined) {
      t.odometerKm = Math.round(Number(data.odometer_km ?? data.odometer) || 0);
    }

    if (data.trip_km !== undefined) {
      t.tripKm = Number(data.trip_km) || 0;
    }

    if (data.efficiency_km_kwh !== undefined) {
      t.efficiencyKmPerKwh = Number(data.efficiency_km_kwh) || 0;
      t.efficiencyHistory.push(t.efficiencyKmPerKwh);
      if (t.efficiencyHistory.length > CONFIG.chartPointsMax) {
        t.efficiencyHistory.shift();
      }
    }

    updateDashboard();
  }

  // --- Dashboard DOM Render Sync ---
  function updateDashboard() {
    const t = state.telemetry;

    // 1. CAR TOP
    if (el.carSoc) el.carSoc.textContent = Math.round(t.soc);
    if (el.rangeVal) el.rangeVal.textContent = Math.round(t.rangeKm);

    if (el.lockBadge) {
      el.lockBadge.textContent = t.locked ? 'Locked' : 'Unlocked';
      el.lockBadge.className = `badge ${t.locked ? 'badge-success' : 'badge-danger'}`;
    }

    if (el.marathonVal) el.marathonVal.textContent = t.marathonCount;
    if (el.marathonRange) el.marathonRange.textContent = Math.round(t.rangeKm);

    // Gear
    if (el.gearVal) {
      el.gearVal.textContent = t.gear;
      el.gearVal.setAttribute('data-gear', t.gear);
    }
    if (el.gearLabel) {
      const labels = { P: 'Park', R: 'Reverse', N: 'Neutral', D: 'Drive' };
      el.gearLabel.textContent = labels[t.gear] || 'Park';
    }
    if (el.gearStripSpans) {
      el.gearStripSpans.forEach((span) => {
        const g = span.getAttribute('data-g');
        span.classList.toggle('on', g === t.gear);
      });
    }

    // 2. SPEEDOMETER & MOTOR
    if (el.speedVal) el.speedVal.textContent = Math.round(t.speed);

    const speedFrac = Math.max(0, Math.min(1, t.speed / CONFIG.maxSpeedKmH));
    if (el.speedArc) {
      // pathLength is 100
      el.speedArc.style.strokeDashoffset = (100 - speedFrac * 100).toFixed(1);
    }
    if (el.speedNeedle) {
      // Needle rotates from -135deg to +135deg
      const angle = -135 + speedFrac * 270;
      el.speedNeedle.style.transform = `rotate(${angle.toFixed(1)}deg)`;
    }

    if (el.powerVal) el.powerVal.textContent = (t.powerKw >= 0 ? '+' : '') + t.powerKw.toFixed(1);
    if (el.motorRpm) el.motorRpm.textContent = t.motorRpm.toLocaleString();
    if (el.motorTemp) el.motorTemp.textContent = Math.round(t.motorTemp);

    // 3. BATTERY
    if (el.socVal) el.socVal.textContent = Math.round(t.soc);
    if (el.socRing) {
      // pathLength is 100, circle r=50
      el.socRing.style.strokeDashoffset = (100 - t.soc).toFixed(1);
      if (t.soc <= 10) {
        el.socRing.style.stroke = 'var(--danger)';
      } else if (t.soc <= 20) {
        el.socRing.style.stroke = 'var(--warning)';
      } else {
        el.socRing.style.stroke = 'var(--accent)';
      }
    }
    if (el.kwhVal) el.kwhVal.textContent = t.remainingKwh.toFixed(1);
    if (el.batteryTempTag) el.batteryTempTag.textContent = `${Math.round(t.batteryTemp)} °C`;
    if (el.plugTag) el.plugTag.textContent = t.plugged ? 'Plugged' : 'Unplugged';

    if (el.batteryFill) {
      const isCharging = t.chargingState.includes('charging');
      el.batteryFill.style.transform = `scaleY(${(Math.max(2, t.soc) / 100).toFixed(3)})`;
      el.batteryFill.setAttribute('data-level', t.soc <= 10 ? 'danger' : t.soc <= 20 ? 'warning' : 'ok');
      el.batteryFill.classList.toggle('charging', isCharging);
    }

    // 4. CHARGING
    if (el.chargingStatus) {
      el.chargingStatus.setAttribute('data-state', t.chargingState);
      const chargeTextMap = {
        not_charging: 'Not charging',
        ac_charging: 'AC Charging',
        dc_charging: 'DC Fast Charging',
        complete: 'Charging Complete',
        plugged: 'Cable Connected',
      };
      el.chargingStatus.textContent = chargeTextMap[t.chargingState] || 'Not charging';
    }
    if (el.chargingDetail) {
      if (t.chargingState === 'ac_charging') {
        el.chargingDetail.textContent = `AC 6.6 kW · Est. 1h 45m left`;
      } else if (t.chargingState === 'dc_charging') {
        el.chargingDetail.textContent = `DC 58 kW · Est. 22m to 80%`;
      } else if (t.chargingState === 'complete') {
        el.chargingDetail.textContent = `Battery full · 100%`;
      } else {
        el.chargingDetail.textContent = t.plugged ? 'Ready to charge' : 'Plug in to start charging';
      }
    }

    // 5. CLIMATE
    if (el.cabinTemp) el.cabinTemp.textContent = t.cabinTemp.toFixed(1);
    if (el.fanLevel) el.fanLevel.textContent = t.fanLevel;
    if (el.outsideTemp) el.outsideTemp.textContent = Math.round(t.outsideTemp);
    if (el.acPill) el.acPill.classList.toggle('on', t.acActive);

    // Thermometer mercury height & color
    if (el.thermoFill) {
      // Scale: -20°C to +40°C = 60 range, tube span = 66 px
      const thermoRatio = Math.max(0, Math.min(1, (t.outsideTemp - -20) / 60));
      const h = Math.max(4, Math.round(thermoRatio * 66));
      const y = 72 - h;
      el.thermoFill.setAttribute('y', String(y));
      el.thermoFill.setAttribute('height', String(h));

      const thermoColor = t.outsideTemp >= 35 ? '#ef4444' : t.outsideTemp >= 28 ? '#f59e0b' : '#06b6d4';
      el.thermoFill.style.fill = thermoColor;
    }

    // 6. TIRES (TPMS)
    ['fl', 'fr', 'rl', 'rr'].forEach((pos) => {
      const tire = el.tires[pos];
      if (!tire || !tire.root) return;
      const data = t.tpms[pos];

      if (tire.p) tire.p.textContent = data.p.toFixed(1);
      if (tire.t) tire.t.textContent = Math.round(data.t);

      // Warning / Danger thresholds
      const th = CONFIG.tpmsThresholds;
      let pLevel = 'ok';
      if (data.p <= th.pressureLowDanger || data.p >= th.pressureHighDanger) {
        pLevel = 'danger';
      } else if (data.p <= th.pressureLowWarning || data.p >= th.pressureHighWarning) {
        pLevel = 'warning';
      }
      tire.root.setAttribute('data-level', pLevel);

      let tLevel = 'ok';
      if (data.t >= th.tempDanger) {
        tLevel = 'danger';
      } else if (data.t >= th.tempWarning) {
        tLevel = 'warning';
      }
      tire.root.setAttribute('data-temp', tLevel);
    });

    // 7. ODOMETER & TRIP
    if (el.odoVal) el.odoVal.textContent = t.odometerKm.toLocaleString();
    if (el.tripVal) el.tripVal.textContent = t.tripKm.toFixed(1);
    if (el.tripTime) {
      const mins = Math.floor(t.tripSeconds / 60);
      const secs = t.tripSeconds % 60;
      el.tripTime.textContent = `${mins}:${secs < 10 ? '0' : ''}${secs}`;
    }

    // 8. EFFICIENCY
    if (el.effVal) el.effVal.textContent = t.efficiencyKmPerKwh.toFixed(1);
    drawEfficiencyChart();
  }

  // --- Dynamic Efficiency Chart (Canvas) ---
  function drawEfficiencyChart() {
    const canvas = el.effChart;
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    if (canvas.width !== Math.round(rect.width * dpr) || canvas.height !== Math.round(rect.height * dpr)) {
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
    }

    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);

    const history = state.telemetry.efficiencyHistory;
    if (!history || history.length < 2) return;

    const minVal = 4.0;
    const maxVal = 10.0;
    const range = maxVal - minVal;

    const points = history.map((val, idx) => {
      const x = (idx / (history.length - 1)) * (w - 12 * dpr) + 6 * dpr;
      const norm = Math.max(0, Math.min(1, (val - minVal) / range));
      const y = h - (norm * (h - 14 * dpr) + 7 * dpr);
      return { x, y };
    });

    // Gradient area
    const gradient = ctx.createLinearGradient(0, 0, 0, h);
    gradient.addColorStop(0, 'rgba(6, 182, 212, 0.35)');
    gradient.addColorStop(1, 'rgba(6, 182, 212, 0.0)');

    ctx.beginPath();
    ctx.moveTo(points[0].x, h);
    ctx.lineTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1];
      const curr = points[i];
      const cx = (prev.x + curr.x) / 2;
      ctx.quadraticCurveTo(prev.x, prev.y, cx, (prev.y + curr.y) / 2);
    }
    ctx.lineTo(points[points.length - 1].x, points[points.length - 1].y);
    ctx.lineTo(points[points.length - 1].x, h);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    // Line stroke with glow
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1];
      const curr = points[i];
      const cx = (prev.x + curr.x) / 2;
      ctx.quadraticCurveTo(prev.x, prev.y, cx, (prev.y + curr.y) / 2);
    }
    ctx.lineTo(points[points.length - 1].x, points[points.length - 1].y);
    ctx.strokeStyle = '#06b6d4';
    ctx.lineWidth = 2.2 * dpr;
    ctx.shadowColor = '#06b6d4';
    ctx.shadowBlur = 8 * dpr;
    ctx.stroke();

    // Pulse dot at current head
    const head = points[points.length - 1];
    ctx.beginPath();
    ctx.arc(head.x, head.y, 3.8 * dpr, 0, Math.PI * 2);
    ctx.fillStyle = '#67e8f9';
    ctx.shadowBlur = 12 * dpr;
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  // --- Realistic Automotive Simulation Engine ---
  let simTimer = null;
  let simPhase = 0;
  let targetSpeed = 0;
  let cycleTimer = 0;

  function startSimulation() {
    if (state.simulating) return;
    state.simulating = true;
    console.log('[Telemetry] Simulation engine started.');

    let lastTick = performance.now();

    simTimer = setInterval(() => {
      const now = performance.now();
      const dt = (now - lastTick) / 1000;
      lastTick = now;

      simPhase += dt;
      cycleTimer += dt;

      // Realistic drive cycle: alternate between Park, Acceleration, Cruise, Regen brake
      // Cycle lasts ~40 seconds
      const cycle = cycleTimer % 45;
      const t = state.telemetry;

      if (cycle < 6) {
        // Stopped in Park / Traffic
        targetSpeed = 0;
        t.gear = cycle < 3 ? 'P' : 'D';
        t.locked = false;
      } else if (cycle < 16) {
        // Accelerating up to highway speed
        t.gear = 'D';
        t.locked = true;
        targetSpeed = 65 + 25 * Math.sin((cycle - 6) * 0.3);
      } else if (cycle < 32) {
        // Cruising with gentle throttle adjustments
        t.gear = 'D';
        t.locked = true;
        targetSpeed = 82 + 8 * Math.sin(simPhase * 0.8) + 4 * Math.cos(simPhase * 1.7);
      } else if (cycle < 39) {
        // Deceleration / Regenerative Braking
        t.gear = 'D';
        targetSpeed = 15;
      } else {
        // Coming to a full stop
        targetSpeed = 0;
        t.gear = 'D';
      }

      // Smooth physics approach for speed (km/h)
      const accelRate = targetSpeed > t.speed ? 24 : 32; // km/h per sec
      const speedDiff = targetSpeed - t.speed;
      const step = Math.sign(speedDiff) * Math.min(Math.abs(speedDiff), accelRate * dt);
      t.speed = Math.max(0, Math.min(CONFIG.maxSpeedKmH, t.speed + step));

      // Motor RPM: AION V single speed gear ratio (~72 rpm per 1 km/h)
      t.motorRpm = Math.round(t.speed * 71.5 + (t.speed > 0 ? (Math.random() - 0.5) * 20 : 0));

      // Power kW: Positive on acceleration/cruising, negative on regen
      if (t.speed === 0) {
        t.powerKw = 0.8; // Baseline cabin HVAC draw
      } else if (step > 0.05) {
        // Accelerating
        t.powerKw = 18 + (t.speed / 100) * 55 + (step / dt) * 1.5;
      } else if (step < -0.1) {
        // Regenerative braking (negative kW)
        t.powerKw = -Math.min(42, Math.abs(step) * 2.8);
      } else {
        // Steady cruise
        t.powerKw = 11 + (t.speed / 100) * 14;
      }

      // Motor temp gradually responds to load
      t.motorTemp = 32 + (t.speed / 120) * 8 + Math.sin(simPhase * 0.05) * 1.5;

      // Odometer & Trip
      const kmTraveled = (t.speed / 3600) * dt;
      t.odometerKm += kmTraveled;
      t.tripKm += kmTraveled;
      t.tripSeconds = Math.floor((Date.now() - state.tripStartMs) / 1000);

      // Battery depletion (very slow realistic rate)
      if (t.speed > 0) {
        t.remainingKwh = Math.max(5, t.remainingKwh - (t.powerKw > 0 ? (t.powerKw / 3600) * dt : 0));
        t.soc = (t.remainingKwh / CONFIG.batteryCapacityKwh) * 100;
        t.rangeKm = (t.soc / 100) * CONFIG.nedcRangeKm;
        t.marathonCount = (t.rangeKm / CONFIG.marathonKm).toFixed(1);
      }

      // Efficiency calculation
      if (t.speed > 20) {
        const instantEff = t.powerKw > 0 ? t.speed / t.powerKw : 9.5;
        t.efficiencyKmPerKwh = Math.max(4.5, Math.min(9.8, instantEff));
      }

      // TPMS minor thermodynamic fluctuations
      const heatFactor = (t.speed / 100) * 0.04;
      t.tpms.fl.p = 2.3 + heatFactor + 0.01 * Math.sin(simPhase * 0.3);
      t.tpms.fr.p = 2.3 + heatFactor + 0.01 * Math.cos(simPhase * 0.3);
      t.tpms.rl.p = 2.3 + heatFactor * 0.8;
      t.tpms.rr.p = 2.3 + heatFactor * 0.8;

      t.tpms.fl.t = 31 + Math.round((t.speed / 50) * 3);
      t.tpms.fr.t = 31 + Math.round((t.speed / 50) * 3);
      t.tpms.rl.t = 30 + Math.round((t.speed / 60) * 2);
      t.tpms.rr.t = 30 + Math.round((t.speed / 60) * 2);

      // Push history periodically (~every 1s)
      if (Math.floor(simPhase * 2) !== Math.floor((simPhase - dt) * 2)) {
        t.efficiencyHistory.push(Number(t.efficiencyKmPerKwh.toFixed(1)));
        if (t.efficiencyHistory.length > CONFIG.chartPointsMax) {
          t.efficiencyHistory.shift();
        }
      }

      updateDashboard();
    }, CONFIG.updateIntervalMs);
  }

  function stopSimulation() {
    if (!state.simulating) return;
    state.simulating = false;
    if (simTimer) {
      clearInterval(simTimer);
      simTimer = null;
    }
    console.log('[Telemetry] Simulation engine paused. Live WebSocket connected.');
  }

  // --- SVG Vector Car Fallbacks (In case assets are missing/offline) ---
  function initImageFallbacks() {
    const images = document.querySelectorAll('img[data-fallback]');
    images.forEach((img) => {
      img.addEventListener('error', function () {
        const type = this.getAttribute('data-fallback');
        const parent = this.parentElement;
        if (!parent) return;

        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 400 240');
        svg.setAttribute('class', 'car-fallback-svg');
        svg.style.width = '100%';
        svg.style.height = '100%';

        if (type === 'front') {
          svg.innerHTML = `
            <defs>
              <linearGradient id="cf_grad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.7"/>
                <stop offset="100%" stop-color="#0284c7" stop-opacity="0.3"/>
              </linearGradient>
            </defs>
            <path d="M70,170 Q100,100 130,70 Q200,60 270,70 Q300,100 330,170 Q280,185 200,185 Q120,185 70,170 Z" fill="url(#cf_grad)" stroke="#38bdf8" stroke-width="2"/>
            <path d="M125,75 Q200,66 275,75 L290,115 Q200,110 110,115 Z" fill="#0f172a" stroke="#38bdf8" stroke-width="1.5"/>
            <circle cx="105" cy="140" r="14" fill="#67e8f9" opacity="0.9" filter="drop-shadow(0 0 8px #06b6d4)"/>
            <circle cx="295" cy="140" r="14" fill="#67e8f9" opacity="0.9" filter="drop-shadow(0 0 8px #06b6d4)"/>
            <rect x="175" y="152" width="50" height="12" rx="3" fill="#1e293b" stroke="#64748b"/>
          `;
        } else if (type === 'rear') {
          svg.innerHTML = `
            <defs>
              <linearGradient id="cr_grad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.6"/>
                <stop offset="100%" stop-color="#0284c7" stop-opacity="0.25"/>
              </linearGradient>
            </defs>
            <path d="M75,175 Q105,100 135,70 Q200,62 265,70 Q295,100 325,175 Q275,188 200,188 Q125,188 75,175 Z" fill="url(#cr_grad)" stroke="#38bdf8" stroke-width="2"/>
            <path d="M130,75 Q200,68 270,75 L285,115 Q200,112 115,115 Z" fill="#0f172a" stroke="#38bdf8" stroke-width="1.5"/>
            <path d="M90,135 L310,135" stroke="#ef4444" stroke-width="4" stroke-linecap="round" filter="drop-shadow(0 0 8px #ef4444)"/>
          `;
        } else if (type === 'top') {
          svg.setAttribute('viewBox', '0 0 200 360');
          svg.innerHTML = `
            <path d="M50,80 Q50,20 100,20 Q150,20 150,80 L155,270 Q155,340 100,340 Q45,340 45,270 Z" fill="#0f172a" stroke="#38bdf8" stroke-width="2"/>
            <rect x="65" y="90" width="70" height="60" rx="8" fill="#1e293b" stroke="#38bdf8" stroke-width="1.2"/>
            <rect x="65" y="170" width="70" height="85" rx="6" fill="#1e293b" stroke="#38bdf8" stroke-width="1.2"/>
            <rect x="35" y="65" width="12" height="34" rx="4" fill="#475569"/>
            <rect x="153" y="65" width="12" height="34" rx="4" fill="#475569"/>
            <rect x="35" y="250" width="12" height="34" rx="4" fill="#475569"/>
            <rect x="153" y="250" width="12" height="34" rx="4" fill="#475569"/>
          `;
        }

        parent.replaceChild(svg, this);
      });
    });
  }

  // --- Window Resize & Responsive Handling ---
  window.addEventListener('resize', () => {
    drawEfficiencyChart();
  });

  // --- Document Bootstrap ---
  document.addEventListener('DOMContentLoaded', () => {
    cacheDomElements();
    buildSpeedometerTicks();
    updateDashboard();
    connectWebSocket();
  });
})();
