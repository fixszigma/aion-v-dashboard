# AGENTS.md — GAC Aion V 602 OBD2 Telemetry & Dashboard Specification

เอกสารนี้รวบรวมข้อมูลโปรโตคอล OBD2 / CAN Bus, แผนผังกล่องควบคุม (ECU Module Map), รหัส DID (UDS Service `0x22`), สูตรการแปลงค่า และแนวทางการเขียนโค้ดสำหรับรถยนต์ไฟฟ้า **GAC Aion V 602** (รุ่นแบตเตอรี่ CATL LFP 75.3 kWh, ระยะทางวิ่ง 602 กม. NEDC ([Headlightmag](https://www.headlightmag.com/official-price-gac-aion-v/))) เพื่อใช้เป็น Context และข้อกำหนดทางเทคนิคสำหรับ AI Agent ใน [Google Antigravity](https://antigravity.google/) ในการพัฒนาแอปพลิเคชันแดชบอร์ดแบบเดียวกับ [evDash](https://www.evdash.eu/) และโปรเจกต์ Open-source [evDash สำหรับ M5Stack](https://github.com/nickn17/evDash)

## 1. เป้าหมายโปรเจกต์ (Project Overview & Architecture)
* **เป้าหมายหลัก**: พัฒนาแอปพลิเคชันดึงข้อมูลสด (Live Telemetry) จากพอร์ต OBD2 ของรถ GAC Aion V 602 เพื่อแสดงผลสถานะแบตเตอรี่ (SoC, SoH, แรงดันรายเซลล์ 112 เซลล์, อุณหภูมิแบตเตอรี่ 24 จุด), สถานะการขับขี่ (ความเร็ว, รอบมอเตอร์, เกียร์, กำลังไฟ), ระบบไฟ 12V และสถานะตัวถัง/ลมยาง (TPMS) ([Aion V OBD Items](https://www.aionv.app/pages/OBD-ITEMS.html), [Aion V OBD Logging](https://www.aionv.app/pages/OBD-LOGGING.html))
* **การเชื่อมต่อฮาร์ดแวร์**: รองรับดองเกิล OBD2 มาตรฐาน ELM327 / STN ผ่าน Bluetooth Low Energy (BLE 4.0+ เช่น OBDLink CX, Vgate vLinker MC+/BM+) หรือการเชื่อมต่อชิป CAN Transceiver โดยตรง (เช่น MCP2515 บน ESP32 / M5Stack Core2 / CoreS3) ([evDash GitHub](https://github.com/nickn17/evDash), [Aion V OBD Guide](https://www.aionv.app/pages/OBD-HOW-TO-READ.html))
* **ความปลอดภัย (Read-Only Policy)**: ส่งเฉพาะคำสั่งอ่านค่าด้วย UDS Service `0x22` (Read Data By Identifier), `0x19` (Read DTCs) และ `0x3E` (Tester Present) เท่านั้น ห้ามส่งคำสั่งเขียนค่า (`0x2E`), สั่งงานรูทีน (`0x31`), หรือควบคุมอุปกรณ์ (`0x2F`) โดยเด็ดขาด ([Aion V OBD Guide](https://www.aionv.app/pages/OBD-HOW-TO-READ.html))

## 2. มาตรฐานการเชื่อมต่อและโปรโตคอล (Physical & Transport Layer)
* **พอร์ตเชื่อมต่อ**: พอร์ตมาตรฐาน OBD2 (IP25) โดยใช้พิน `6` (CAN-H) และพิน `14` (CAN-L) สำหรับ Diagnostic CAN, พิน `4` และ `5` เป็น Ground, และพิน `16` เป็นไฟเลี้ยง 12V ตลอดเวลา ([Aion V OBD Guide](https://www.aionv.app/pages/OBD-HOW-TO-READ.html))
* **มาตรฐาน CAN Bus**: **ISO 15765-4 CAN (11-bit identifiers, 500 kbit/s)** ซึ่งตรงกับคำสั่ง `ATSP6` บนชิป ELM327 ([Aion V OBD Guide](https://www.aionv.app/pages/OBD-HOW-TO-READ.html))
* **ข้อจำกัด OBD-II มาตรฐาน**: รถไม่ตอบสนองต่อคำสั่ง Standard OBD-II Mode `01` หรือ Mode `09` ข้อมูลทั้งหมดต้องเรียกผ่าน **UDS Service `0x22`** แบบระบุกล่องปลายทาง (Physical Addressing) ใน Default Session โดยไม่ต้องส่ง `10 03` (Extended Session) ([Aion V OBD Guide](https://www.aionv.app/pages/OBD-HOW-TO-READ.html))
* **การรวมคำสั่ง (Multi-DID Request)**: กล่องควบคุมส่วนใหญ่รองรับการขอสูงสุด 3 DIDs ในเฟรมเดียวกัน เช่น `22 1477 1478 1479` (ยกเว้นกล่องเบรก `710` ที่ต้องขอทีละ 1 DID เท่านั้น) ([Aion V OBD Guide](https://www.aionv.app/pages/OBD-HOW-TO-READ.html))

## 3. แผนผังที่อยู่กล่องควบคุม (ECU CAN ID Mapping)
การส่งคำสั่งและรับข้อมูลตอบกลับ (Reply Address) ของ GAC Aion V แบ่งระยะ Offset ออกเป็น 2 กลุ่ม คือ **`+0x08`** (สำหรับช่วง `7E2`–`7E6`, `760`, `765`) และ **`+0x80`** (สำหรับช่วง `705`–`74F`) ([Aion V Module Map](https://www.aionv.app/pages/OBD-MODULES.html)):

| กล่องควบคุม (ECU Module) | ชื่อระบบภายใน (System Name) | Request ID (`ATSH`) | Reply ID (`ATCRA`) | รหัสพาร์ท (F187) | ข้อมูลหลักที่ดึงได้ |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **BMS (Battery Management)** | `A12_UAES_BMS` | `7E2` | `7EA` | `2520105CVN1201` | SoC, SoH, แรงดันแพ็ก/เซลล์ (112 เซลล์), อุณหภูมิแบต (24 จุด), พลังงานสะสม ([Aion V Module Map](https://www.aionv.app/pages/OBD-MODULES.html)) |
| **VCU (Vehicle Control Unit)** | `VCU-UAES` | `7E3` | `7EB` | `1110003CVN0211` | ความเร็วล้อทั้ง 4, ตำแหน่งเกียร์, อุณหภูมิมอเตอร์, สถานะ A/C, ลิมิตกำลังไฟ ([Aion V Module Map](https://www.aionv.app/pages/OBD-MODULES.html)) |
| **MCU (Motor Controller)** | *(ไม่ระบุ)* | `7E4` | `7EC` | `1510046CVN4200` | ความเร็วรอบมอเตอร์ (RPM), แรงบิด (Torque), แรงดัน DC-bus อินเวอร์เตอร์ ([Aion V Module Map](https://www.aionv.app/pages/OBD-MODULES.html)) |
| **CCU (Charger & DC-DC)** | `EVT_6D6_CCU_B` | `7E6` | `7EE` | `2730003CVN0601` | แรงดันและกระแสไฟชาร์จแบตเตอรี่ 12V, อุณหภูมิชุดชาร์จ ([Aion V Module Map](https://www.aionv.app/pages/OBD-MODULES.html)) |
| **IBCM (Body Control)** | Continental IBCM | `720` | `7A0` | `8045025CVN0501` | แรงดัน/อุณหภูมิลมยาง (TPMS), สถานะประตู/ฝาท้าย, ไฟเลี้ยว, ไฟเบรก ([Aion V Module Map](https://www.aionv.app/pages/OBD-MODULES.html)) |
| **IPB (Brakes & Stability)** | Bosch IPB | `710` | `790` | `8085004ERD0002` | มุมเลี้ยวพวงมาลัย, ค่า G-force, Yaw rate, แรงดันน้ำมันเบรก ([Aion V Module Map](https://www.aionv.app/pages/OBD-MODULES.html)) |
| **EPB (Parking Brake)** | `WBTLEPB-20` | `711` | `791` | `8080003CVN0100` | สถานะเบรกมือไฟฟ้า ([Aion V Module Map](https://www.aionv.app/pages/OBD-MODULES.html)) |
| **Door Module Right (RHD Driver)** | Door ECU R | `719` | `799` | `8065004 / 8065005` | สถานะล็อกรถ, เปอร์เซ็นต์การเปิดกระจกฝั่งขวา (หน้า/หลัง) ([Aion V Module Map](https://www.aionv.app/pages/OBD-MODULES.html)) |
| **Door Module Left** | Door ECU L | `718` | `798` | `8065004 / 8065005` | สถานะล็อกรถ (สำเนา), เปอร์เซ็นต์การเปิดกระจกฝั่งซ้าย (หน้า/หลัง) ([Aion V Module Map](https://www.aionv.app/pages/OBD-MODULES.html)) |
| **Instrument Cluster / Head Unit** | `AY5G_IC2254...` | `72B` | `7AB` | `8545003CVN0403` | นาฬิกาหน้าปัดรถ (เวลาท้องถิ่น BCD) ([Aion V Module Map](https://www.aionv.app/pages/OBD-MODULES.html)) |
| **T-Box (Telematics)** | `GAEI` | `72D` | `7AD` | `8550003CVN1903` | แรงดันไฟเลี้ยงโมดูล 12V, ข้อมูลเซิร์ฟเวอร์ Telematics ([Aion V Module Map](https://www.aionv.app/pages/OBD-MODULES.html)) |
| **Gateway (GWM)** | `+GWM30` | `74F` | `7CF` | `8045196ERD0303` | แรงดันไฟเลี้ยง Gateway 12V ([Aion V Module Map](https://www.aionv.app/pages/OBD-MODULES.html)) |

## 4. ตารางรหัส DID (UDS Service `0x22`) และสูตรการแปลงค่า
เมื่อส่งคำสั่ง `22 [DID]` กล่องจะตอบกลับด้วย `62 [DID] [Data Bytes...]` โดยค่า `value` อ่านแบบ **Big-endian** (ไบต์แรกมีค่าสูงสุด) ([Aion V OBD Items](https://www.aionv.app/pages/OBD-ITEMS.html)):

### 4.1 ระบบแบตเตอรี่แรงดันสูง (BMS: `7E2` → `7EA`)
| พารามิเตอร์ | DID (`0x22`) | จำนวนไบต์ | สูตรคำนวณ (Decoding Formula) | ตัวอย่างข้อมูลดิบ → ค่าจริง |
| :--- | :--- | :--- | :--- | :--- |
| **SoC แสดงผลหน้าจอ (%)** | `111A` (หรือ `141E`) | 2 | `value` (%) | `00 57` → `87 %` ([Aion V OBD Items](https://www.aionv.app/pages/OBD-ITEMS.html)) |
| **SoC ภายในกล่อง BMS (%)** | `111B` | 2 | `value` (%) *(มักต่ำกว่าหน้าจอ ~1%)* | `00 56` → `86 %` ([Aion V OBD Items](https://www.aionv.app/pages/OBD-ITEMS.html)) |
| **SoC เฉลี่ยของเซลล์ (%)** | `1114` | 1 | `value` (%) | `46` → `70 %` ([Aion V OBD Items](https://www.aionv.app/pages/OBD-ITEMS.html)) |
| **SoH สุขภาพแบตเตอรี่ (%)** | `1002` | 2 | `value / 100.0` (%) | `27 10` → `100.00 %` ([Aion V OBD Items](https://www.aionv.app/pages/OBD-ITEMS.html)) |
| **แรงดันแบตเตอรี่รวม (Pack Voltage)** | `1401` (หรือ `1105`) | 2 | `value / 10.0` (V) | `0E 8D` → `372.5 V` ([Aion V OBD Items](https://www.aionv.app/pages/OBD-ITEMS.html)) |
| **ผลรวมแรงดันทุกเซลล์ (Sum of Cells)** | `1106` | 2 | `value / 10.0` (V) | `0E 8F` → `372.7 V` ([Aion V OBD Items](https://www.aionv.app/pages/OBD-ITEMS.html)) |
| **กระแสไฟแบตเตอรี่ (Pack Current)** | `1404` | 2 | `(value - 8000) / 10.0` (A) *(8000 = 0A, >8000 = ใช้ไฟ)* | `1F 4E` → `1.4 A` ([Aion V OBD Items](https://www.aionv.app/pages/OBD-ITEMS.html)) |
| **แรงดันเซลล์สูงสุด (Max Cell Voltage)** | `2020` | 2 | `value - 5000` (mV) | `20 89` → `3329 mV` ([Aion V OBD Items](https://www.aionv.app/pages/OBD-ITEMS.html)) |
| **แรงดันเซลล์ต่ำสุด (Min Cell Voltage)** | `2022` | 2 | `value - 5000` (mV) | `20 86` → `3326 mV` ([Aion V OBD Items](https://www.aionv.app/pages/OBD-ITEMS.html)) |
| **แรงดันเซลล์เฉลี่ย (Avg Cell Voltage)** | `2023` | 2 | `value - 5000` (mV) | `20 87` → `3327 mV` ([Aion V OBD Items](https://www.aionv.app/pages/OBD-ITEMS.html)) |
| **หมายเลขเซลล์แรงดันสูงสุด / ต่ำสุด** | `1101` / `1103` | 1 (ต่อค่า) | `value` (ลำดับเซลล์ที่ 1–112) | `6C` → `108`, `29` → `41` ([Aion V OBD Items](https://www.aionv.app/pages/OBD-ITEMS.html)) |
| **แรงดันรายเซลล์ครบทั้งแพ็ก (Cell Array)** | `1151` | 300 | อ่านทีละ 2 ไบต์: `uint16 - 5000` (mV) *(ใช้จริง 112 เซลล์แรก = 224 ไบต์)* | `20 87 20 88...` → `3327, 3328 mV` ([Aion V OBD Items](https://www.aionv.app/pages/OBD-ITEMS.html)) |
| **อุณหภูมิแบตเตอรี่สูงสุด / ต่ำสุด** | `2024` / `2026` | 1 (ต่อค่า) | `value - 40` (°C) | `46` → `30 °C`, `45` → `29 °C` ([Aion V OBD Items](https://www.aionv.app/pages/OBD-ITEMS.html)) |
| **หมายเลขเซนเซอร์อุณหภูมิสูงสุด / ต่ำสุด** | `1115` / `1116` | 1 (ต่อค่า) | `value` (ลำดับเซนเซอร์ 1–24) | `0C` → `12`, `03` → `3` ([Aion V OBD Items](https://www.aionv.app/pages/OBD-ITEMS.html)) |
| **อุณหภูมิแบตเตอรี่รายจุด (Temp Array)** | `1150` | 54 | อ่านทีละ 1 ไบต์: `byte - 40` (°C) *(ใช้จริง 24 จุดแรก)* | `45 45 46...` → `29, 29, 30 °C` ([Aion V OBD Items](https://www.aionv.app/pages/OBD-ITEMS.html)) |
| **อุณหภูมิแผงวงจรควบคุมโมดูลแบต (16 จุด)** | `1180` | 32 | อ่านทีละ 1 ไบต์: `byte - 40` (°C) *(ใช้จริง 16 จุดแรก)* | `4E 4F...` → `38, 39 °C` ([Aion V OBD Items](https://www.aionv.app/pages/OBD-ITEMS.html)) |
| **อุณหภูมิแผงวงจรแบต สูงสุด / ต่ำสุด / เฉลี่ย** | `1181` / `1182` / `1183` | 1 (ต่อค่า) | `value - 40` (°C) | `4F` → `39 °C` ([Aion V OBD Items](https://www.aionv.app/pages/OBD-ITEMS.html)) |
| **พลังงานชาร์จเข้าสะสมทั้งหมด (CEC)** | `114D` | 3 | `value / 10.0` (kWh) | `00 05 0E` → `129.4 kWh` ([Aion V OBD Items](https://www.aionv.app/pages/OBD-ITEMS.html)) |
| **พลังงานจ่ายออกสะสมทั้งหมด (CED)** | `1189` | 3 | `value / 10.0` (kWh) | `00 02 91` → `65.7 kWh` ([Aion V OBD Items](https://www.aionv.app/pages/OBD-ITEMS.html)) |
| **แรงดันตรวจจับสายชาร์จ (CC2 Voltage)** | `1136` | 1 | `value / 10.0` (V) | `76` → `11.8 V` ([Aion V OBD Items](https://www.aionv.app/pages/OBD-ITEMS.html)) |
| **แรงดันไฟเลี้ยง 12V ที่กล่อง BMS** | `1000` | 1 | `value / 10.0` (V) | `84` → `13.2 V` ([Aion V OBD Items](https://www.aionv.app/pages/OBD-ITEMS.html)) |

### 4.2 ระบบขับเคลื่อน มอเตอร์ และชุดชาร์จ (VCU: `7E3` → `7EB`, MCU: `7E4` → `7EC`, CCU: `7E6` → `7EE`)
| พารามิเตอร์ | กล่อง (`ATSH`) | DID (`0x22`) | จำนวนไบต์ | สูตรคำนวณ (Decoding Formula) | ตัวอย่างข้อมูลดิบ → ค่าจริง |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **ความเร็วล้อ หน้าซ้าย / หน้าขวา / หลังซ้าย / หลังขวา** | `7E3` | `1477`–`147A` | 2 (ต่อล้อ) | `value / 200.0` (km/h) | `00 00` → `0.0 km/h` ([Aion V OBD Items](https://www.aionv.app/pages/OBD-ITEMS.html)) |
| **SoC ความละเอียด 0.5%** | `7E3` | `146B` | 1 | `value / 2.0` (%) | `AE` → `87.0 %` ([Aion V OBD Items](https://www.aionv.app/pages/OBD-ITEMS.html)) |
| **ตำแหน่งเกียร์ (Gear)** | `7E3` | `2103` | 1 | `6` = P, `1` = D, `5` = R, `4` = N | `06` → `P` ([Aion V OBD Items](https://www.aionv.app/pages/OBD-ITEMS.html)) |
| **สถานะระบบปรับอากาศ (A/C Request)** | `7E3` | `2104` | 1 | `02` = ปิด (Off), `05` หรือ `06` = เปิด (On) | `06` → `On` ([Aion V OBD Items](https://www.aionv.app/pages/OBD-ITEMS.html)) |
| **อุณหภูมิมอเตอร์ขับเคลื่อน 1 / 2** | `7E3` | `144D` / `144E` | 2 (ต่อค่า) | `value - 40` (°C) | `00 48` → `32 °C`, `00 49` → `33 °C` ([Aion V OBD Items](https://www.aionv.app/pages/OBD-ITEMS.html)) |
| **ลิมิตกำลังจ่ายไฟ / ชาร์จไฟแบตเตอรี่** | `7E3` | `2313` / `2314` | 2 (ต่อค่า) | `value` หรือ `value / 100.0` (kW) | `00 C9` → `201 kW` ([Aion V OBD Items](https://www.aionv.app/pages/OBD-ITEMS.html)) |
| **ความเร็วรอบมอเตอร์ (Motor Speed)** | `7E4` | `1110` | 2 | `value - 32767` (RPM, Signed; <32767 = ถอยหลัง) | `7F FF` → `0 rpm` ([Aion V OBD Items](https://www.aionv.app/pages/OBD-ITEMS.html)) |
| **แรงบิดมอเตอร์ (Motor Torque ประมาณการ)** | `7E4` | `1408` | 2 | `value - 1100` (0 = หยุดนิ่ง, >1100 = เร่ง, <1100 = Regen) | `04 65` → `+25` ([Aion V OBD Items](https://www.aionv.app/pages/OBD-ITEMS.html)) |
| **แรงดันไฟ DC-Bus อินเวอร์เตอร์** | `7E4` | `1100` | 2 | `value` (V) | `01 74` → `372 V` ([Aion V OBD Items](https://www.aionv.app/pages/OBD-ITEMS.html)) |
| **แรงดันขาออก DC-DC Converter 12V** | `7E6` | `1000` | 2 | `value / 100.0` (V) | `05 44` → `13.48 V` ([Aion V OBD Items](https://www.aionv.app/pages/OBD-ITEMS.html)) |
| **แรงดันเป้าหมาย DC-DC 12V** | `7E6` | `1402` | 2 | `value / 1000.0` (V) | `37 DC` → `14.30 V` ([Aion V OBD Items](https://www.aionv.app/pages/OBD-ITEMS.html)) |
| **อุณหภูมิชุดชาร์จ / DC-DC** | `7E6` | `110C` | 1 | `value - 40` (°C) | `45` → `29 °C` ([Aion V OBD Items](https://www.aionv.app/pages/OBD-ITEMS.html)) |

### 4.3 ระบบตัวถัง ลมยาง เบรก และประตู (`720`, `710`, `719`, `718`)
| พารามิเตอร์ | กล่อง (`ATSH`) | DID (`0x22`) | จำนวนไบต์ | สูตรคำนวณ (Decoding Formula) | ตัวอย่างข้อมูลดิบ → ค่าจริง |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **แรงดันและอุณหภูมิลมยาง 4 ล้อ (TPMS)** | `720` | `11FF` | 8 | 4 คู่ไบต์ `(P, T)`: `P / 5.0` = psi, `T - 50` = °C | `B2 51...` → `35.6 psi, 31 °C` ([Aion V OBD Items](https://www.aionv.app/pages/OBD-ITEMS.html)) |
| **สถานะเปิดประตูและฝาท้าย** | `720` | `1201` | 1 | Bitmask: `0x80`=ขวาหน้า, `0x40`=ซ้ายหน้า, `0x20`=ซ้ายหลัง, `0x10`=ขวาหลัง, `0x08`=ฝาท้าย | `80` → ประตูคนขับเปิด ([Aion V OBD Items](https://www.aionv.app/pages/OBD-ITEMS.html)) |
| **สวิตช์แป้นเบรกและเกียร์ P** | `720` | `1200` | 2 | Bitmask: `0x0010` = อยู่ในเกียร์ P, `0x0020` = เหยียบเบรก | `00 10` → เกียร์ P ([Aion V OBD Items](https://www.aionv.app/pages/OBD-ITEMS.html)) |
| **สถานะไฟเลี้ยว** | `720` | `2100` | 1 | Bitmask: `0x80` = ไฟเลี้ยวซ้าย, `0x08` = ไฟเลี้ยวขวา | `00` → ปิด ([Aion V OBD Items](https://www.aionv.app/pages/OBD-ITEMS.html)) |
| **สถานะไฟเบรกและไฟถอยหลัง** | `720` | `2101` | 2 | Bitmask: `0x0800` = ไฟเบรกติด, `0x0100` = ไฟถอยติด | `00 00` → ปิด ([Aion V OBD Items](https://www.aionv.app/pages/OBD-ITEMS.html)) |
| **สถานะล็อกประตูรถ** | `719` (หรือ `718`) | `1203` | 2 | `0x9400` = ปลดล็อก (Unlocked), `0xA800` = ล็อก (Locked) | `94 00` → Unlocked ([Aion V OBD Items](https://www.aionv.app/pages/OBD-ITEMS.html)) |
| **การเปิดกระจกหน้าต่างขวา / ซ้าย** | `719` / `718` | `1208` | 8 | `byte[1] / 2.0` = % เปิดบานหน้า, `byte[5] / 2.0` = % เปิดบานหลัง (`byte[2]`: `01`=ขึ้น, `02`=ลง, `00`=หยุด) | `01 00 00 00 01 00 00 00` → ปิดสนิท ([Aion V OBD Items](https://www.aionv.app/pages/OBD-ITEMS.html)) |
| **เซนเซอร์ทรงตัว (มุมพวงมาลัย, G-force, Yaw, เบรก)** | `710` | `1101` | 10 | 5 ค่า (ทีละ 2 ไบต์): `[0:2]` มุมพวงมาลัย `(15610 - val) * 0.1`°, `[2:4]` แรงเหวี่ยงข้าง `(val - 792) * 0.025` m/s², `[4:6]` แรงเร่งหน้า-หลัง `(val - 796) * 0.025` m/s², `[6:8]` Yaw `(val - 981) * 0.1` °/s, `[8:10]` แรงดันเบรก `val - 2778` | `FF FF 03 1C 03 1E 03 D6 0A DA` ([Aion V OBD Items](https://www.aionv.app/pages/OBD-ITEMS.html)) |

## 5. ลำดับคำสั่งเริ่มต้นและแนวทางการพัฒนาใน Antigravity
1. **ลำดับ AT Commands สำหรับ ELM327**:
   ```text
   ATZ
   ATE0
   ATL0
   ATH1
   ATSP6
   ATSH 7E2
   ATCRA 7EA
   22 11 1A 1
   ```
   *(การเติมเลขจำนวนเฟรมที่คาดหวัง เช่น `1` ต่อท้ายคำสั่ง จะช่วยลดเวลาการรอ Timeout ของ ELM327 จาก ~80–96 ms เหลือเพียง 17–24 ms ต่อคำสั่ง)* ([Aion V OBD Guide](https://www.aionv.app/pages/OBD-HOW-TO-READ.html))
2. **การรองรับดองเกิลโคลน (`ATCAF0`)**: หากดองเกิลตอบ `NO DATA` ในโหมดปกติ ให้สั่ง `ATCAF0` แล้วเติมไบต์ความยาว PCI นำหน้าเอง เช่น `03 22 11 1A` ([Aion V OBD Guide](https://www.aionv.app/pages/OBD-HOW-TO-READ.html))
3. **การจัดตารางเวลาดึงข้อมูล (Polling Schedule)**:
   * **กลุ่มความถี่สูง (ทุก 0.5–0.6 วินาที)**: ความเร็วล้อ (`7E3 1477 1478 1479`), รอบและแรงบิดมอเตอร์ (`7E4 1110 1408`), แรงดันและกระแสแบต (`7E2 1401 1404`), สถานะเกียร์ (`7E3 2103`), สถานะไฟเบรก/ประตู (`720 1200 1201 2101`) ([Aion V OBD Logging](https://www.aionv.app/pages/OBD-LOGGING.html))
   * **กลุ่มความถี่ต่ำ (ทุก 15–30 วินาที)**: SoC/SoH (`7E2 111A 1002`), แรงดันรายเซลล์ 112 เซลล์ (`7E2 1151`), อุณหภูมิแบต 24 จุด (`7E2 1150`), ลมยาง TPMS (`720 11FF`) ([Aion V OBD Logging](https://www.aionv.app/pages/OBD-LOGGING.html))
4. **การคำนวณระยะทางสะสม (Odometer Integration)**: เนื่องจากยังไม่พบรหัส DID ของเลขไมล์รวมจากโรงงาน ให้คำนวณระยะทางทริปและสะสมจากการอินทิเกรตความเร็วล้อเฉลี่ย (`v_kmh / 3600.0 * dt_sec`) ซึ่งให้ความแม่นยำคลาดเคลื่อนไม่เกิน 1 กม. เมื่อเทียบกับหน้าปัดรถ ([Aion V OBD Items](https://www.aionv.app/pages/OBD-ITEMS.html), [Aion V OBD Logging](https://www.aionv.app/pages/OBD-LOGGING.html))
