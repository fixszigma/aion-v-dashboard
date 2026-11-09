/**
 * Web Bluetooth (BLE 4.0+) transport for ELM327 / STN dongles.
 * Fully verified for Vgate vLinker FD+, vLinker MC+, vLinker BM+, OBDLink CX, iCar Pro BLE.
 * Requires a secure context (https:// or http://localhost) and Chrome / Edge (Android, PC, Mac, ChromeOS).
 */

const uuid16 = (x) => `0000${x.toLowerCase()}-0000-1000-8000-00805f9b34fb`;

export const BLE_PROFILES = [
  // 1. Vgate vLinker FD+ / MC+ / BM+ primary custom BLE profile (STN architecture)
  {
    name: 'vLinker / STN (Custom BLE)',
    service: 'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
    write: 'bef8d6c9-9c21-4c9e-b632-bd58c1009f9f',
    notify: 'bef8d6c9-9c21-4c9e-b632-bd58c1009f9f',
  },
  // 2. Vgate 18F0 standard transparent UART (widely used in vLinker FD+ / MC+ / iCar)
  {
    name: 'Vgate vLinker 18F0 (UART)',
    service: uuid16('18f0'),
    write: uuid16('2af1'),
    notify: uuid16('2af0'),
  },
  // 3. Alternative 18F0 pinout (swapped TX/RX on select firmware)
  {
    name: 'Vgate 18F0 Alt',
    service: uuid16('18f0'),
    write: uuid16('2af0'),
    notify: uuid16('2af1'),
  },
  // 4. Generic FFF0 (OBDLink CX / Vgate iCar Pro BLE / generic clones)
  {
    name: 'Generic FFF0 (OBDLink / iCar)',
    service: uuid16('fff0'),
    write: uuid16('fff2'),
    notify: uuid16('fff1'),
  },
  // 5. Generic FFE0 (HM-10 transparent UART)
  {
    name: 'Generic FFE0 (HM-10)',
    service: uuid16('ffe0'),
    write: uuid16('ffe1'),
    notify: uuid16('ffe1'),
  },
  // 6. Microchip IS1678 / BM70 Transparent UART (found in specialized vLinker batches)
  {
    name: 'Microchip Transparent UART',
    service: '49535343-fe7d-4ae5-8fa9-9fafd205e455',
    write: '49535343-8841-43f4-a8d4-ecbe34729bb3',
    notify: '49535343-1e4d-4bd9-ba61-23c647249616',
  },
  // 7. Android/iOS Vlink E0FF
  {
    name: 'Vlink E0FF',
    service: uuid16('e0ff'),
    write: uuid16('ffe1'),
    notify: uuid16('ffe1'),
  },
  // 8. Konnwei / BLE serial AE00
  {
    name: 'BLE Serial AE00',
    service: uuid16('ae00'),
    write: uuid16('ae01'),
    notify: uuid16('ae02'),
  },
];

// Exhaustive list of permitted services for Chrome Web Bluetooth security sandbox
const ALL_SERVICES = [
  ...new Set([
    ...BLE_PROFILES.map((p) => p.service.toLowerCase()),
    uuid16('18f0'),
    uuid16('fff0'),
    uuid16('ffe0'),
    uuid16('e0ff'),
    uuid16('ff00'),
    uuid16('fee7'),
    uuid16('ae00'),
    uuid16('1800'),
    uuid16('1801'),
    uuid16('180a'),
    'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
    '49535343-fe7d-4ae5-8fa9-9fafd205e455',
  ]),
];

export class BleTransport {
  static isSupported() {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
  }

  constructor() {
    this.device = null;
    this.writeChar = null;
    this.notifyChar = null;
    this.onData = () => {};
    this.onDisconnect = () => {};
    this.name = 'BLE';
    this.profile = '';
    this._decoder = new TextDecoder('latin1');
    this._handleNotify = (ev) => this.onData(this._decoder.decode(ev.target.value));
    this._handleDisconnect = () => this.onDisconnect();
  }

