/**
 * Web Bluetooth (BLE 4.0+) transport for ELM327 / STN dongles.
 * Tested profiles: OBDLink CX, Vgate vLinker MC+/BM+/FS, iCar Pro, generic FFF0/FFE0 clones.
 * Requires a secure context (https:// or http://localhost) and Chrome / Edge (desktop or Android).
 */

const uuid16 = (x) => `0000${x}-0000-1000-8000-00805f9b34fb`;

export const BLE_PROFILES = [
  { name: 'vLinker / OBDLink (custom)', service: 'e7810a71-73ae-499d-8c15-faa9aef0c3f2', write: 'bef8d6c9-9c21-4c9e-b632-bd58c1009f9f', notify: 'bef8d6c9-9c21-4c9e-b632-bd58c1009f9f' },
  { name: 'Generic FFF0 (OBDLink CX / iCar / clones)', service: uuid16('fff0'), write: uuid16('fff2'), notify: uuid16('fff1') },
  { name: 'Generic FFE0 (HM-10 based)', service: uuid16('ffe0'), write: uuid16('ffe1'), notify: uuid16('ffe1') },
  { name: 'Vgate 18F0', service: uuid16('18f0'), write: uuid16('2af1'), notify: uuid16('2af0') },
  { name: 'Konnwei / BLE serial AE00', service: uuid16('ae00'), write: uuid16('ae01'), notify: uuid16('ae02') },
];

const ALL_SERVICES = BLE_PROFILES.map((p) => p.service);

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
    if (!BleTransport.isSupported()) throw new Error('เบราว์เซอร์นี้ไม่รองรับ Web Bluetooth (ใช้ Chrome/Edge บน Android, Windows, macOS หรือ ChromeOS)');
    this.device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: ALL_SERVICES });
    this.name = this.device.name || 'BLE OBD';
    this.device.addEventListener('gattserverdisconnected', this._handleDisconnect);
    const server = await this.device.gatt.connect();

    // 1) Try known profiles
    for (const p of BLE_PROFILES) {
      try {
        const svc = await server.getPrimaryService(p.service);
        this.writeChar = await svc.getCharacteristic(p.write);
        this.notifyChar = await svc.getCharacteristic(p.notify);
        this.profile = p.name;
        break;
      } catch {
        this.writeChar = this.notifyChar = null;
      }
    }

    // 2) Fallback: scan permitted services for any write + notify characteristic pair
    if (!this.writeChar || !this.notifyChar) {
      const services = await server.getPrimaryServices();
      for (const svc of services) {
        const chars = await svc.getCharacteristics();
        const w = chars.find((c) => c.properties.write || c.properties.writeWithoutResponse);
        const n = chars.find((c) => c.properties.notify || c.properties.indicate);
        if (w && n) {
          this.writeChar = w;
          this.notifyChar = n;
          this.profile = `auto (${svc.uuid})`;
          break;
        }
      }
    }
    if (!this.writeChar || !this.notifyChar) {
      await this.disconnect();
      throw new Error('ไม่พบ GATT service ของ ELM327 บนอุปกรณ์นี้ (ตรวจสอบว่าเป็นดองเกิล BLE ไม่ใช่ Bluetooth Classic SPP)');
    }

    await this.notifyChar.startNotifications();
    this.notifyChar.addEventListener('characteristicvaluechanged', this._handleNotify);
  }

  async write(text) {
    const data = new TextEncoder().encode(text);
    const noResp = this.writeChar.properties.writeWithoutResponse;
    for (let i = 0; i < data.length; i += 20) {
      const chunk = data.slice(i, i + 20);
      if (noResp && this.writeChar.writeValueWithoutResponse) await this.writeChar.writeValueWithoutResponse(chunk);
      else if (this.writeChar.writeValueWithResponse) await this.writeChar.writeValueWithResponse(chunk);
      else await this.writeChar.writeValue(chunk);
    }
  }

  async disconnect() {
    try {
      this.notifyChar?.removeEventListener('characteristicvaluechanged', this._handleNotify);
      await this.notifyChar?.stopNotifications();
    } catch { /* ignore */ }
    this.device?.removeEventListener('gattserverdisconnected', this._handleDisconnect);
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
  }
}
