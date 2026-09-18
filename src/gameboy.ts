import { APU } from "./apu";
import { Bus } from "./bus";
import { Cartridge } from "./cartridge";
import { CPU } from "./cpu";
import { Interrupts } from "./interrupts";
import { Joypad } from "./joypad";
import { PPU } from "./ppu";
import { Serial } from "./serial";
import { Timer } from "./timer";

// One video frame: 154 scanlines x 456 dots = 70224 T-cycles, ~59.7 Hz.
const CYCLES_PER_FRAME = 70224;

// The whole machine. Everything runs in lockstep off the CPU's cycle count,
// exactly like the real hardware runs off one 4.19 MHz crystal: the CPU
// executes an instruction, then every other chip advances by the same
// number of cycles.
export class GameBoy {
  readonly ints = new Interrupts();
  readonly cart: Cartridge;
  readonly ppu = new PPU(this.ints);
  readonly timer = new Timer(this.ints);
  readonly joypad = new Joypad(this.ints);
  readonly serial = new Serial(this.ints);
  readonly apu = new APU();
  readonly bus: Bus;
  readonly cpu: CPU;

  constructor(rom: Uint8Array) {
    this.cart = new Cartridge(rom);
    this.bus = new Bus(this.cart, this.ppu, this.timer, this.joypad, this.serial, this.ints, this.apu);
    this.cpu = new CPU(this.bus);

    if (this.cart.cgb) {
      this.ppu.cgb = true;
      this.bus.cgb = true;
      // Games detect Color hardware by checking A at startup, which the boot
      // ROM leaves as 0x11 on a CGB and 0x01 on a DMG.
      this.cpu.a = 0x11;
    }
    // H-blank DMA moves its next block each time a scanline finishes.
    this.ppu.onHBlank = () => this.bus.hdmaStep();
  }

  runFrame() {
    let elapsed = 0;
    while (elapsed < CYCLES_PER_FRAME) {
      const cycles = this.cpu.step();
      // In double-speed mode the CPU runs twice as fast while the video and
      // sound hardware keep the original clock, so they advance half as far
      // per instruction. The timer follows the CPU clock.
      const busCycles = this.bus.doubleSpeed ? cycles >> 1 : cycles;
      this.ppu.tick(busCycles);
      this.apu.tick(busCycles);
      this.timer.tick(cycles);
      elapsed += busCycles;
    }
  }
}
