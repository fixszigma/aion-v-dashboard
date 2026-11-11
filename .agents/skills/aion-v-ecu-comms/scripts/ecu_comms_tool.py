#!/usr/bin/env python3
"""
GAC Aion V 602 — Full 22-ECU UDS Communication Planner, ISO-TP Parser & Verified Decoder.

Zero external dependencies (Python 3 standard library only).
Implements strict Read-Only policy (UDS 0x22 ReadDataByIdentifier, 0x19 ReadDTCInformation,
0x3E TesterPresent only) and high-throughput ELM327 / STN (vLinker FD+) optimizations.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from dataclasses import dataclass
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Tuple


ALLOWED_UDS_SERVICES = frozenset({0x22, 0x19, 0x3E})
BATTERY_NOMINAL_KWH = 75.3
CELL_COUNT = 112
TEMP_SENSOR_COUNT = 24
BMU_TEMP_COUNT = 16


@dataclass(frozen=True)
class EcuSpec:
    key: str
    name: str
    tx: str
    rx: str
    part_number: str
    system_name: str
    multi_did: bool = True
    needs_fc_override: bool = False
    slow_or_busy: bool = False


ECU_MAP: Dict[str, EcuSpec] = {
    # +0x08 offset group
    "7E2": EcuSpec("BMS", "Battery Management System", "7E2", "7EA", "2520105CVN1201", "A12_UAES_BMS", True, False),
    "7E3": EcuSpec("VCU", "Vehicle Control Unit", "7E3", "7EB", "1110003CVN0211", "VCU-UAES", True, False),
    "7E4": EcuSpec("MCU", "Motor Controller", "7E4", "7EC", "1510046CVN4200", "MCU", True, False),
    "7E6": EcuSpec("CCU", "Charger & DC-DC Converter", "7E6", "7EE", "2730003CVN0601", "EVT_6D6_CCU_B", True, False),
    "760": EcuSpec("EOP", "Unknown (A29-EOP)", "760", "768", "1322005CVN0000", "A29-EOP", True, True),
    "765": EcuSpec("MFS", "Steering-Wheel Switches", "765", "76D", "8220005CVN0000", "GAC-AY5-MFS", True, True),
    # +0x80 offset group (require ATFCSH override on ELM327/STN for multi-frame ISO-TP)
    "705": EcuSpec("UNK_705", "Unknown Slow Module", "705", "785", "2610003ERD0100", "", False, True, slow_or_busy=True),
    "710": EcuSpec("IPB", "Brakes & Stability (Bosch IPB)", "710", "790", "8085004ERD0002", "Bosch_IPB", False, True),
    "711": EcuSpec("EPB", "Parking Brake (EPB)", "711", "791", "8080003CVN0100", "WBTLEPB-20", True, True),
    "718": EcuSpec("DOOR_L", "Door Module Left", "718", "798", "8065005", "DOOR_L", True, True),
    "719": EcuSpec("DOOR_R", "Door Module Right (RHD Driver)", "719", "799", "8065004", "DOOR_R", True, True),
    "720": EcuSpec("IBCM", "Body Control Module (Continental)", "720", "7A0", "8045025CVN0501", "Continental_IBCM", True, True),
    "724": EcuSpec("LIFTGATE", "Power Liftgate", "724", "7A4", "8045014CVN0003", "Power_Liftgate", True, True),
    "72B": EcuSpec("IC", "Instrument Cluster / Head Unit", "72B", "7AB", "8545003CVN0403", "AY5G_IC2254", True, True),
    "72D": EcuSpec("TBOX", "Telematics Box", "72D", "7AD", "8550003CVN1903", "GAEI", True, True),
    "734": EcuSpec("SRS", "Airbag / Seatbelt (Unconfirmed)", "734", "7B4", "8265010CVN0001", "", True, True),
    "73E": EcuSpec("FR", "Front Radar (Bosch)", "73E", "7BE", "8087003CVN0700", "GAC-AY2.5-Bosch-FR", True, True),
    "73F": EcuSpec("BSD_L", "Rear Blind-Spot Radar 1 (Bosch)", "73F", "7BF", "8535009CVN0500", "Bosch-BSD", True, True),
    "740": EcuSpec("IFC", "Front Camera (Bosch)", "740", "7C0", "8540009CVN0400", "GAC-AY2.5-Bosch-IFC", True, True),
    "748": EcuSpec("WPC", "Wireless Phone Charger", "748", "7C8", "8245028ERD0002", "INVISPOWER", True, True),
    "74A": EcuSpec("BSD_R", "Rear Blind-Spot Radar 2 (Bosch)", "74A", "7CA", "8535009CVN0500", "Bosch-BSD", True, True),
    "74F": EcuSpec("GWM", "Gateway Module", "74F", "7CF", "8045196ERD0303", "+GWM30", True, True),
}


@dataclass(frozen=True)
class DidSpec:
    tx: str
    did: str
    name: str
    unit: str
    byte_len: int
    min_len: int
    conf: str  # 'known' | 'guess'
    tier: str  # 'turbo' | 'fast' | 'slow' | 'once'
    decoder: Callable[[bytes], Any]


# ---------------------------------------------------------------------------
# Decoding Primitives (Big-Endian)
# ---------------------------------------------------------------------------
def u8(b: bytes) -> int:
    return b[0]


def u16(b: bytes) -> int:
    return int.from_bytes(b[:2], "big", signed=False)


def u24(b: bytes) -> int:
    return int.from_bytes(b[:3], "big", signed=False)


def decode_ascii(b: bytes) -> str:
    cleaned = bytes(x for x in b if x not in (0x00, 0xFF))
    return cleaned.decode("ascii", errors="replace").strip()


def decode_bcd_clock(b: bytes) -> str:
    # 7 bytes: 20 26 10 11 18 33 34 -> "2026-10-11 18:33:34"
    h = [f"{x:02X}" for x in b[:7]]
    return f"{h[0]}{h[1]}-{h[2]}-{h[3]} {h[4]}:{h[5]}:{h[6]}"


def decode_bin_clock_utc8(b: bytes) -> str:
    # 6 bytes: 1A 0A 0B 15 04 0F -> "2026-10-11 21:04:15"
    yr = 2000 + b[0]
    return f"{yr:04d}-{b[1]:02d}-{b[2]:02d} {b[3]:02d}:{b[4]:02d}:{b[5]:02d}"


def decode_cell_voltages(b: bytes) -> List[int]:
    n = min(len(b), CELL_COUNT * 2)
    return [u16(b[i : i + 2]) - 5000 for i in range(0, n - 1, 2)]


def decode_temps_offset40(count: int) -> Callable[[bytes], List[int]]:
    return lambda b: [x - 40 for x in b[:count]]


def decode_tpms(b: bytes) -> Dict[str, float]:
    out: Dict[str, float] = {}
    for i in range(4):
        psi = round(b[i * 2] / 5.0, 1)
        out[f"tire_{i + 1}_psi"] = psi
        out[f"tire_{i + 1}_bar"] = round(psi / 14.5038, 2)
        out[f"tire_{i + 1}_c"] = float(b[i * 2 + 1] - 50)
    return out


def decode_doors(b: bytes) -> Dict[str, bool]:
    x = b[0]
    return {
        "front_right_open": bool(x & 0x80),
        "front_left_open": bool(x & 0x40),
        "rear_left_open": bool(x & 0x20),
        "rear_right_open": bool(x & 0x10),
        "boot_open": bool(x & 0x08),
    }


def decode_gear(b: bytes) -> str:
    return {6: "P", 1: "D", 5: "R", 4: "N"}.get(b[0], f"?{b[0]}")


def decode_lock_state(b: bytes) -> str:
    v = u16(b)
    if v == 0xA800:
        return "LOCKED"
    if v == 0x9400:
        return "UNLOCKED"
    return f"0x{v:04X}"


def decode_windows(b: bytes) -> Dict[str, Any]:
    mot = {0: "stop", 1: "up", 2: "down"}
    return {
        "front_pct": round(b[1] / 2.0, 1),
        "front_motion": mot.get(b[2], "stop"),
        "rear_pct": round(b[5] / 2.0, 1),
        "rear_motion": mot.get(b[6], "stop"),
    }


def decode_ipb_dynamics(b: bytes) -> Dict[str, Optional[float]]:
    steer = u16(b[0:2])
    return {
        "steering_angle_deg": None if steer == 0xFFFF else round((15610 - steer) * 0.1, 1),
        "lateral_accel_ms2": round((u16(b[2:4]) - 792) * 0.025, 3),
        "longitudinal_accel_ms2": round((u16(b[4:6]) - 796) * 0.025, 3),
        "yaw_rate_degs": round((u16(b[6:8]) - 981) * 0.1, 1),
        "brake_pressure_raw": float(max(0, u16(b[8:10]) - 2778)),
    }


def decode_power_limit(b: bytes) -> float:
    v = u16(b)
    return round(v / 100.0, 2) if v > 1000 else float(v)


def decode_lamps_2101(b: bytes) -> Dict[str, Any]:
    raw = u16(b)
    return {
        "brake_light": bool(raw & 0x0800),
        "reverse_light": bool(raw & 0x0100),
        "raw_hex": f"{raw:04X}",
        "raw": raw,
    }


DID_CATALOG: Dict[Tuple[str, str], DidSpec] = {}


def _reg(tx: str, did: str, name: str, unit: str, byte_len: int, conf: str, tier: str, fn: Callable[[bytes], Any], min_len: Optional[int] = None) -> None:
    tx_u, did_u = tx.upper(), did.upper()
    DID_CATALOG[(tx_u, did_u)] = DidSpec(tx_u, did_u, name, unit, byte_len, min_len or byte_len, conf, tier, fn)


# Universal 12V supply (DID 1000 across modules)
for _tx, _tier, _conf in [
    ("7E2", "slow", "known"), ("7E3", "slow", "known"), ("7E4", "slow", "known"),
    ("718", "slow", "known"), ("719", "slow", "known"), ("720", "slow", "known"),
    ("724", "slow", "known"), ("72B", "slow", "known"), ("72D", "slow", "known"),
    ("734", "slow", "known"), ("74F", "slow", "known"), ("765", "slow", "guess"),
]:
    _reg(_tx, "1000", f"aux_12v_{ECU_MAP[_tx].key.lower()}", "V", 1, _conf, _tier, lambda b: round(u8(b) / 10.0, 1))

# BMS (7E2)
_reg("7E2", "0300", "battery_pack_code", "", 37, "known", "once", decode_ascii, min_len=1)
_reg("7E2", "1002", "soh", "%", 2, "known", "slow", lambda b: round(u16(b) / 100.0, 2))
_reg("7E2", "1004", "bms_counter", "ticks", 2, "known", "slow", u16)
_reg("7E2", "1101", "cell_max_index", "#", 1, "known", "slow", u8)
_reg("7E2", "1103", "cell_min_index", "#", 1, "known", "slow", u8)
_reg("7E2", "1105", "pack_voltage_alt", "V", 2, "known", "slow", lambda b: round(u16(b) / 10.0, 1))
_reg("7E2", "1106", "cell_sum_voltage", "V", 2, "known", "slow", lambda b: round(u16(b) / 10.0, 1))
_reg("7E2", "1114", "soc_cell_avg", "%", 1, "known", "slow", u8)
_reg("7E2", "1115", "bat_temp_max_index", "#", 1, "known", "slow", u8)
_reg("7E2", "1116", "bat_temp_min_index", "#", 1, "known", "slow", u8)
_reg("7E2", "111A", "soc_display", "%", 2, "known", "slow", u16)
_reg("7E2", "111B", "soc_bms", "%", 2, "guess", "slow", u16)
_reg("7E2", "1136", "cc2_voltage", "V", 1, "known", "slow", lambda b: round(u8(b) / 10.0, 1))
_reg("7E2", "114D", "energy_charged_total", "kWh", 3, "known", "slow", lambda b: round(u24(b) / 10.0, 1))
_reg("7E2", "1150", "battery_temps", "°C", 54, "known", "slow", decode_temps_offset40(TEMP_SENSOR_COUNT), min_len=TEMP_SENSOR_COUNT)
_reg("7E2", "1151", "cell_voltages", "mV", 300, "known", "slow", decode_cell_voltages, min_len=CELL_COUNT * 2)
_reg("7E2", "1180", "bmu_temps", "°C", 32, "known", "slow", decode_temps_offset40(BMU_TEMP_COUNT), min_len=BMU_TEMP_COUNT)
_reg("7E2", "1181", "bmu_temp_max", "°C", 1, "known", "slow", lambda b: u8(b) - 40)
_reg("7E2", "1182", "bmu_temp_min", "°C", 1, "known", "slow", lambda b: u8(b) - 40)
_reg("7E2", "1183", "bmu_temp_avg", "°C", 1, "known", "slow", lambda b: u8(b) - 40)
_reg("7E2", "1184", "bmu_temp_max_index", "#", 1, "known", "slow", u8)
_reg("7E2", "1189", "energy_discharged_total", "kWh", 3, "known", "slow", lambda b: round(u24(b) / 10.0, 1))
_reg("7E2", "1401", "pack_voltage", "V", 2, "known", "fast", lambda b: round(u16(b) / 10.0, 1))
_reg("7E2", "1404", "pack_current", "A", 2, "guess", "fast", lambda b: round((u16(b) - 8000) / 10.0, 1))
_reg("7E2", "141E", "soc_display_alt", "%", 2, "known", "slow", u16)
_reg("7E2", "2020", "cell_max_mv", "mV", 2, "known", "slow", lambda b: u16(b) - 5000)
_reg("7E2", "2022", "cell_min_mv", "mV", 2, "known", "slow", lambda b: u16(b) - 5000)
_reg("7E2", "2023", "cell_avg_mv", "mV", 2, "known", "slow", lambda b: u16(b) - 5000)
_reg("7E2", "2024", "bat_temp_max", "°C", 1, "known", "slow", lambda b: u8(b) - 40)
_reg("7E2", "2026", "bat_temp_min", "°C", 1, "known", "slow", lambda b: u8(b) - 40)

# VCU (7E3)
_reg("7E3", "0511", "vcu_clock_utc8", "datetime", 6, "known", "once", decode_bin_clock_utc8)
_reg("7E3", "1442", "pack_voltage_vcu", "V", 2, "known", "slow", lambda b: round(u16(b) / 10.0, 1))
_reg("7E3", "144D", "motor_temp_1", "°C", 2, "known", "slow", lambda b: u16(b) - 40)
_reg("7E3", "144E", "motor_temp_2", "°C", 2, "known", "slow", lambda b: u16(b) - 40)
_reg("7E3", "146B", "soc_precise", "%", 1, "known", "fast", lambda b: round(u8(b) / 2.0, 1))
_reg("7E3", "1477", "wheel_speed_fl", "km/h", 2, "known", "fast", lambda b: round(u16(b) / 200.0, 2))
_reg("7E3", "1478", "wheel_speed_fr", "km/h", 2, "known", "fast", lambda b: round(u16(b) / 200.0, 2))
_reg("7E3", "1479", "wheel_speed_rl", "km/h", 2, "known", "fast", lambda b: round(u16(b) / 200.0, 2))
_reg("7E3", "147A", "wheel_speed_rr", "km/h", 2, "known", "fast", lambda b: round(u16(b) / 200.0, 2))
_reg("7E3", "2103", "gear", "", 1, "known", "fast", decode_gear)
_reg("7E3", "2104", "ac_active", "bool", 1, "guess", "slow", lambda b: b[0] in (5, 6))
_reg("7E3", "2313", "discharge_power_limit", "kW", 2, "known", "slow", decode_power_limit)
_reg("7E3", "2314", "charge_power_limit", "kW", 2, "known", "slow", decode_power_limit)

# MCU (7E4)
_reg("7E4", "0511", "mcu_clock_utc8", "datetime", 6, "known", "once", decode_bin_clock_utc8)
_reg("7E4", "1100", "inverter_dc_bus_v", "V", 2, "known", "fast", u16)
_reg("7E4", "1104", "motor_temp_mcu", "°C", 1, "known", "slow", lambda b: u8(b) - 40)
_reg("7E4", "1110", "motor_rpm", "rpm", 2, "known", "fast", lambda b: u16(b) - 32767)
_reg("7E4", "1408", "motor_torque", "raw", 2, "guess", "fast", lambda b: u16(b) - 1100)

# CCU (7E6)
_reg("7E6", "1000", "dcdc_output_v", "V", 2, "guess", "slow", lambda b: round(u16(b) / 100.0, 2))
_reg("7E6", "1402", "dcdc_target_v", "V", 2, "guess", "slow", lambda b: round(u16(b) / 1000.0, 2))
_reg("7E6", "110C", "charger_temp", "°C", 1, "guess", "slow", lambda b: u8(b) - 40)

# IBCM (720)
_reg("720", "1001", "aux_12v_ibcm_alt", "V", 1, "known", "slow", lambda b: round(u8(b) / 10.0, 1))
_reg("720", "11FF", "tpms", "psi/bar/°C", 8, "known", "slow", decode_tpms)
_reg("720", "1200", "pedal_park", "flags", 2, "known", "fast", lambda b: {"park": bool(u16(b) & 0x0010), "brake_pedal": bool(u16(b) & 0x0020)})
_reg("720", "1201", "doors", "flags", 1, "known", "fast", decode_doors)
_reg("720", "1207", "brake_pedal_switch", "bool", 2, "known", "fast", lambda b: bool(u16(b) & 0x8000))
_reg("720", "2100", "turn_signals", "flags", 1, "known", "turbo", lambda b: {"left": bool(b[0] & 0x80), "right": bool(b[0] & 0x08), "raw": b[0]})
_reg("720", "2101", "lights", "flags", 2, "known", "turbo", decode_lamps_2101)
_reg("720", "2102", "body_status_2102", "flags", 1, "guess", "turbo", lambda b: {"interior_light_cand": bool(b[0] & 0x02), "raw": b[0]})

# Doors (719 / 718), IPB (710), IC (72B), T-Box (72D)
_reg("719", "1203", "lock_state", "", 2, "known", "fast", decode_lock_state)
_reg("719", "1208", "windows_right", "%", 8, "known", "slow", decode_windows)
_reg("718", "1203", "lock_state_l", "", 2, "known", "fast", decode_lock_state)
_reg("718", "1208", "windows_left", "%", 8, "known", "slow", decode_windows)
_reg("710", "1101", "dynamics", "mixed", 10, "known", "fast", decode_ipb_dynamics)
_reg("72B", "1052", "pki_server_url", "", 50, "known", "once", decode_ascii, min_len=4)
_reg("72B", "1202", "cluster_clock_bcd", "datetime", 7, "known", "once", decode_bcd_clock)
_reg("72B", "2104", "cluster_clock_bcd_copy", "datetime", 7, "known", "once", decode_bcd_clock)
_reg("72D", "1014", "telematics_server_url", "", 50, "known", "once", decode_ascii, min_len=4)


# ---------------------------------------------------------------------------
# Read-Only Safety, ELM327 Planning & ISO-TP Reassembly
# ---------------------------------------------------------------------------
def assert_read_only(uds_hex: str) -> None:
    clean = re.sub(r"\s+", "", uds_hex).upper()
    if len(clean) < 2:
        raise ValueError(f"Empty/short UDS payload: {uds_hex}")
    sid = int(clean[:2], 16)
    if sid not in ALLOWED_UDS_SERVICES:
        raise PermissionError(f"Blocked by Read-Only policy: UDS service 0x{sid:02X} is forbidden.")


def iso_tp_frame_count(byte_len: int) -> int:
    return 1 if byte_len <= 7 else 1 + math.ceil((byte_len - 6) / 7)


def expected_response_length(tx: str, dids: Sequence[str]) -> int:
    tx_u = tx.upper()
    total = 1  # 0x62
    for d in dids:
        spec = DID_CATALOG.get((tx_u, d.upper()))
        total += 2 + (spec.byte_len if spec else 1)
    return total


def build_uds_read_command(tx: str, dids: Sequence[str], caf0: bool = False, frame_hint: bool = True) -> str:
    tx_u = tx.upper()
    ecu = ECU_MAP.get(tx_u)
    if not (1 <= len(dids) <= 3):
        raise ValueError("GAC Aion V ECUs accept 1 to 3 DIDs per UDS 0x22 request.")
    if ecu and not ecu.multi_did and len(dids) > 1:
        raise ValueError(f"{ecu.key} ({tx_u}) rejects multi-DID requests; query 1 DID at a time.")
    payload = "22" + "".join(d.upper() for d in dids)
    assert_read_only(payload)
    if caf0:
        payload = f"{len(payload) // 2:02X}" + payload
    frames = iso_tp_frame_count(expected_response_length(tx_u, dids))
    if frame_hint and frames <= 9:
        payload += f" {frames}"
    return payload


def elm327_init_sequence(caf0: bool = False) -> List[str]:
    return [
        "ATZ",
        "ATE0",
        "ATL0",
        "ATS0",
        "ATH1",
        "ATSP6",
        "ATCAF0" if caf0 else "ATCAF1",
        "ATAT1",
        "ATFCSH 7E2",
        "ATFCSD 30 00 00",
        "ATFCSM 1",
    ]


def select_ecu_sequence(tx: str, use_fc_override: bool = True) -> List[str]:
    ecu = ECU_MAP[tx.upper()]
    cmds = [f"ATSH {ecu.tx}", f"ATCRA {ecu.rx}"]
    if use_fc_override:
        cmds.append(f"ATFCSH {ecu.tx}")
    return cmds


def parse_elm_response(text: str, rx_id: Optional[str] = None) -> Dict[str, Any]:
    lines = [l.strip().lstrip(">").strip() for l in re.split(r"[\r\n]+", text) if l.strip()]
    buf: Optional[List[int]] = None
    total = 0
    next_seq = 1
    frames = 0
    err: Optional[str] = None
    rx_u = rx_id.upper() if rx_id else None

    for line in lines:
        up = line.upper()
        if up in ("OK",) or up.startswith("SEARCHING"):
            continue
        if any(e in up for e in ("NO DATA", "CAN ERROR", "BUS ERROR", "STOPPED", "ERR")):
            err = up
            continue
        compact = re.sub(r"\s+", "", up)
        if not re.fullmatch(r"[0-9A-F]+", compact) or len(compact) < 5:
            continue
        hdr = compact[:3]
        if rx_u and hdr != rx_u:
            continue
        raw = bytes.fromhex(compact[3:])
        frames += 1
        pci_type = raw[0] >> 4
        if pci_type == 0:
            ln = raw[0] & 0x0F
            data = raw[1 : 1 + ln]
            if len(data) >= 3 and data[0] == 0x7F and data[2] == 0x78:
                continue  # responsePending — keep reading next frames
            if data and data[0] == 0x7F:
                return {"ok": False, "nrc": data[2] if len(data) > 2 else None, "frames": frames, "payload": data}
            return {"ok": True, "payload": data, "frames": frames}
        elif pci_type == 1:
            total = ((raw[0] & 0x0F) << 8) | raw[1]
            buf = list(raw[2:])
            next_seq = 1
        elif pci_type == 2 and buf is not None:
            seq = raw[0] & 0x0F
            if seq != next_seq:
                err = f"ISO-TP sequence mismatch: got {seq}, expected {next_seq}"
            next_seq = (seq + 1) & 0x0F
            buf.extend(raw[1:])
            if len(buf) >= total:
                return {"ok": True, "payload": bytes(buf[:total]), "frames": frames}
    return {"ok": False, "error": err or "no response", "frames": frames}


def parse_uds_62_payload(tx: str, payload: bytes) -> Dict[str, Any]:
    if not payload or payload[0] != 0x62:
        raise ValueError(f"Expected UDS 0x62 positive reply, got {payload.hex().upper()}")
    tx_u = tx.upper()
    idx = 1
    out: Dict[str, Any] = {}
    while idx + 2 <= len(payload):
        did = payload[idx : idx + 2].hex().upper()
        idx += 2
        spec = DID_CATALOG.get((tx_u, did))
        if not spec:
            break
        avail = min(spec.byte_len, len(payload) - idx)
        if avail < spec.min_len:
            break
        val = payload[idx : idx + avail]
        idx += avail
        out[spec.name] = spec.decoder(val)
    return out


# ---------------------------------------------------------------------------
# Self-Test with Verified Real Captures from aionv.app
# ---------------------------------------------------------------------------
def run_selftest() -> None:
    # 1. Safety checks
    for forbidden in ("2E111A00", "2F120101", "3101FF00", "2701", "1101", "14FFFFFF"):
        try:
            assert_read_only(forbidden)
            raise AssertionError(f"Should have blocked {forbidden}")
        except PermissionError:
            pass

    # 2. Optimal batch command checks
    assert build_uds_read_command("720", ["2100", "2101", "2102"]) == "22210021012102 2"
    assert expected_response_length("720", ["2100", "2101", "2102"]) == 11
    assert iso_tp_frame_count(11) == 2
    assert build_uds_read_command("7E2", ["111A"]) == "22111A 1"
    assert build_uds_read_command("7E2", ["1151"], frame_hint=True) == "221151"  # 44 frames > 9

    # 3. Single-frame & Multi-frame ISO-TP + Multi-DID decode tests (real hex vectors)
    r1 = parse_elm_response("7EA0562111A0057AAAA", "7EA")
    assert r1["ok"] and parse_uds_62_payload("7E2", r1["payload"]) == {"soc_display": 87}

    r_pend = parse_elm_response("7EA037F2278\r7EA056210022710", "7EA")
    assert r_pend["ok"] and parse_uds_62_payload("7E2", r_pend["payload"]) == {"soh": 100.0}

    r_lights = parse_elm_response("7A0 10 0B 62 21 00 80 21 01\r7A0 21 28 13 21 02 82 AA AA", "7A0")
    assert r_lights["ok"]
    decoded_lights = parse_uds_62_payload("720", r_lights["payload"])
    assert decoded_lights["turn_signals"] == {"left": True, "right": False, "raw": 0x80}
    assert decoded_lights["lights"]["brake_light"] is True
    assert decoded_lights["lights"]["reverse_light"] is False
    assert decoded_lights["lights"]["raw_hex"] == "2813"
    assert decoded_lights["body_status_2102"] == {"interior_light_cand": True, "raw": 0x82}

    # 4. BCD Clock & Binary Clock & 12V & Dynamics
    clk_bcd = parse_uds_62_payload("72B", bytes.fromhex("62 12 02 20 26 10 11 18 33 34"))
    assert clk_bcd["cluster_clock_bcd"] == "2026-10-11 18:33:34"
    clk_vcu = parse_uds_62_payload("7E3", bytes.fromhex("62 05 11 1A 0A 0B 15 04 0F"))
    assert clk_vcu["vcu_clock_utc8"] == "2026-10-11 21:04:15"
    dyn = parse_uds_62_payload("710", bytes.fromhex("62 11 01 FF FF 03 1C 03 1E 03 D6 0A DA"))["dynamics"]
    assert dyn == {"steering_angle_deg": None, "lateral_accel_ms2": 0.1, "longitudinal_accel_ms2": 0.05, "yaw_rate_degs": 0.1, "brake_pressure_raw": 0.0}

    print(
        json.dumps(
            {
                "status": "PASS",
                "ecus_mapped": len(ECU_MAP),
                "dids_registered": len(DID_CATALOG),
                "sample_turbo_lights_cmd": build_uds_read_command("720", ["2100", "2101", "2102"]),
            },
            indent=2,
        )
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="GAC Aion V 602 UDS ECU Comms Helper")
    parser.add_argument("--selftest", action="store_true", help="Run protocol & decoding self-tests")
    parser.add_argument("--ecu", help="Print selection & DID catalog for a TX CAN ID (e.g. 720, 7E2)")
    args = parser.parse_args()

    if args.selftest:
        run_selftest()
    elif args.ecu:
        tx = args.ecu.upper()
        if tx not in ECU_MAP:
            sys.exit(f"Unknown ECU TX: {tx}")
        ecu = ECU_MAP[tx]
        dids = [d for d in DID_CATALOG.values() if d.tx == tx]
        print(json.dumps({
            "ecu": ecu.__dict__,
            "select_cmds": select_ecu_sequence(tx),
            "dids": [{"did": d.did, "name": d.name, "unit": d.unit, "len": d.byte_len, "conf": d.conf, "tier": d.tier} for d in dids],
        }, indent=2, ensure_ascii=False))
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
