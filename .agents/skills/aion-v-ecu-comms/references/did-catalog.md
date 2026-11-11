# GAC Aion V 602 — Complete UDS (`0x22`) DID Catalog & Decoding Formulas

All multi-byte integer values are **Big-Endian (MSB first)**. Positive response format: `62 <DID_HI> <DID_LO> <DATA...>`.

> **Confidence Labels**
> - **KNOWN**: Verified via dashboard cross-check, guided vehicle testing, or correlation analysis (`r >= 0.99`).
> - **GUESS**: High-probability behavioral or correlation match from real drive logs; mark/label clearly in UIs until guided-tested on target trim.

---

## 1. BMS — Battery Management System (`7E2` → `7EA`)

### Known DIDs (29 items)

| DID | Len | Parameter | Formula / Bitmask | Real Capture Example | Tier |
| :---: | :---: | :--- | :--- | :--- | :---: |
| `0300` | 37 | Battery pack code | ASCII text | *(pack barcode string)* | Once |
| `1000` | 1 | BMS 12 V supply voltage | `u8 / 10.0` (V) | `84` → `13.2 V` | Slow |
| `1002` | 2 | Battery State of Health (SoH) | `u16 / 100.0` (%) | `27 10` → `100.00 %` | Slow |
| `1004` | 2 | Free-running 50 Hz counter | `u16` (wraps 65535) | `71 0F` → `28943` | Unused |
| `1101` | 1 | Highest-voltage cell # | `u8` (1–112) | `6C` → `108` | Slow |
| `1103` | 1 | Lowest-voltage cell # | `u8` (1–112) | `29` → `41` | Slow |
| `1105` | 2 | Pack voltage (copy) | `u16 / 10.0` (V) | `0E 8D` → `372.5 V` | Slow |
| `1106` | 2 | Sum of all cell voltages | `u16 / 10.0` (V) | `0E 8F` → `372.7 V` | Slow |
| `1114` | 1 | Average cell charge (%) | `u8` (%) | `46` → `70 %` | Slow |
| `1115` | 1 | Hottest battery temp sensor # | `u8` (1–24) | `0C` → `12` | Slow |
| `1116` | 1 | Coolest battery temp sensor # | `u8` (1–24) | `03` → `3` | Slow |
| `111A` | 2 | Display SoC (%) | `u16` (%) | `00 57` → `87 %` | Slow |
| `1136` | 1 | Charge plug detect voltage (CC2) | `u8 / 10.0` (V) | `76` → `11.8 V` | Slow |
| `114D` | 3 | Lifetime energy charged (CEC) | `u24 / 10.0` (kWh) | `00 05 0E` → `129.4 kWh` | Slow |
| `1150` | 54 | Battery temps array (24 used) | First 24 bytes: `b[i] - 40` (°C); rest `0x28` pad | `45 45 46 ...` → `29, 29, 30 °C` | Slow |
| `1151` | 300 | Cell voltages array (112 used) | First 224 bytes (112×`u16`): `u16 - 5000` (mV); rest `0x1388` pad | `20 87 20 88 ...` → `3327, 3328 mV` | Slow |
| `1180` | 32 | BMU board temps array (16 used) | First 16 bytes: `b[i] - 40` (°C); rest `0x28` pad | `4E 4F ...` → `38, 39 °C` | Slow |
| `1181` | 1 | BMU temperature max | `u8 - 40` (°C) | `4F` → `39 °C` | Slow |
| `1182` | 1 | BMU temperature min | `u8 - 40` (°C) | `4D` → `37 °C` | Slow |
| `1183` | 1 | BMU temperature avg | `u8 - 40` (°C) | `4E` → `38 °C` | Slow |
| `1184` | 1 | Hottest BMU module controller # | `u8` | `0D` → `13` | Slow |
| `1189` | 3 | Lifetime energy discharged (CED) | `u24 / 10.0` (kWh) | `00 02 91` → `65.7 kWh` | Slow |
| `1401` | 2 | Battery pack voltage | `u16 / 10.0` (V) | `0E 8D` → `372.5 V` | **Fast** |
| `141E` | 2 | Display SoC (copy) | `u16` (%) | `00 57` → `87 %` | Slow |
| `2020` | 2 | Max cell voltage | `u16 - 5000` (mV) | `20 89` → `3329 mV` | Slow |
| `2022` | 2 | Min cell voltage | `u16 - 5000` (mV) | `20 86` → `3326 mV` | Slow |
| `2023` | 2 | Avg cell voltage | `u16 - 5000` (mV) | `20 87` → `3327 mV` | Slow |
| `2024` | 1 | Max battery temperature | `u8 - 40` (°C) | `46` → `30 °C` | Slow |
| `2026` | 1 | Min battery temperature | `u8 - 40` (°C) | `45` → `29 °C` | Slow |

