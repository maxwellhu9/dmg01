import { Int, Interrupts } from "./interrupts";

// The link-cable port: SB (0xFF01) holds the byte, writing 0x80|0x01 to
// SC (0xFF02) starts a transfer. With no cable attached we "complete" the
// transfer instantly and keep the byte.
//
// This tiny device matters far beyond link cables: Blargg's test ROMs
// print their PASS/FAIL results as ASCII through this port, so capturing
// it gives us a free test harness.
export class Serial {
  sb = 0;
  sc = 0;
  output = "";
  onOutput?: (all: string) => void;

  constructor(private ints: Interrupts) {}

  writeSC(v: number) {
    this.sc = v & 0x7f;
    if (v & 0x80 && v & 0x01) {
      this.output += String.fromCharCode(this.sb);
      this.sb = 0xff; // no device on the other end
      this.ints.request(Int.Serial);
      this.onOutput?.(this.output);
    }
  }
}
