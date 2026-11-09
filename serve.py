#!/usr/bin/env python3
"""
GAC Aion V 602 — OBD2 Dashboard Local Server
Starts a local HTTP server for Web Bluetooth PWA and opens the dashboard in your browser.
"""

import http.server
import os
import socketserver
import sys
import webbrowser
from pathlib import Path

PORT = 8080
DIRECTORY = Path(__file__).resolve().parent / "dashboard"


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(DIRECTORY), **kwargs)

    def log_message(self, format, *args):
        # Keep console clean, only log errors or custom events
        if args and str(args[1]) in ("404", "500"):
            super().log_message(format, *args)


def main():
    if not DIRECTORY.exists():
        print(f"[ERROR] Directory not found: {DIRECTORY}")
        sys.exit(1)

    url = f"http://localhost:{PORT}/"
    print("=" * 60)
    print(" GAC Aion V 602 · OBD2 Live Dashboard Server")
    print("=" * 60)
    print(f"[*] Dashboard directory: {DIRECTORY}")
    print(f"[*] Local URL:          {url}")
    print("=" * 60)
    print("[i] รองรับการเปิดผ่าน Google Chrome หรือ Microsoft Edge")
    print("[i] สามารถเปิดทดสอบ 'โหมดสาธิต (Demo)' ได้ทันทีโดยไม่ต้องต่อรถ")
    print("[i] กด Ctrl + C เพื่อหยุดการทำงานของเซิร์ฟเวอร์")
    print("=" * 60)

    # Allow immediate socket reuse
    socketserver.TCPServer.allow_reuse_address = True
    try:
        with socketserver.TCPServer(("", PORT), Handler) as httpd:
            try:
                webbrowser.open(url)
            except Exception:
                pass
            httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[!] เซิร์ฟเวอร์หยุดการทำงานเรียบร้อยแล้ว")
    except OSError as e:
        print(f"\n[ERROR] พอร์ต {PORT} ถูกใช้งานอยู่แล้ว หรือไม่สามารถเปิดได้: {e}")
        print(f"ลองเปิด http://localhost:{PORT}/ บนเบราว์เซอร์ของคุณโดยตรง")


if __name__ == "__main__":
    main()
