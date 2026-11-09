@echo off
chcp 65001 >nul
title Push Aion V OBD to GitHub
echo ==========================================================
echo  GAC Aion V 602 OBD Dashboard - Push to GitHub
echo ==========================================================
echo.
set /p REPO_URL="วาง URL ของ GitHub Repository ของคุณ (เช่น https://github.com/username/aion-v-obd.git): "

if "%REPO_URL%"=="" (
    echo [!] ไม่ได้ระบุ URL ยกเลิกการทำงาน
    pause
    exit /b
)

git remote remove origin 2>nul
git remote add origin %REPO_URL%
git branch -M main

echo.
echo [*] กำลัง Push โค้ดขึ้น GitHub...
git push -u origin main

echo.
if %errorlevel% equ 0 (
    echo [OK] Push สำเร็จเรียบร้อย!
    echo.
    echo ขั้นตอนถัดไป:
    echo 1. ไปที่ GitHub Repo ของคุณ -^> Settings -^> Pages
    echo 2. ที่หัวข้อ "Build and deployment" ให้เลือก Source เป็น "GitHub Actions"
    echo 3. ระบบจะรัน Workflow อัตโนมัติและให้ลิงก์ HTTPS สำหรับเปิดบนมือถือในรถ
) else (
    echo [!] เกิดข้อผิดพลาดในการ Push ตรวจสอบสิทธิ์การเข้าถึง GitHub หรือ URL อีกครั้ง
)
echo.
pause
