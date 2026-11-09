@echo off
cd /d "%~dp0"
title Push to GitHub (fixszigma/aion-v-dashboard)
echo ================================================================
echo  GAC Aion V Dashboard - Pushing to GitHub
echo  Repository: https://github.com/fixszigma/aion-v-dashboard.git
echo ================================================================
echo.
git push -u origin main
echo.
if %errorlevel% equ 0 (
    echo [OK] Push สำเร็จเรียบร้อย!
    echo.
    echo ขั้นตอนสุดท้ายบน GitHub:
    echo 1. เปิด https://github.com/fixszigma/aion-v-dashboard/settings/pages
    echo 2. ที่หัวข้อ "Build and deployment" ให้เลือก Source เป็น "GitHub Actions"
    echo 3. รอระบบ Deploy แล้วเปิด URL บนมือถือในรถได้เลยครับ!
) else (
    echo [!] การ Push ไม่สำเร็จ (หากมีหน้าต่าง Login GitHub เด้งขึ้นมา ให้กดยืนยันการเข้าสู่ระบบ)
)
echo.
pause
