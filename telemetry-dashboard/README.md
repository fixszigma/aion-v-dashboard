# AION V · Automotive In-Vehicle Telemetry Dashboard (IVI)

แดชบอร์ดแสดงผลข้อมูลสด (Real-time Telemetry Dashboard) สไตล์หน้าจอกลางรถยนต์ไฟฟ้า สำหรับ **GAC Aion V 602** (LFP 75.3 kWh) พัฒนาตามข้อกำหนด JSON Specification และโครงสร้าง UI มาตรฐานหน้าจอกลางรถยนต์ไฟฟ้า

---

## 🌟 จุดเด่นของระบบ (Key Features)

1. **Zero-Scroll In-Car Layout:**
   - แนวนอน (Landscape / Widescreen IVI): ล็อกความสูง `100dvh` แบบ `overflow: hidden` ไม่มีแถบเลื่อนกวนใจ เหมาะสำหรับจอรถหรือแท็บเล็ตแนวนอน
   - แนวตั้ง (Portrait): เลื่อนหน้าจอแนวตั้งได้อย่างลื่นไหล (`overflow-y: auto`)
2. **Glassmorphic Automotive Aesthetic:**
   - ธีมมืดรถยนต์ Deep Night (`#0b0f19`) ผสานการ์ดกระจกฝ้า Frosted Glass (`rgba(18, 24, 38, 0.7)`), ขอบกระจกบางเฉียบ (`rgba(255, 255, 255, 0.08)`) พร้อม `backdrop-filter: blur(12px)`
   - สีหลัก: Cyan Electric (`#06b6d4`), Emerald Charge (`#10b981`), Amber Warning (`#f59e0b`), Rose Alert (`#ef4444`)
3. **Dynamic SVG & Canvas Instruments:**
   - **Speedometer Arc & Needle:** หน้าปัดความเร็วเรืองแสง 270 องศา พร้อมเข็มไมล์และสเกล Ticks 0–200 km/h แสดงรอบมอเตอร์และอุณหภูมิมอเตอร์
   - **Battery Ring Gauge:** วงแหวนเปอร์เซ็นต์แบตเตอรี่ (SoC%) และกราฟิกทรงแท่งแบตเตอรี่พร้อมแอนิเมชันชาร์จ
   - **TPMS Tire Monitoring:** แสดงแรงดันลมยาง (bar) และอุณหภูมิยาง 4 ล้อ พร้อมระบบตรวจจับความดันต่ำ/สูงเกินและเปลี่ยนสีแจ้งเตือนอัตโนมัติ
   - **HVAC & Thermometer:** เทอร์โมมิเตอร์หลอดแก้วตรวจวัดอุณหภูมิภายนอก และการควบคุมแอร์/พัดลม
   - **Instant Efficiency Graph:** กราฟเส้นแบบ Real-time บนผืนผ้าใบ Canvas แสดงประวัติการกินพลังงาน (km/kWh)
4. **WebSocket Client พร้อมโหมดจำลองในตัว (Built-in Simulator):**
   - รองรับการเชื่อมต่อกับสตรีมข้อมูลสดผ่าน WebSocket (`ws://localhost:8080/ws`) พร้อม Exponential Backoff Auto-reconnect
   - **มีระบบ Fallback จำลองข้อมูลสดในตัวทันที**: สามารถดับเบิลคลิกเปิดไฟล์ `index.html` เพื่อดูการเคลื่อนไหวของหน้าปัด เข็มไมล์ กราฟิก และตัวเลขสดได้ทันทีโดยไม่ต้องต่อรถจริง

---

## 📁 โครงสร้างไฟล์ (File Structure)

```text
telemetry-dashboard/
├── index.html              # โครงสร้างหน้าเว็บตาม CSS Grid Named Areas
├── styles.css              # Glassmorphic Theme, Responsive Typography & Layouts
├── app.js                  # Engine ควบคุม WebSocket, เข็มไมล์, Canvas และ Mock Simulation
├── start.bat               # สคริปต์คลิกเดียวเปิดแดชบอร์ดบนเบราว์เซอร์
├── mock_ws_server.py       # เซิร์ฟเวอร์ WebSocket จำลองสำหรับทดสอบ (Python มาตรฐาน ไม่ต้องติดตั้ง pip)
└── assets/
    ├── aion_v_front.png    # ภาพหน้ารถ AION V (Transparent PNG)
    ├── aion_v_rear.png     # ภาพท้ายรถ AION V (Transparent PNG)
    └── aion_v_top.png      # ภาพมุมบนรถ AION V (Transparent PNG สำหรับ TPMS)
```

---

## 🚀 วิธีเปิดใช้งาน (How to Run)

### วิธีที่ 1: เปิดใช้งานทันที (Standalone Demo)
ดับเบิลคลิกไฟล์ **`start.bat`** หรือเปิดไฟล์ **`index.html`** ใน Google Chrome หรือ Microsoft Edge ระบบจะเปิดขึ้นมาใน **Simulation Mode** โดยอัตโนมัติ

### วิธีที่ 2: ทดสอบกับเซิร์ฟเวอร์ WebSocket
หากต้องการทดสอบการสตรีมผ่านเครือข่าย:
1. เปิด Terminal ในโฟลเดอร์นี้ แล้วรัน:
   ```bash
   python mock_ws_server.py
   ```
2. เปิดไฟล์ `index.html` บนเบราว์เซอร์ สถานะมุมขวาบนจะเปลี่ยนเป็น **Live OBD** ทันที
