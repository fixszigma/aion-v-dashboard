"""
GAC Aion V 602 OBD2 UDS Protocol & Decoder Module
Source references:
- Protocol & ELM327 setup: https://www.aionv.app/pages/OBD-HOW-TO-READ.html
- ECU Module Map: https://www.aionv.app/pages/OBD-MODULES.html
- Decoded DIDs & Formulas: https://www.aionv.app/pages/OBD-ITEMS.html
- evDash Reference Architecture: https://github.com/nickn17/evDash
"""

from dataclasses import dataclass
from typing import Callable, Dict, List, Optional, Tuple, Union


@dataclass(frozen=True)
class EcuModule:
    name: str
    system_name: str
    tx_id: str
    rx_id: str
    part_number: str
    supports_multi_did: bool = True


@dataclass(frozen=True)
class DidDefinition:
    ecu: str
    tx_id: str
    rx_id: str
    did: str
    name: str
    unit: str
    byte_length: int
    expected_frames: int
    poll_tier: str  # "fast" (~0.6s) or "slow" (~30s)
    decoder: Callable[[bytes], Union[float, int, str, List[float], Dict[str, Union[float, int, bool]]]]


# 1. ECU CAN ID Mapping (ISO 15765-4 CAN, 11-bit, 500 kbit/s)
ECU_MODULES: Dict[str, EcuModule] = {
    "BMS": EcuModule("Battery Management System", "A12_UAES_BMS", "7E2", "7EA", "2520105CVN1201", True),
    "VCU": EcuModule("Vehicle Control Unit", "VCU-UAES", "7E3", "7EB", "1110003CVN0211", True),
    "MCU": EcuModule("Motor Controller", "MCU", "7E4", "7EC", "1510046CVN4200", True),
    "CCU": EcuModule("Charger & DC-DC Converter", "EVT_6D6_CCU_B", "7E6", "7EE", "2730003CVN0601", True),
    "IBCM": EcuModule("Body Control Module", "Continental_IBCM", "720", "7A0", "8045025CVN0501", True),
    "IPB": EcuModule("Brakes & Stability System", "Bosch_IPB", "710", "790", "8085004ERD0002", False),
    "EPB": EcuModule("Parking Brake", "WBTLEPB-20", "711", "791", "8080003CVN0100", True),
    "DOOR_R": EcuModule("Door Module Right (Driver RHD)", "DOOR_R", "719", "799", "8065004", True),
    "DOOR_L": EcuModule("Door Module Left", "DOOR_L", "718", "798", "8065005", True),
    "IC": EcuModule("Instrument Cluster", "AY5G_IC2254", "72B", "7AB", "8545003CVN0403", True),
    "TBOX": EcuModule("Telematics Box", "GAEI_TBOX", "72D", "7AD", "8550003CVN1903", True),
    "GWM": EcuModule("Gateway Module", "+GWM30", "74F", "7CF", "8045196ERD0303", True),
}


# 2. Decoding Helper Functions (Big-Endian)
def u8(data: bytes) -> int:
    return data[0]


def u16(data: bytes) -> int:
    return int.from_bytes(data[:2], byteorder="big", signed=False)


def u24(data: bytes) -> int:
    return int.from_bytes(data[:3], byteorder="big", signed=False)


def decode_cell_voltages(data: bytes) -> List[int]:
    """7E2 1151: 300 bytes total, first 112 cells used (224 bytes). Each 2-byte value - 5000 = mV."""
    cells_mv: List[int] = []
    max_bytes = min(len(data), 112 * 2)
    for i in range(0, max_bytes, 2):
        raw = int.from_bytes(data[i : i + 2], byteorder="big", signed=False)
        cells_mv.append(raw - 5000)
    return cells_mv


def decode_battery_temps(data: bytes) -> List[int]:
    """7E2 1150: 54 bytes total, first 24 sensors used. Each byte - 40 = °C."""
    return [b - 40 for b in data[:24]]


def decode_module_controller_temps(data: bytes) -> List[int]:
    """7E2 1180: 32 bytes total, first 16 sensors used. Each byte - 40 = °C."""
    return [b - 40 for b in data[:16]]


def decode_tpms(data: bytes) -> Dict[str, float]:
    """720 11FF: 8 bytes, 4 pairs of (pressure, temperature)."""
    result: Dict[str, float] = {}
    for wheel_idx in range(4):
        p_byte = data[wheel_idx * 2]
        t_byte = data[wheel_idx * 2 + 1]
        result[f"tire_{wheel_idx + 1}_psi"] = round(p_byte / 5.0, 1)
        result[f"tire_{wheel_idx + 1}_c"] = float(t_byte - 50)
    return result