### Key BMS Guess DIDs
- `7E2:1404` (`len=2`): Pack current approx. — `(u16 - 8000) / 10.0` (A); `8000 = 0 A`, `>8000 = discharging`, `r = 0.94` vs torque (`1F 4E` → `1.4 A`). **Fast**.
- `7E2:111B` (`len=2`): Internal BMS SoC (`u16` %, consistently ~1% below display `111A`).
- `7E2:111C` (`len=2`): Display SoC copy (`u16` %).
- `7E2:111E` (`len=2`): Charge limit? (`00 64` → `100 %`).
- `7E2:1204` (`len=2`): Drive/ignition cycle counter (`+1` per drive).

---

## 2. VCU — Vehicle Control Unit (`7E3` → `7EB`)

### Known DIDs (13 items)

| DID | Len | Parameter | Formula / Mapping | Real Capture Example | Tier |
| :---: | :---: | :--- | :--- | :--- | :---: |
| `0511` | 6 | Vehicle clock (UTC+8 China time) | Raw decimal bytes `[YY, MM, DD, hh, mm, ss]` | `1A 0A 0B 15 04 0F` → `2026-10-11 21:04:15` | Once |
| `1000` | 1 | VCU 12 V supply | `u8 / 10.0` (V) | `87` → `13.5 V` | Slow |
| `1442` | 2 | Pack voltage (VCU copy) | `u16 / 10.0` (V) | `0E 88` → `372.0 V` | Slow |
| `144D` | 2 | Drive motor temperature 1 | `u16 - 40` (°C) | `00 48` → `32 °C` | Slow |
| `144E` | 2 | Drive motor temperature 2 | `u16 - 40` (°C) | `00 49` → `33 °C` | Slow |
| `146B` | 1 | High-resolution SoC (0.5% step) | `u8 / 2.0` (%) | `AE` → `87.0 %` | **Fast** |
| `1477` | 2 | Wheel speed — Front Left | `u16 / 200.0` (km/h) | `00 00` → `0.0 km/h` | **Fast** |
| `1478` | 2 | Wheel speed — Front Right | `u16 / 200.0` (km/h) | `00 00` → `0.0 km/h` | **Fast** |
| `1479` | 2 | Wheel speed — Rear Left | `u16 / 200.0` (km/h) | `00 00` → `0.0 km/h` | **Fast** |
| `147A` | 2 | Wheel speed — Rear Right | `u16 / 200.0` (km/h) | `00 00` → `0.0 km/h` | **Fast** |
| `2103` | 1 | Gear selector | `6='P'`, `1='D'`, `5='R'`, `4='N'` | `06` → `P` | **Fast** |
| `2313` | 2 | Discharge power limit | `u16` or `u16 / 100.0` (kW; >1000 → `/100`) | `00 C9` → `201 kW` | Slow |
| `2314` | 2 | Charge / regen power limit | `u16` or `u16 / 100.0` (kW) | `00 87` → `135 kW` | Slow |

### Key VCU Guess DIDs
- `7E3:2104` (`len=1`): A/C request (`02` = Off, `05`/`06` = On in stationary test; `09`–`0C` observed while driving).
- `7E3:1101` (`len=2`): Brake value VCU (`u16 / 125`; always multiple of 125; `0` released, `12750–33250` pressed).
- `7E3:1244` (`len=1`): Brake pedal VCU flag (`00` / `01`).
- `7E3:1443` (`len=2`): Longitudinal accel VCU (`(u16 - 10000) / 1000.0` m/s²).
- `7E3:1444` (`len=2`): 12 V target voltage (`u16 / 1000.0` V; `36 4C` → `13.90 V`).
- `7E3:1420` (`len=2`, `u16 - 24000`) & `7E3:144C` (`len=2`, `u16 - 32767`): Motor speed VCU copies.
- `7E3:144A` / `144B` (`len=2`): Torque request (`u16 - 1023`).
- `7E3:1483` (`len=1`): In P (`01` in P, `00` in D/R). `1300` (`100` P / `66` D,R), `130C` (`0` P / `3` D,R).

---

## 3. MCU — Motor Controller (`7E4` → `7EC`)

### Known DIDs (5 items)

