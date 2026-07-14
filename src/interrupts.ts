// The Game Boy has 5 interrupt sources. Two registers control them:
//   IE (0xFFFF) - which interrupts are enabled
//   IF (0xFF0F) - which interrupts are currently requested
// An interrupt fires when its bit is set in BOTH registers and the CPU's
// master enable (IME) is on. Lower bit number = higher priority.
export const enum Int {
  VBlank = 0, // start of vertical blank, 59.7 times/sec
  Stat = 1,   // LCD status (mode changes, LY==LYC)
  Timer = 2,  // TIMA overflow
  Serial = 3, // link cable transfer complete
  Joypad = 4, // button pressed
}

export class Interrupts {
  enable = 0x00;
  flags = 0xe1; // post-boot value: VBlank already pending

  request(i: Int) {
    this.flags |= 1 << i;
  }
}