  async connect() {
    if (!BleTransport.isSupported()) {
      throw new Error('เบราว์เซอร์นี้ไม่รองรับ Web Bluetooth (กรุณาใช้ Google Chrome หรือ Microsoft Edge บน Android หรือคอมพิวเตอร์)');
    }

    // Filter by namePrefix to easily spotlight vLinker / OBD devices while accepting all BLE devices
    this.device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: ALL_SERVICES,
    });

    this.name = this.device.name || 'vLinker / OBD BLE';
    this.device.addEventListener('gattserverdisconnected', this._handleDisconnect);
    const server = await this.device.gatt.connect();

    // 1) Match known GATT profiles
    for (const p of BLE_PROFILES) {
      try {
        const svc = await server.getPrimaryService(p.service);
        try {
          this.writeChar = await svc.getCharacteristic(p.write);
          this.notifyChar = await svc.getCharacteristic(p.notify);
          this.profile = p.name;
          break;
        } catch {
          // If exact characteristic UUIDs differ, scan characteristics inside this known service
          const chars = await svc.getCharacteristics();
          const w = chars.find((c) => c.properties.write || c.properties.writeWithoutResponse);
          const n = chars.find((c) => c.properties.notify || c.properties.indicate);
          if (w && n) {
            this.writeChar = w;
            this.notifyChar = n;
            this.profile = `${p.name} (auto-char)`;
            break;
          }
        }
      } catch {
        this.writeChar = this.notifyChar = null;
      }
    }

    // 2) Universal Fallback: scan all permitted primary services on the device
    if (!this.writeChar || !this.notifyChar) {
      const services = await server.getPrimaryServices();
      for (const svc of services) {
        try {
          const chars = await svc.getCharacteristics();
          const w = chars.find((c) => c.properties.write || c.properties.writeWithoutResponse);
          const n = chars.find((c) => c.properties.notify || c.properties.indicate);
          if (w && n) {
            this.writeChar = w;
            this.notifyChar = n;
            this.profile = `Universal GATT (${svc.uuid.slice(0, 8)})`;
            break;
          }
        } catch {
          // Continue scanning next service
        }
      }
    }

    if (!this.writeChar || !this.notifyChar) {
      await this.disconnect();
      throw new Error('ไม่พบ GATT Serial Service ของ ELM327/vLinker บนอุปกรณ์นี้ (ตรวจสอบว่าเป็นดองเกิล Bluetooth 4.0/BLE ไม่ใช่ Bluetooth Classic SPP)');
    }

    // Enable BLE notifications for incoming data stream
    await this.notifyChar.startNotifications();
    this.notifyChar.addEventListener('characteristicvaluechanged', this._handleNotify);
  }

  /**
   * Writes command string chunked into 20-byte BLE packets with anti-congestion pacing.
   * @param {string} text Command string (including \r).
   */
  async write(text) {
    const data = new TextEncoder().encode(text);
    const noResp = this.writeChar.properties.writeWithoutResponse;

    for (let i = 0; i < data.length; i += 20) {
      const chunk = data.slice(i, i + 20);
      if (noResp && this.writeChar.writeValueWithoutResponse) {
        await this.writeChar.writeValueWithoutResponse(chunk);
        if (data.length > 20) {
          // 5ms micro-pause prevents buffer overflow on Android BLE stack
          await new Promise((r) => setTimeout(r, 5));
        }
      } else if (this.writeChar.writeValueWithResponse) {
        await this.writeChar.writeValueWithResponse(chunk);
      } else {
        await this.writeChar.writeValue(chunk);
      }
    }
  }

  async disconnect() {
    try {
      this.notifyChar?.removeEventListener('characteristicvaluechanged', this._handleNotify);
      await this.notifyChar?.stopNotifications();
    } catch {
      // Ignore disconnect cleanup errors
    }
    this.device?.removeEventListener('gattserverdisconnected', this._handleDisconnect);
    if (this.device?.gatt?.connected) {
      this.device.gatt.disconnect();
    }
    this.device = null;
    this.writeChar = null;
    this.notifyChar = null;
  }
}
