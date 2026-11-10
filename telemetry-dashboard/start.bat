@echo off
chcp 65001 >nul
title AION V · Telemetry Dashboard
echo ============================================================
echo   AION V 602 · Widescreen In-Vehicle Telemetry Dashboard
echo ============================================================
echo.
echo [*] กำลังเปิดแดชบอร์ดบนเบราว์เซอร์ของคุณ...
echo [*] แดชบอร์ดมีระบบ Live Simulation ในตัว
echo     (หากยังไม่ได้เชื่อมต่อ WebSocket ระบบจะจำลองข้อมูลรถสดให้อัตโนมัติ)
echo.
start "" "%~dp0index.html"
echo [OK] เปิดหน้าต่างเบราว์เซอร์เรียบร้อยแล้ว
timeout /t 3 >nul
exit
