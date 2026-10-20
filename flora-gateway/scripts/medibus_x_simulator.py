"""
Medibus.X Serial Simulator (ไฟล์เดียว ใช้งานได้เลย)

จำลองเครื่องช่วยหายใจส่งค่าผ่าน Serial Port ตามรูปแบบ Medibus.X
  - ส่งค่า Realtime ออกพอร์ตเองทุกๆ N วินาที (push)
  - ตอบกลับคำสั่ง CMD=ICC และ REQ=REALTIME (เผื่อ logger ส่งมาถาม)
  - เลือก baud rate, data bits, parity, stop bits ได้ (จาก argument หรือเมนู)

ติดตั้ง:   pip install pyserial
ตัวอย่าง:
    py medibus_x_simulator.py                              # เลือกพอร์ตและค่าพอร์ตจากเมนู
    py medibus_x_simulator.py COM1                         # เลือกค่าพอร์ตจากเมนู
    py medibus_x_simulator.py COM1 --baud 19200 --bytesize 8 --parity E --stopbits 1
    py medibus_x_simulator.py COM1 --line 19200-8E1        # แบบย่อ
    py medibus_x_simulator.py COM1 --line 9600-8N1 --interval 0.5
    py medibus_x_simulator.py COM1 --line 19200-8E1 --count 100
    py medibus_x_simulator.py COM1 --line 19200-8N1 --new-params-after 20
"""
import argparse
import random
import re
import sys
import time
from typing import Dict, Optional

import serial
import serial.tools.list_ports

STX = 0x02
ETX = 0x03
DELIMITER = ";"

BAUD_RATES = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200]
DEFAULT_BAUD = 19200
BYTESIZES = {5: serial.FIVEBITS, 6: serial.SIXBITS, 7: serial.SEVENBITS, 8: serial.EIGHTBITS}
DEFAULT_BYTESIZE = 8
PARITIES = {
    "N": (serial.PARITY_NONE, "None"),
    "E": (serial.PARITY_EVEN, "Even"),
    "O": (serial.PARITY_ODD, "Odd"),
    "M": (serial.PARITY_MARK, "Mark"),
    "S": (serial.PARITY_SPACE, "Space"),
}
DEFAULT_PARITY = "N"
STOPBITS = {"1": serial.STOPBITS_ONE, "1.5": serial.STOPBITS_ONE_POINT_FIVE, "2": serial.STOPBITS_TWO}
DEFAULT_STOPBITS = "1"


# ---------------- Medibus.X frame ----------------
def calculate_lrc(data_bytes: bytes) -> str:
    lrc = 0
    for byte in data_bytes:
        lrc = (lrc + byte) & 0xFF
    lrc = ((lrc ^ 0xFF) + 1) & 0xFF
    return f"{lrc:02X}"


def build_frame(payload: str) -> bytes:
    """STX + payload + ';' + LRC + ETX"""
    payload_bytes = payload.encode("ascii")
    checksum = calculate_lrc(payload_bytes)
    return bytes([STX]) + payload_bytes + f"{DELIMITER}{checksum}".encode("ascii") + bytes([ETX])


def parse_request(raw: bytes) -> Optional[str]:
    """คืนค่า payload ถ้า frame ถูกต้อง (เช็ก STX/ETX/LRC) ไม่งั้นคืน None"""
    if len(raw) < 4 or raw[0] != STX or raw[-1] != ETX:
        return None
    content = raw[1:-1].decode("ascii", errors="ignore")
    if DELIMITER not in content:
        return None
    payload, checksum = content.rsplit(DELIMITER, 1)
    if calculate_lrc(payload.encode("ascii")).upper() != checksum.strip().upper():
        print(f"[SIM] Bad checksum: {content!r}")
        return None
    return payload


def read_frame(ser: serial.Serial) -> bytes:
    """อ่าน 1 frame (STX...ETX) คืน b'' ถ้า timeout"""
    buffer = bytearray()
    in_frame = False
    while True:
        b = ser.read(1)
        if not b:
            return b""
        if b[0] == STX:
            in_frame = True
            buffer = bytearray([STX])
        elif in_frame:
            buffer.append(b[0])
            if b[0] == ETX:
                return bytes(buffer)