| DID | Len | Parameter | Formula | Example | Tier |
| :---: | :---: | :--- | :--- | :--- | :---: |
| `0511` | 6 | Vehicle clock (copy, UTC+8) | Raw decimal bytes `[YY, MM, DD, hh, mm, ss]` | `1A 0A 0B 15 00 0C` → `2026-10-11 21:00:12` | Once |
| `1000` | 1 | MCU 12 V supply | `u8 / 10.0` (V) | `89` → `13.7 V` | Slow |
| `1100` | 2 | Inverter DC-Bus voltage | `u16` (V) | `01 74` → `372 V` | **Fast** |
| `1104` | 1 | Motor / inverter temperature | `u8 - 40` (°C) | `49` → `33 °C` (`r=1.0` vs `7E3:144E`) | Slow |
| `1110` | 2 | Motor speed (signed) | `u16 - 32767` (rpm; `<0` reverse) | `7F FF` → `0 rpm` | **Fast** |

### Key MCU Guess DIDs
- `7E4:1408` & `2308` (`len=2`): Motor torque estimate (`u16 - 1100`; `1100` at rest, `>1100` drive, `<1100` regen; unit/scale unconfirmed). **Fast**.
- `7E4:110D` (`len=1`): Drive enabled flag (`00` parked, `01` driving).
- `7E4:230A` (`len=2`): Motor controller state (`3` standby, `4` running).
- `7E4:1108` / `1109` (`len=1`): Drive unit temps (`u8 - 40` °C).

---

## 4. CCU — Charger & DC-DC Converter (`7E6` → `7EE`)
*(All CCU telemetry items in `aionv.app` are currently classified as `guess` with high confidence from live reads:)*

| DID | Conf | Len | Parameter | Formula | Example | Tier |
| :---: | :---: | :---: | :--- | :--- | :--- | :---: |
| `1000` | Guess | 2 | DC-DC 12 V output voltage | `u16 / 100.0` (V) | `05 44` → `13.48 V` | Slow |
| `1402` | Guess | 2 | DC-DC 12 V target voltage | `u16 / 1000.0` (V) | `37 DC` → `14.30 V` | Slow |
| `110C` | Guess | 1 | Charger / DC-DC temp (same as `1111`) | `u8 - 40` (°C) | `45` → `29 °C` | Slow |
| `1109` | Guess | 2 | DC-DC current candidate 1 | `u16` (A?) | `00 05` → `5 A?` | Slow |
| `110B` | Guess | 2 | DC-DC current candidate 2 | `u16` (A?; dropped 43→33 in A/C test) | `00 1A` → `26 A?` | Slow |

---

## 5. IBCM — Continental Body Control Module (`720` → `7A0`)

### Known DIDs (8 items)

| DID | Len | Parameter | Formula / Bitmasks | Example | Tier |
| :---: | :---: | :--- | :--- | :--- | :---: |
| `1000` | 1 | IBCM 12 V supply | `u8 / 10.0` (V) | `86` → `13.4 V` | Slow |
| `1001` | 1 | IBCM 12 V supply (copy) | `u8 / 10.0` (V) | `86` → `13.4 V` | Slow |
| `11FF` | 8 | TPMS 4 wheels (updates while driving) | 4 pairs `(P, T)`: `P / 5.0` = psi (`psi / 14.5038` = bar), `T - 50` = °C *(wheel order assumed FL, FR, RL, RR)* | `B2 51 C1 4D B1 57 AF 57` → `35.6 psi/31°C, ...` | Slow |
| `1200` | 2 | Body status bits | `u16 & 0x0010` = Gear P; `u16 & 0x0020` = Brake pedal pressed (`r=1.0`) | `00 10` → In P | **Fast** |
| `1201` | 1 | Doors & boot open bitmask (RHD) | `0x80`=FR(Driver), `0x40`=FL, `0x20`=RL, `0x10`=RR, `0x08`=Boot | `80` → FR open | **Fast** |
| `1207` | 2 | Brake pedal switch | `u16 & 0x8000` = Brake pedal pressed (`r=1.0` with `1200`) | `80 04` → Pressed | **Fast** |
| `2100` | 1 | Turn Indicators | `b[0] & 0x80` = Left indicator; `b[0] & 0x08` = Right indicator | `80` Left, `08` Right, `88` Hazard | **Ultra-Fast** |
| `2101` | 2 | Lamp outputs (Brake, Reverse + unconfirmed lamps) | `u16 & 0x0800` = Brake light ON; `u16 & 0x0100` = Reverse light ON. Resting: `0x3010`; Driving common: `0x2013`, `0x2813`, max `0xB010`. Remaining bits (`0x0001`, `0x0002`, `0x0010`, `0x1000`, `0x2000`, `0x8000`) NOT yet confirmed for headlights/DRL/fog! | `28 13` → Brake ON; `21 13` → Reverse ON | **Ultra-Fast** |

