---
name: aion-v-ecu-comms
description: >-
  Comprehensive protocol runbook and UDS decoder for communicating efficiently
  and accurately with all 22 electronic control units (ECUs) of the GAC Aion V
  (2024+ / 602 LFP) over OBD2 CAN bus, ELM327/STN (vLinker FD+), Web Bluetooth,
  or ESP32. Use this skill whenever reading/adding ECU DIDs, building OBD2
  polling loops, optimizing CAN frame latency, decoding raw hex frames,
  implementing vehicle lighting/body/battery telemetry, or validating Read-Only
  diagnostic safety.
---

# GAC Aion V 602 — All-ECU Communication & Telemetry Skill

Use this skill to communicate reliably, safely, and at minimum latency with every readable ECU on the GAC Aion V over the diagnostic CAN bus (`IP25`).

## 1. Safety & Transport Rules (Mandatory)
1. **Strict Read-Only Policy**: Transmit ONLY UDS `0x22` (ReadDataByIdentifier), `0x19` (ReadDTCInformation), and `0x3E` (TesterPresent). NEVER send `0x2E`, `0x2F`, `0x31`, `0x27`, `0x11`, `0x14`, or flashing services (`0x34`–`0x37`).
2. **Physical Interface**: Use standard OBD-II socket `IP25` (`Pin 6` CAN-H, `Pin 14` CAN-L, `Pins 4/5` GND, `Pin 16` +12 V). Never probe `OBD-TEST` (`IP68`).
3. **Bus Protocol**: `ISO 15765-4 CAN` (`11-bit IDs`, `500 kbit/s`, ELM327 `ATSP6`). Standard OBD-II Mode `01`/`09` is unsupported; all data lives behind UDS `0x22` in Default Session (`10 01`).
4. **Physical Addressing Only**: Target one ECU per exchange (`ATSH <TX>` + `ATCRA <RX>`). Do not broadcast `7DF` during polling. Look up all 22 ECUs in [ecu-map.md](./references/ecu-map.md).

## 2. Maximum-Throughput ELM327 / STN (`vLinker FD+`) Procedure

### Step A — One-Time Adapter Initialization
```text
ATZ        # Reset
ATE0       # Echo off
ATL0       # Linefeeds off
ATS0       # Spaces off (smaller frames, faster BLE UART)
ATH1       # Headers ON (required to filter multi-ECU traffic & detect 7Fxx78)
ATSP6      # ISO 15765-4 CAN 11/500
ATCAF1     # Auto ISO-TP framing (switch to ATCAF0 + manual PCI length on clones answering NO DATA)
ATAT1      # Adaptive timing ON
ATFCSH 7E2 # Enable programmable Flow Control header
ATFCSD 30 00 00
ATFCSM 1
```

### Step B — Switching ECUs (Respect the Two Reply Offset Groups)
- **`+0x08` Group** (`7E2`–`7E6`, `760`, `765` → TX + `0x08`)
- **`+0x80` Group** (`705`–`74F` → TX + `0x80`, e.g., `720` → `7A0`, `710` → `790`)

Whenever selecting an ECU `TX`:
```text
ATSH <TX>
ATCRA <RX>
ATFCSH <TX>    # CRITICAL for multi-frame replies on +0x80 modules (720, 710, 718, 719, 72B)
```
Without updating `ATFCSH <TX>`, multi-frame responses from `720`/`710`/`718`/`719` stall after First Frame.

### Step C — Latency Optimization Techniques
1. **Append Expected CAN Frame Count (`1`–`9`)**:
   - Compute `frames = 1` if `reply_bytes <= 7`, else `1 + ceil((reply_bytes - 6) / 7)`.
   - Append trailing digit (e.g., `22210021012102 2`) so ELM327/STN exits immediately on the final frame instead of waiting for its timeout (~**76–96 ms → 17–24 ms** per read).
2. **Batch up to 3 DIDs per `0x22` Command**:
   - Most ECUs accept 3 DIDs in one request (saving 2 ECU selections + 2 round-trips).
   - **Exception**: `710` (Bosch IPB) refuses multi-DID — always send 1 DID at a time.
   - **High-Speed Lighting Batch on `720` (IBCM)**: Request `22 2100 2101 2102 2` (11 reply bytes = 2 CAN frames total) to capture turn signals, brake lights, reverse lights, and body/lamp status bytes atomically in a single exchange. For maximum real-time lighting frame rate (~25–45 Hz), lock `ATSH 720` / `ATCRA 7A0` / `ATFCSH 720` and loop `22210021012102 2` without switching ECUs.
3. **Avoid `705`**: Answers NRC `0x78` (`responsePending`, ~3 s stall) to most queries — exclude from live loops.
4. **Never Confuse `known` vs `guess` Formulas**: Always check confidence metadata in [did-catalog.md](./references/did-catalog.md) (for example, headlights bits in `720:2101` beyond brake `0x0800` and reverse `0x0100` are unconfirmed until guided-tested on the target vehicle).

## 3. All Readable Values & Formulas
- Consult [did-catalog.md](./references/did-catalog.md) for all **71 Known DIDs**, key **Guess DIDs**, `1000` (12 V supply across ECUs), `F187`–`F197` identity items, byte lengths, endianness (big-endian), signed/offset scaling, and bitmasks.

## 4. Verification & Reference Tool
Run the bundled validation tool after any decoder or poll-plan change to verify safety rules, frame counts, ISO-TP reassembly, and exact decoding against captured vehicle hex vectors:
```bash
python .agents/skills/aion-v-ecu-comms/scripts/ecu_comms_tool.py --selftest
```
Inspect a specific ECU's commands and DIDs (e.g., `720` IBCM or `7E2` BMS):
```bash
python .agents/skills/aion-v-ecu-comms/scripts/ecu_comms_tool.py --ecu 720
```
