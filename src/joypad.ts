import { Int, Interrupts } from "./interrupts";

export type Button =
  | "right" | "left" | "up" | "down"
  | "a" | "b" | "select" | "start";

// Bit position of each button within its nibble (both groups share bits 0-3).
const BITS: Record<Button, number> = {
  right: 0, left: 1, up: 2, down: 3,
  a: 0, b: 1, select: 2, start: 3,
};

const DPAD: Button[] = ["right", "left", "up", "down"];

// JOYP (0xFF00) is a 2x4 button matrix read through one register.
// The game writes bits 4/5 to select which group (d-pad or buttons)
// appears in the low nibble. Everything is active-LOW: 0 = pressed.
export class Joypad {
  private select = 0x30;
  private dpad = 0x0f;
  private buttons = 0x0f;

  constructor(private ints: Interrupts) {}

  read(): number {
    let v = 0xc0 | this.select | 0x0f;
    if (!(this.select & 0x10)) v &= 0xf0 | this.dpad;
    if (!(this.select & 0x20)) v &= 0xf0 | this.buttons;
    return v;
  }

  write(v: number) {
    this.select = v & 0x30;
  }

  press(btn: Button) {
    const mask = ~(1 << BITS[btn]) & 0x0f;
    if (DPAD.includes(btn)) this.dpad &= mask;
    else this.buttons &= mask;
    this.ints.request(Int.Joypad);
  }

  release(btn: Button) {
    const bit = 1 << BITS[btn];
    if (DPAD.includes(btn)) this.dpad |= bit;
    else this.buttons |= bit;
  }
}