### IBCM Guess DIDs & Lighting Research Notes
- **`720:2102`** (`len=1`): Body/lamp status (`80`, `82`, `84`, `88` common). Bit `0x02` toggles on unlock/door open (interior light candidate). Batchable with `2100` & `2101` in ZERO extra CAN frames (`22 2100 2101 2102 2` = 11 bytes = 2 CAN frames!).
- **`720:2E00`** (`len=4`): Multi-flag body status (`Byte 3 & 0x40` = all closed, `Byte 1 & 0x01` = left indicator, `Byte 2 & 0x20` = reverse). Copied in `1204`, `2108`, `2109`, `210A`.
- **`720:210E`** (`len=2`): `0x2004` in P, `0x2204` in D/R, bit `0x0400` switches on door open/close.
- **`720:0510`** (`len=132`): Lock/unlock history (11-byte records: type + `YY MM DD hh mm ss` + 4 bytes).
- **Important Headlight Accuracy Note**: The public `aionv.app` dataset (25% keyspace scanned on `720`) has NOT yet published a guided test confirming which bit corresponds to **Headlights (Low Beam / High Beam / DRL)**. Suspects live inside the unconfirmed bits of `720:2101` (`0x0001`, `0x0002`, `0x0010`, `0x1000`, `0x2000`, `0x8000`), `720:2102`, `720:1202` (`30`/`3C`), or unscanned `3000–EFFF` DIDs. **Never hardcode an unverified headlight bit as "confirmed"** — expose the live bitmask inspector / user-learn probe on `720:2101` & `720:2102`.

---

## 6. Chassis, Doors, Cluster & Support ECUs

### IPB — Bosch Brakes & Stability (`710` → `790`, **Single-DID ONLY!**)
- **`710:1101`** *(KNOWN, len=10, 2 frames)*:
  - Bytes `[0:2]`: Steering wheel angle = `(15610 - u16) * 0.1` deg (`+` = Left, `0xFFFF` parked)
  - Bytes `[2:4]`: Lateral G accel = `(u16 - 792) * 0.025` m/s² (`+` = Left)
  - Bytes `[4:6]`: Longitudinal G accel = `(u16 - 796) * 0.025` m/s² (includes gravity)
  - Bytes `[6:8]`: Yaw rate = `(u16 - 981) * 0.1` °/s (`+` = Turning left)
  - Bytes `[8:10]`: Hydraulic brake pressure = `max(0, u16 - 2778)` (0 during pure regen, rises `<10 km/h` and hold)
- `710:1205` *(GUESS, len=3)*: Brake held flag (`u24 & 0x400000` active while brake held).
- `710:1104` *(GUESS, len=8)*: Four `u16` brake temperatures candidate.

### Door Modules (`719` → `799` RHD Driver, `718` → `798` Left)
- **`719:1000` / `718:1000`** *(KNOWN, len=1)*: 12 V supply (`u8 / 10.0` V).
- **`719:1203` / `718:1203`** *(KNOWN, len=2)*: Central lock state (`0xA800` = Locked, `0x9400` = Unlocked).
- **`719:1208` / `718:1208`** *(KNOWN, len=8, 2 frames)*: Windows % & motor state (`b[1] / 2.0` = front %, `b[2]` motor `0` stop/`1` up/`2` down; `b[5] / 2.0` = rear %, `b[6]` rear motor). Range `0x0100` closed → `0x03C8` 100% open.
- `718:1204` *(GUESS, len=1)*: Left mirror/indicator flags (`0x10` left indicator).

### Cluster, T-Box, Liftgate, Airbag, Gateway (`+0x80` group)
- **`72B:1000`** *(KNOWN, len=1)*: Cluster 12 V (`u8 / 10.0` V).
- **`72B:1202`** & **`2104`** *(KNOWN, len=7, 2 frames)*: Cluster local time BCD `[YY, YY, MM, DD, hh, mm, ss]` (`20 26 10 11 18 33 34` → `2026-10-11 18:33:34`).
- **`72B:1052`** *(KNOWN, len=50)*: PKI certificate server URL (`aion-sea-pub-pki-cms.aionicv.com`).
- **`72D:1000`** *(KNOWN, len=1)*: T-Box 12 V (`u8 / 10.0` V).
- **`72D:1014`** *(KNOWN, len=50)*: Telematics MQTT server URL (`aion-sea-mqtt-public-access.aionicv.com`).
- **`724:1000`** *(KNOWN, len=1)*: Power liftgate 12 V (`u8 / 10.0` V).
- **`734:1000`** *(KNOWN, len=1)*: Airbag/seatbelt? 12 V (`u8 / 10.0` V). *(Note: `1FC7`, `1FC9`, `1FD2` change periodically — unconfirmed).*
- **`74F:1000`** *(KNOWN, len=1)*: Gateway 12 V (`u8 / 10.0` V).
- **`765:1000`** *(UNCONFIRMED, len=1)*: Steering switches MFS 12 V candidate (`0x8D` → `14.1 V`).
