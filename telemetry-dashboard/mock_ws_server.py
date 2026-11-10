#!/usr/bin/env python3
"""
AION V · Lightweight Telemetry WebSocket Mock Server
Pure Python 3 standard library implementation (no pip dependencies required).
Listens on ws://127.0.0.1:8080/ws and streams real-time vehicle telemetry frames.
"""

import asyncio
import base64
import hashlib
import json
import math
import os
import socket
import struct
import sys
import threading
import time

HOST = "127.0.0.1"
PORT = 8080
MAGIC_GUID = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


def make_websocket_handshake(request: str) -> bytes:
    lines = request.split("\r\n")
    headers = {}
    for line in lines[1:]:
        if ":" in line:
            k, v = line.split(":", 1)
            headers[k.strip().lower()] = v.strip()

    key = headers.get("sec-websocket-key")
    if not key:
        return b"HTTP/1.1 400 Bad Request\r\n\r\n"

    accept_val = base64.b64encode(hashlib.sha1(key.encode("utf-8") + MAGIC_GUID).digest()).decode("ascii")

    response = (
        "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Accept: {accept_val}\r\n"
        "\r\n"
    )
    return response.encode("utf-8")


def encode_ws_frame(payload_str: str) -> bytes:
    data = payload_str.encode("utf-8")
    length = len(data)
    frame = bytearray([0x81])  # FIN + Text opcode

    if length <= 125:
        frame.append(length)
    elif length <= 65535:
        frame.append(126)
        frame.extend(struct.pack("!H", length))
    else:
        frame.append(127)
        frame.extend(struct.pack("!Q", length))

    frame.extend(data)
    return bytes(frame)


def telemetry_generator():
    phase = 0.0
    soc = 79.4
    remaining_kwh = 37.4
    trip_km = 0.0
    odo_base = 187384

    while True:
        phase += 0.1
        # Realistic driving cycle (0 to 110 km/h)
        speed = max(0.0, 75.0 + 35.0 * math.sin(phase * 0.3) + 12.0 * math.cos(phase * 0.7))
        if math.sin(phase * 0.1) < -0.6:
            speed = 0.0  # Traffic stop

        rpm = int(speed * 71.5)
        power_kw = round((speed / 100.0) * 45.0 + (12.0 if speed > 10 else 0.8), 1)
        gear = "P" if speed == 0 else "D"
        trip_km += (speed / 3600.0) * 0.1
        range_km = int((soc / 100.0) * 602)

        payload = {
            "speed_kmh": round(speed, 1),
            "motor_rpm": rpm,
            "motor_temp_c": int(32 + (speed / 100.0) * 7),
            "power_kw": power_kw,
            "gear": gear,
            "soc": round(soc, 1),
            "remaining_kwh": round(remaining_kwh, 1),
            "range_km": range_km,
            "battery_temp_c": 29,
            "charging_state": "not_charging" if gear == "D" else "plugged",
            "cabin_temp_c": 25.0,
            "outside_temp_c": 33,
            "fan_level": 1,
            "ac_active": True,
            "locked": gear == "D",
            "tpms": {
                "fl": {"p": 2.3, "t": 32},
                "fr": {"p": 2.3, "t": 32},
                "rl": {"p": 2.3, "t": 31},
                "rr": {"p": 2.3, "t": 32},
            },
            "odometer_km": int(odo_base + trip_km),
            "trip_km": round(trip_km, 2),
            "efficiency_km_kwh": round(max(5.0, min(9.5, speed / (power_kw if power_kw > 0 else 1.0))), 1),
        }
        yield json.dumps(payload)
        time.sleep(0.1)


def handle_client(client_socket):
    try:
        request = client_socket.recv(4096).decode("utf-8", errors="ignore")
        if not request:
            return

        handshake = make_websocket_handshake(request)
        client_socket.sendall(handshake)
        print("[+] WebSocket client connected successfully!")

        for frame in telemetry_generator():
            try:
                client_socket.sendall(encode_ws_frame(frame))
            except (BrokenPipeError, ConnectionResetError):
                break
    except Exception as e:
        print(f"[-] Client error: {e}")
    finally:
        client_socket.close()
        print("[-] Client disconnected.")


def main():
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind((HOST, PORT))
    server.listen(5)
    print("=" * 60)
    print(f"[*] AION V Telemetry Mock Server running at ws://{HOST}:{PORT}/ws")
    print("=" * 60)
    print("[i] Open index.html in your browser. Live telemetry will begin streaming.")
    print("[i] Press Ctrl+C to stop.")

    try:
        while True:
            client, addr = server.accept()
            t = threading.Thread(target=handle_client, args=(client,), daemon=True)
            t.start()
    except KeyboardInterrupt:
        print("\n[!] Server shutting down.")
    finally:
        server.close()


if __name__ == "__main__":
    main()