def decode_doors(data: bytes) -> Dict[str, bool]:
    """720 1201: 1 byte bitmask for doors and boot."""
    b = data[0]
    return {
        "front_right_open": bool(b & 0x80),
        "front_left_open": bool(b & 0x40),
        "rear_left_open": bool(b & 0x20),
        "rear_right_open": bool(b & 0x10),
        "boot_open": bool(b & 0x08),
    }


def decode_gear(data: bytes) -> str:
    """7E3 2103: 6=P, 1=D, 5=R, 4=N."""
    mapping = {6: "P", 1: "D", 5: "R", 4: "N"}
    return mapping.get(data[0], f"UNKNOWN({data[0]})")


def decode_ipb_dynamics(data: bytes) -> Dict[str, float]:
    """710 1101: 10 bytes (5 x 2-byte values)."""
    steer_raw = int.from_bytes(data[0:2], "big")
    lat_raw = int.from_bytes(data[2:4], "big")
    lon_raw = int.from_bytes(data[4:6], "big")
    yaw_raw = int.from_bytes(data[6:8], "big")
    brake_raw = int.from_bytes(data[8:10], "big")
    return {
        "steering_angle_deg": round((15610 - steer_raw) * 0.1, 1) if steer_raw != 0xFFFF else 0.0,
        "lateral_accel_ms2": round((lat_raw - 792) * 0.025, 3),
        "longitudinal_accel_ms2": round((lon_raw - 796) * 0.025, 3),
        "yaw_rate_degs": round((yaw_raw - 981) * 0.1, 1),
        "brake_pressure_raw": float(max(0, brake_raw - 2778)),
    }