# ---------------- ข้อมูลจำลอง ----------------
class VentilatorModel:
    """สร้างค่าที่เปลี่ยนแปลงช้าๆ ให้ดูสมจริง"""

    def __init__(self, new_params_after: Optional[float] = None):
        self.pip, self.peep, self.vte = 22.0, 5.0, 480.0
        self.rr, self.fio2, self.etco2 = 14.0, 40.0, 36.0
        self.start = time.time()
        self.new_params_after = new_params_after

    @staticmethod
    def _drift(v: float, step: float, low: float, high: float) -> float:
        return max(low, min(high, v + random.uniform(-step, step)))

    def realtime_fields(self) -> Dict[str, object]:
        self.pip = self._drift(self.pip, 0.6, 15, 35)
        self.peep = self._drift(self.peep, 0.2, 3, 10)
        self.vte = self._drift(self.vte, 12, 350, 600)
        self.rr = self._drift(self.rr, 0.7, 10, 24)
        self.fio2 = self._drift(self.fio2, 1, 21, 100)
        self.etco2 = self._drift(self.etco2, 0.5, 28, 48)

        fields: Dict[str, object] = {
            "P_PEAK": round(self.pip, 1),
            "MDC_PRESS_AW_PEEP": round(self.peep, 1),
            "V_TE": int(self.vte),
            "MDC_RESP_RATE": int(self.rr),
            "FI_O2": int(self.fio2),
            "ET_CO2": round(self.etco2, 1),
        }
        # พารามิเตอร์ใหม่ ใช้ทดสอบระบบ auto-mapping ของ logger
        if self.new_params_after is not None and time.time() - self.start >= self.new_params_after:
            fields["MDC_FLOW_PEAK"] = round(random.uniform(40, 70), 1)
            fields["P_PLAT"] = round(self.pip - random.uniform(2, 5), 1)
            fields["SPO2"] = random.randint(94, 100)
        return fields

    def realtime_payload(self) -> str:
        return DELIMITER.join(f"{k}={v}" for k, v in self.realtime_fields().items())


def handle_request(payload: str, model: VentilatorModel) -> Optional[str]:
    cmd = payload.strip()
    if cmd == "CMD=ICC":
        return "DEV=SIM-VENT;FW=1.0.0;PROTO=MEDIBUS.X"
    if cmd == "REQ=REALTIME":
        return model.realtime_payload()
    print(f"[SIM] Unknown request: {payload!r}")
    return None


# ---------------- เลือกพอร์ต ----------------
def choose_port() -> str:
    while True:
        ports = sorted(serial.tools.list_ports.comports(), key=lambda p: p.device)
        print("\nAvailable serial ports:")
        if ports:
            for i, p in enumerate(ports, start=1):
                print(f"  [{i}] {p.device}  -  {p.description}")
        else:
            print("  (none found)")
        print("  [r] Rescan   [m] Type port name manually   [q] Quit")

        choice = input("Select port number: ").strip().lower()
        if choice == "q":
            raise SystemExit(0)
        if choice in ("r", ""):
            continue
        if choice == "m":
            manual = input("Enter port name (e.g., COM1): ").strip()
            if manual:
                return manual
            continue
        if choice.isdigit() and 1 <= int(choice) <= len(ports):
            return ports[int(choice) - 1].device
        print("[!] Invalid choice, try again.")


# ---------------- เลือกค่าพอร์ต (baud / data bits / parity / stop bits) ----------------
def menu(title: str, options: list, default_index: int) -> int:
    """แสดงเมนูตัวเลข คืน index ที่เลือก (Enter = ค่าเริ่มต้น)"""
    print(f"\n{title}:")
    for i, label in enumerate(options, start=1):
        print(f"  {i}) {label}{'   (default)' if i - 1 == default_index else ''}")
    while True:
        choice = input(f"เลือก / Select [1-{len(options)}] (Enter = {default_index + 1}): ").strip()
        if choice == "":
            return default_index
        if choice.isdigit() and 1 <= int(choice) <= len(options):
            return int(choice) - 1
        print("[!] Invalid choice, try again.")


def choose_baud() -> int:
    labels = [str(b) for b in BAUD_RATES] + ["กำหนดเอง / Custom"]
    index = menu("Baud rate", labels, BAUD_RATES.index(DEFAULT_BAUD))
    if index < len(BAUD_RATES):
        return BAUD_RATES[index]
    while True:
        value = input("Enter baud rate (e.g., 14400): ").strip()
        if value.isdigit() and int(value) > 0:
            return int(value)
        print("[!] Baud rate must be a positive number.")


def choose_bytesize() -> int:
    sizes = list(BYTESIZES)
    return sizes[menu("Data bits", [str(s) for s in sizes], sizes.index(DEFAULT_BYTESIZE))]


def choose_parity() -> str:
    keys = list(PARITIES)
    labels = [f"{PARITIES[k][1]} ({k})" for k in keys]
    return keys[menu("Parity", labels, keys.index(DEFAULT_PARITY))]


def choose_stopbits() -> str:
    keys = list(STOPBITS)
    return keys[menu("Stop bits", keys, keys.index(DEFAULT_STOPBITS))]


LINE_PATTERN = re.compile(r"^(\d+)[-_ ]?([5-8])([NEOMS])(1\.5|1|2)$", re.IGNORECASE)


