# GAC Aion V (2024+ / 602 LFP) — Complete 22-ECU Module Map

Reference source: Community reverse-engineering dataset ([aionv.app OBD-MODULES](https://www.aionv.app/pages/OBD-MODULES.html)).

## Physical Port & Bus Parameters
- **Diagnostic Socket**: Normal OBD-II port (`IP25`) under the driver's dash.
  - **Pin 6**: CAN-H (Diagnostic CAN)
  - **Pin 14**: CAN-L (Diagnostic CAN)
  - **Pins 4, 5**: Chassis / Signal Ground
  - **Pin 16**: Permanent `+12 V` battery supply
  - *(Pins 3, 8, 11, 12, 13 carry automotive Ethernet + wake-up; unused by ELM327 CAN adapters.)*
- **WARNING — Do NOT use `OBD-TEST` (`IP68`)**: That port sits behind the gateway directly on safety-critical sub-buses (airbags, brakes) with no gateway filtering.
- **Bus Protocol**: `ISO 15765-4 CAN` (11-bit identifiers, `500 kbit/s`) — ELM327 `ATSP6`.
- **Addressing**: Physical addressing (`ATSH <TX>` + `ATCRA <RX>`) in Default Session (`10 01`). Avoid broadcast `7DF` during live polling (busy ECUs drop functional requests).

## Reply Address Offset Rules
1. **`+0x08` Offset Group**: `7E2`–`7E6`, `760`, `765` → Reply ID is `TX + 0x08` (e.g., `7E2 → 7EA`, `765 → 76D`).
   - Standard OBD-II hardware adapters handle flow control automatically for `7Ex` addresses.
2. **`+0x80` Offset Group**: `705`–`74F` → Reply ID is `TX + 0x80` (e.g., `720 → 7A0`, `710 → 790`).
   - **Critical ELM327/STN Rule**: For multi-frame ISO-TP replies on non-`7Ex` ECUs (such as `720:11FF` TPMS, `710:1101` IPB dynamics, `718`/`719:1208` windows, `720:2100+2101+2102` batched lights), you MUST configure Flow Control Header per ECU:
     ```text
     ATFCSH <TX>
     ATFCSD 30 00 00
     ATFCSM 1
     ```
     Otherwise the adapter transmits Flow Control (`30 00 00`) to `7E0`/`7E2` instead of `720`, causing multi-frame reads to stall with `NO DATA` or incomplete frames.

## Complete 22-ECU Table

| Module | Req (`ATSH`) | Reply (`ATCRA`) | Offset | Part Number (`F187`) | System Name (`F197`) | Multi-DID (`0x22`) | Primary Telemetry / Notes |
| :--- | :---: | :---: | :---: | :--- | :--- | :---: | :--- |
| **BMS** (Battery Management) | `7E2` | `7EA` | `+0x08` | `2520105CVN1201` | `A12_UAES_BMS` | Yes (1–3) | SoC, SoH, pack V/I, 112 cell V, 24 cell T, 16 BMU T, CEC/CED, CC2, 12V |
| **VCU** (Vehicle Control Unit) | `7E3` | `7EB` | `+0x08` | `1110003CVN0211` | `VCU-UAES` | Yes (1–3) | 4 wheel speeds, 0.5% SoC, gear, A/C request, motor temps, power limits, UTC+8 clock |
| **MCU** (Motor Controller) | `7E4` | `7EC` | `+0x08` | `1510046CVN4200` | *(none)* | Yes (1–3) | Motor RPM, torque est., inverter DC-bus V, drive-unit temp, UTC+8 clock |
| **CCU** (Charger & DC-DC) | `7E6` | `7EE` | `+0x08` | `2730003CVN0601` | `EVT_6D6_CCU_B` | Yes (1–3) | 12V DC-DC output V, target V, charger/DC-DC temp, DC-DC current candidates |
| **Steering Switches (MFS)** | `765` | `76D` | `+0x08` | `8220005CVN0000` | `GAC-AY5-MFS` | Yes (1–3) | 12V supply (`1000`), switch states (`120E`, `120F` unconfirmed) |
| **Unknown (`A29-EOP`)** | `760` | `768` | `+0x08` | `1322005CVN0000` | `A29-EOP...` | TBD | Identity items (`F187`–`F197`) only explored so far |
| **Unknown (Slow)** | `705` | `785` | `+0x80` | `2610003ERD0100` | *(no VIN)* | Avoid | Answers NRC `0x78` (responsePending) to nearly everything — **exclude from fast polling** |
| **IPB** (Brakes & Stability, Bosch) | `710` | `790` | `+0x80` | `8085004ERD0002` | `Bosch_IPB` | **NO (1 only!)** | Steering angle, lat/lon G, yaw rate, brake pressure (`1101`), brake held (`1205`) |
| **EPB** (Parking Brake) | `711` | `791` | `+0x80` | `8080003CVN0100` | `WBTLEPB-20` | Yes | Parking brake static/config items (`1105`, `1106`, `1111`, `1200`) |
| **Door Module Left** | `718` | `798` | `+0x80` | `8065004 / 8065005` | `DOOR_L` | Yes (1–3) | Lock copy (`1203`), FL/RL window % & motor (`1208`), mirror/left-indicator (`1204?`), 12V (`1000`) |
| **Door Module Right (RHD Driver)** | `719` | `799` | `+0x80` | `8065004 / 8065005` | `DOOR_R` | Yes (1–3) | Central lock (`1203`), FR/RR window % & motor (`1208`), 12V (`1000`) |
| **IBCM** (Body Control, Continental) | `720` | `7A0` | `+0x80` | `8045025CVN0501` | `Continental_IBCM` | Yes (1–3) | TPMS (`11FF`), doors/boot (`1201`), pedal/P (`1200`, `1207`), indicators (`2100`), lamps (`2101`), lock log (`0510`), 12V |
| **Power Liftgate** | `724` | `7A4` | `+0x80` | `8045014CVN0003` | `Power Liftgate` | Yes | 12V supply (`1000`), liftgate flags (`1200`, `1201` seen `00` parked) |
| **Head Unit / Instrument Cluster** | `72B` | `7AB` | `+0x80` | `8545003CVN0403` | `AY5G_IC2254...` | Yes (1–3) | Local time BCD clock (`1202`, `2104`), PKI server URL (`1052`), 12V (`1000`) |
| **T-Box** (Telematics) | `72D` | `7AD` | `+0x80` | `8550003CVN1903` | `GAEI` | Yes (1–3) | MQTT server URL (`1014`), 12V (`1000`) |
| **Airbag / Seatbelt?** | `734` | `7B4` | `+0x80` | `8265010CVN0001` | *(unconfirmed)* | Yes | 12V supply (`1000`), seatbelt/airbag candidates (`1FC7`, `1FC9`, `1FD2`) |
| **Front Radar (Bosch)** | `73E` | `7BE` | `+0x80` | `8087003CVN0700` | `GAC-AY2.5-Bosch-FR` | TBD | Identity items explored only |
| **Blind-Spot Radar 1 (Bosch)** | `73F` | `7BF` | `+0x80` | `8535009CVN0500` | `Bosch-BSD` | TBD | Identity items explored only |
| **Front Camera (Bosch)** | `740` | `7C0` | `+0x80` | `8540009CVN0400` | `GAC-AY2.5-Bosch-IFC` | TBD | Identity items explored only |
| **Wireless Phone Charger?** | `748` | `7C8` | `+0x80` | `8245028ERD0002` | `...INVISPOWER` | TBD | Identity items explored only |
| **Blind-Spot Radar 2 (Bosch)** | `74A` | `7CA` | `+0x80` | `8535009CVN0500` | `Bosch-BSD` | TBD | Identity items explored only |
| **Gateway (GWM)** | `74F` | `7CF` | `+0x80` | `8045196ERD0303` | `+GWM30` | Yes (1–3) | 12V supply (`1000`), gateway status blocks (`1400`, `2110`) |

## Universal Identity DIDs (`0xF1xx` — Supported Across Modules)
Read once upon initial session connect if needed (do NOT place in live driving loop):
- `F187` — GAC Part Number (ASCII)
- `F18A` — Supplier Code (ASCII, e.g., `GAEI`)
- `F18C` — Module Serial Number (unique per car)
- `F190` — VIN (17-char ASCII, stored in 10 modules)
- `F193` — Hardware Version (ASCII)
- `F194` / `F195` — Software Version (ASCII)
- `F197` — System Name (ASCII)