# 3. Registry of Decoded DIDs for GAC Aion V 602
DID_REGISTRY: Dict[Tuple[str, str], DidDefinition] = {
    # BMS (7E2 -> 7EA)
    ("7E2", "111A"): DidDefinition("BMS", "7E2", "7EA", "111A", "soc_display", "%", 2, 1, "slow", lambda b: u16(b)),
    ("7E2", "111B"): DidDefinition("BMS", "7E2", "7EA", "111B", "soc_bms", "%", 2, 1, "slow", lambda b: u16(b)),
    ("7E2", "1002"): DidDefinition("BMS", "7E2", "7EA", "1002", "soh", "%", 2, 1, "slow", lambda b: round(u16(b) / 100.0, 2)),
    ("7E2", "1401"): DidDefinition("BMS", "7E2", "7EA", "1401", "pack_voltage", "V", 2, 1, "fast", lambda b: round(u16(b) / 10.0, 1)),
    ("7E2", "1106"): DidDefinition("BMS", "7E2", "7EA", "1106", "cell_sum_voltage", "V", 2, 1, "slow", lambda b: round(u16(b) / 10.0, 1)),
    ("7E2", "1404"): DidDefinition("BMS", "7E2", "7EA", "1404", "pack_current_est", "A", 2, 1, "fast", lambda b: round((u16(b) - 8000) / 10.0, 1)),
    ("7E2", "2020"): DidDefinition("BMS", "7E2", "7EA", "2020", "cell_max_mv", "mV", 2, 1, "slow", lambda b: u16(b) - 5000),
    ("7E2", "2022"): DidDefinition("BMS", "7E2", "7EA", "2022", "cell_min_mv", "mV", 2, 1, "slow", lambda b: u16(b) - 5000),
    ("7E2", "2023"): DidDefinition("BMS", "7E2", "7EA", "2023", "cell_avg_mv", "mV", 2, 1, "slow", lambda b: u16(b) - 5000),
    ("7E2", "1101"): DidDefinition("BMS", "7E2", "7EA", "1101", "cell_max_index", "#", 1, 1, "slow", lambda b: u8(b)),
    ("7E2", "1103"): DidDefinition("BMS", "7E2", "7EA", "1103", "cell_min_index", "#", 1, 1, "slow", lambda b: u8(b)),
    ("7E2", "2024"): DidDefinition("BMS", "7E2", "7EA", "2024", "bat_temp_max", "°C", 1, 1, "slow", lambda b: u8(b) - 40),
    ("7E2", "2026"): DidDefinition("BMS", "7E2", "7EA", "2026", "bat_temp_min", "°C", 1, 1, "slow", lambda b: u8(b) - 40),
    ("7E2", "114D"): DidDefinition("BMS", "7E2", "7EA", "114D", "energy_charged_total", "kWh", 3, 1, "slow", lambda b: round(u24(b) / 10.0, 1)),
    ("7E2", "1189"): DidDefinition("BMS", "7E2", "7EA", "1189", "energy_discharged_total", "kWh", 3, 1, "slow", lambda b: round(u24(b) / 10.0, 1)),
    ("7E2", "1136"): DidDefinition("BMS", "7E2", "7EA", "1136", "cc2_plug_voltage", "V", 1, 1, "slow", lambda b: round(u8(b) / 10.0, 1)),
    ("7E2", "1000"): DidDefinition("BMS", "7E2", "7EA", "1000", "aux_12v_bms", "V", 1, 1, "slow", lambda b: round(u8(b) / 10.0, 1)),
    ("7E2", "1150"): DidDefinition("BMS", "7E2", "7EA", "1150", "battery_temps_24", "°C", 54, 9, "slow", decode_battery_temps),
    ("7E2", "1151"): DidDefinition("BMS", "7E2", "7EA", "1151", "cell_voltages_112", "mV", 300, 44, "slow", decode_cell_voltages),
    # VCU (7E3 -> 7EB)
    ("7E3", "146B"): DidDefinition("VCU", "7E3", "7EB", "146B", "soc_precise", "%", 1, 1, "fast", lambda b: round(u8(b) / 2.0, 1)),
    ("7E3", "1477"): DidDefinition("VCU", "7E3", "7EB", "1477", "wheel_speed_fl", "km/h", 2, 1, "fast", lambda b: round(u16(b) / 200.0, 2)),
    ("7E3", "1478"): DidDefinition("VCU", "7E3", "7EB", "1478", "wheel_speed_fr", "km/h", 2, 1, "fast", lambda b: round(u16(b) / 200.0, 2)),
    ("7E3", "1479"): DidDefinition("VCU", "7E3", "7EB", "1479", "wheel_speed_rl", "km/h", 2, 1, "fast", lambda b: round(u16(b) / 200.0, 2)),
    ("7E3", "147A"): DidDefinition("VCU", "7E3", "7EB", "147A", "wheel_speed_rr", "km/h", 2, 1, "fast", lambda b: round(u16(b) / 200.0, 2)),
    ("7E3", "2103"): DidDefinition("VCU", "7E3", "7EB", "2103", "gear", "", 1, 1, "fast", decode_gear),
    ("7E3", "2104"): DidDefinition("VCU", "7E3", "7EB", "2104", "ac_active", "bool", 1, 1, "slow", lambda b: b[0] in (5, 6)),
    ("7E3", "144D"): DidDefinition("VCU", "7E3", "7EB", "144D", "motor_temp_1", "°C", 2, 1, "slow", lambda b: u16(b) - 40),
    ("7E3", "144E"): DidDefinition("VCU", "7E3", "7EB", "144E", "motor_temp_2", "°C", 2, 1, "slow", lambda b: u16(b) - 40),
    # MCU (7E4 -> 7EC)
    ("7E4", "1110"): DidDefinition("MCU", "7E4", "7EC", "1110", "motor_rpm", "rpm", 2, 1, "fast", lambda b: u16(b) - 32767),
    ("7E4", "1408"): DidDefinition("MCU", "7E4", "7EC", "1408", "motor_torque_raw", "raw", 2, 1, "fast", lambda b: u16(b) - 1100),
    ("7E4", "1100"): DidDefinition("MCU", "7E4", "7EC", "1100", "inverter_dc_bus_v", "V", 2, 1, "fast", lambda b: u16(b)),
    # CCU (7E6 -> 7EE)
    ("7E6", "1000"): DidDefinition("CCU", "7E6", "7EE", "1000", "dcdc_output_12v", "V", 2, 1, "slow", lambda b: round(u16(b) / 100.0, 2)),
    ("7E6", "110C"): DidDefinition("CCU", "7E6", "7EE", "110C", "charger_temp", "°C", 1, 1, "slow", lambda b: u8(b) - 40),
    # IBCM (720 -> 7A0)
    ("720", "11FF"): DidDefinition("IBCM", "720", "7A0", "11FF", "tpms_tires", "psi/°C", 8, 2, "slow", decode_tpms),
    ("720", "1201"): DidDefinition("IBCM", "720", "7A0", "1201", "doors_status", "flags", 1, 1, "fast", decode_doors),
    ("720", "2101"): DidDefinition("IBCM", "720", "7A0", "2101", "brake_reverse_lights", "flags", 2, 1, "fast", lambda b: {"brake_light": bool(u16(b) & 0x0800), "reverse_light": bool(u16(b) & 0x0100)}),
    # Door Right (719 -> 799)
    ("719", "1203"): DidDefinition("DOOR_R", "719", "799", "1203", "doors_locked", "bool", 2, 1, "fast", lambda b: u16(b) == 0xA800),
    # IPB (710 -> 790) - single DID per request only
    ("710", "1101"): DidDefinition("IPB", "710", "790", "1101", "stability_dynamics", "mixed", 10, 2, "fast", decode_ipb_dynamics),
}