def parse_line(text: str):
    """'19200-8E1' -> (19200, 8, 'E', '1')"""
    match = LINE_PATTERN.match(text.strip())
    if not match:
        raise argparse.ArgumentTypeError("use BAUD-<data bits><parity><stop bits>, e.g. 19200-8E1, 9600-7O2, 4800-8N1.5")
    baud, bits, parity, stop = match.groups()
    return int(baud), int(bits), parity.upper(), stop


def main() -> None:
    parser = argparse.ArgumentParser(description="Medibus.X serial value simulator")
    parser.add_argument("port", nargs="?", default=None, help="Serial port (ไม่ใส่ = แสดงเมนูเลือก)")
    parser.add_argument("--line", type=parse_line, default=None,
                        help="ค่าพอร์ตแบบย่อ เช่น 19200-8E1 (แทน --baud/--bytesize/--parity/--stopbits)")
    parser.add_argument("--baud", type=int, default=None, help=f"baud rate (default {DEFAULT_BAUD})")
    parser.add_argument("--bytesize", type=int, choices=sorted(BYTESIZES), default=None,
                        help=f"data bits (default {DEFAULT_BYTESIZE})")
    parser.add_argument("--parity", type=str.upper, choices=list(PARITIES), default=None,
                        help="N=None E=Even O=Odd M=Mark S=Space (default N)")
    parser.add_argument("--stopbits", choices=list(STOPBITS), default=None, help=f"stop bits (default {DEFAULT_STOPBITS})")
    parser.add_argument("--defaults", action="store_true",
                        help=f"ไม่ถามเมนู ใช้ค่าเริ่มต้นกับค่าที่ไม่ได้ระบุ ({DEFAULT_BAUD}-{DEFAULT_BYTESIZE}{DEFAULT_PARITY}{DEFAULT_STOPBITS})")
    parser.add_argument("--interval", type=float, default=1.0, help="ส่งค่าทุกกี่วินาที (default 1.0)")
    parser.add_argument("--count", type=int, default=None, help="ส่งครบ N frame แล้วหยุด")
    parser.add_argument("--new-params-after", type=float, default=None,
                        help="หลังกี่วินาทีให้ส่งพารามิเตอร์ใหม่เพิ่ม")
    args = parser.parse_args()

    if args.line:
        args.baud, args.bytesize, args.parity, args.stopbits = args.line

    if not args.port:
        args.port = choose_port()

    # ค่าที่ไม่ได้ระบุ: ถามจากเมนู (ถ้ารันแบบมีคนพิมพ์) หรือใช้ค่าเริ่มต้น
    ask = sys.stdin.isatty() and not args.defaults
    if args.baud is None:
        args.baud = choose_baud() if ask else DEFAULT_BAUD
    if args.bytesize is None:
        args.bytesize = choose_bytesize() if ask else DEFAULT_BYTESIZE
    if args.parity is None:
        args.parity = choose_parity() if ask else DEFAULT_PARITY
    if args.stopbits is None:
        args.stopbits = choose_stopbits() if ask else DEFAULT_STOPBITS

    line = f"{args.baud} {args.bytesize}{args.parity}{args.stopbits}"
    model = VentilatorModel(new_params_after=args.new_params_after)
    try:
        ser = serial.Serial(
            port=args.port,
            baudrate=args.baud,
            bytesize=BYTESIZES[args.bytesize],
            parity=PARITIES[args.parity][0],
            stopbits=STOPBITS[args.stopbits],
            timeout=0.2,
        )
    except (serial.SerialException, ValueError) as e:
        print(f"[-] Cannot open {args.port} {line}: {e}")
        raise SystemExit(1)
    print(f"[SIM] {args.port} @ {line}, ส่งทุก {args.interval}s  (Ctrl+C เพื่อหยุด)")
    if args.bytesize < 8:
        print(f"[!] data bits = {args.bytesize}: ตัวอักษร ASCII ส่งได้ครบที่ 7 bits ขึ้นไป (5-6 bits ข้อมูลจะเพี้ยน)")

    sent = 0
    next_push = time.time()
    try:
        while args.count is None or sent < args.count:
            # ตอบคำสั่งที่ส่งมา (ถ้ามี)
            if ser.in_waiting:
                raw = read_frame(ser)
                payload = parse_request(raw) if raw else None
                if payload:
                    response = handle_request(payload, model)
                    if response:
                        ser.write(build_frame(response))
                        print(f"[SIM] reply {payload} -> {response}")

            # ส่งค่า realtime ตามเวลา
            if time.time() >= next_push:
                payload = model.realtime_payload()
                ser.write(build_frame(payload))
                sent += 1
                print(f"[SEND] #{sent}: {payload}")
                next_push += args.interval
            else:
                time.sleep(0.02)
    except serial.SerialException as e:
        print(f"[-] Serial error: {e}")
    except KeyboardInterrupt:
        print("\n[SIM] Stopped.")
    finally:
        if ser.is_open:
            ser.close()
        print(f"[SIM] Total frames sent: {sent} ({line})")


if __name__ == "__main__":
    main()