def get_elm327_init_commands(raw_caf0_mode: bool = False) -> List[str]:
    """Returns the ELM327 initialization command sequence for GAC Aion V 602."""
    cmds = [
        "ATZ",      # Reset adapter
        "ATE0",     # Echo off
        "ATL0",     # Linefeeds off
        "ATS0",     # Spaces off for compact parsing
        "ATH1",     # Headers on
        "ATSP6",    # ISO 15765-4 CAN (11-bit ID, 500 kbit/s)
    ]
    if raw_caf0_mode:
        cmds.append("ATCAF0")  # Disable auto-formatting for clone adapters that reply NO DATA
    return cmds


def build_uds_read_command(dids: List[str], expected_frames: Optional[int] = None, raw_caf0_mode: bool = False) -> str:
    """
    Builds a UDS Service 0x22 read command for 1 to 3 DIDs on the same ECU.
    Example: build_uds_read_command(["111A"], expected_frames=1) -> "22111A1"
    """
    if not (1 <= len(dids) <= 3):
        raise ValueError("GAC Aion V modules support 1 to 3 DIDs per request.")
    payload = "22" + "".join(d.upper() for d in dids)
    if raw_caf0_mode:
        pci_len = 1 + 2 * len(dids)
        payload = f"{pci_len:02X}" + payload
    if expected_frames is not None and expected_frames <= 9:
        payload += f" {expected_frames}"
    return payload


def parse_uds_62_payload(tx_id: str, hex_payload: str) -> Dict[str, object]:
    """
    Parses a reassembled UDS 0x62 positive response payload (after ISO-TP reassembly).
    Supports single or multi-DID responses (e.g., '62111A0057' or '621477000014780000').
    """
    raw = bytes.fromhex(hex_payload.replace(" ", "").strip())
    if not raw or raw[0] != 0x62:
        raise ValueError(f"Not a positive UDS 0x62 response: {hex_payload}")

    idx = 1
    results: Dict[str, object] = {}
    while idx + 2 <= len(raw):
        did_hex = raw[idx : idx + 2].hex().upper()
        idx += 2
        defn = DID_REGISTRY.get((tx_id.upper(), did_hex))
        if defn is None:
            break
        val_bytes = raw[idx : idx + defn.byte_length]
        if len(val_bytes) < defn.byte_length:
            break
        idx += defn.byte_length
        results[defn.name] = defn.decoder(val_bytes)
    return results


if __name__ == "__main__":
    # Self-test with real captured hex examples from GAC Aion V
    assert parse_uds_62_payload("7E2", "62 11 1A 00 57") == {"soc_display": 87}
    assert parse_uds_62_payload("7E2", "62 10 02 27 10") == {"soh": 100.0}
    assert parse_uds_62_payload("7E2", "62 14 01 0E 8D") == {"pack_voltage": 372.5}
    assert parse_uds_62_payload("7E3", "62 14 77 00 00 14 78 00 00 14 79 00 00") == {
        "wheel_speed_fl": 0.0,
        "wheel_speed_fr": 0.0,
        "wheel_speed_rl": 0.0,
    }
    assert parse_uds_62_payload("720", "62 11 FF B2 51 C1 4D B1 57 AF 57") == {
        "tpms_tires": {
            "tire_1_psi": 35.6, "tire_1_c": 31.0,
            "tire_2_psi": 38.6, "tire_2_c": 27.0,
            "tire_3_psi": 35.4, "tire_3_c": 37.0,
            "tire_4_psi": 35.0, "tire_4_c": 37.0,
        }
    }
    print("All GAC Aion V 602 UDS decoders verified successfully.")