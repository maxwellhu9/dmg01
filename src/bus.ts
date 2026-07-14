import { APU } from "./apu";
import { Cartridge } from "./cartridge";
import { Interrupts } from "./interrupts";
import { Joypad } from "./joypad";
import { PPU } from "./ppu";
import { Serial } from "./serial";
import { Timer } from "./timer";

// The bus is the address decoder: it maps the CPU's 16-bit address space
// onto the actual chips. Full map:
//   0000-7FFF cartridge ROM        8000-9FFF VRAM (PPU)
//   A000-BFFF cartridge RAM        C000-DFFF work RAM
//   E000-FDFF echo of work RAM     FE00-FE9F OAM (PPU)
//   FEA0-FEFF unusable             FF00-FF7F I/O registers
//   FF80-FFFE high RAM             FFFF      interrupt enable
export class Bus {
  private wram = new Uint8Array(0x2000);
  private hram = new Uint8Array(0x7f);

  constructor(
    public cart: Cartridge,
    public ppu: PPU,
    public timer: Timer,
    public joypad: Joypad,
    public serial: Serial,
    public ints: Interrupts,
    public apu: APU,
  ) {}

  read(addr: number): number {
    addr &= 0xffff;
    if (addr < 0x8000) return this.cart.read(addr);
    if (addr < 0xa000) return this.ppu.vram[addr - 0x8000];
    if (addr < 0xc000) return this.cart.read(addr);
    if (addr < 0xe000) return this.wram[addr - 0xc000];
    if (addr < 0xfe00) return this.wram[addr - 0xe000]; // echo RAM
    if (addr < 0xfea0) return this.ppu.oam[addr - 0xfe00];
    if (addr < 0xff00) return 0x00;
    if (addr < 0xff80) return this.readIO(addr);
    if (addr < 0xffff) return this.hram[addr - 0xff80];
    return this.ints.enable;
  }

  write(addr: number, v: number) {
    addr &= 0xffff;
    v &= 0xff;
    if (addr < 0x8000) return this.cart.write(addr, v);
    if (addr < 0xa000) { this.ppu.vram[addr - 0x8000] = v; return; }
    if (addr < 0xc000) return this.cart.write(addr, v);
    if (addr < 0xe000) { this.wram[addr - 0xc000] = v; return; }
    if (addr < 0xfe00) { this.wram[addr - 0xe000] = v; return; }
    if (addr < 0xfea0) { this.ppu.oam[addr - 0xfe00] = v; return; }
    if (addr < 0xff00) return;
    if (addr < 0xff80) return this.writeIO(addr, v);
    if (addr < 0xffff) { this.hram[addr - 0xff80] = v; return; }
    this.ints.enable = v;
  }

  private readIO(addr: number): number {
    if (addr >= 0xff10 && addr < 0xff40) return this.apu.read(addr);
    switch (addr) {
      case 0xff00: return this.joypad.read();
      case 0xff01: return this.serial.sb;
      case 0xff02: return this.serial.sc | 0x7e;
      case 0xff04: return this.timer.div;
      case 0xff05: return this.timer.tima;
      case 0xff06: return this.timer.tma;
      case 0xff07: return this.timer.tac | 0xf8;
      case 0xff0f: return this.ints.flags | 0xe0;
      default:
        if (addr >= 0xff40 && addr <= 0xff4b) return this.ppu.readReg(addr);
        return 0xff; // unmapped I/O reads as all 1s
    }
  }

  private writeIO(addr: number, v: number) {
    if (addr >= 0xff10 && addr < 0xff40) {
      this.apu.write(addr, v);
      return;
    }
    switch (addr) {
      case 0xff00: this.joypad.write(v); break;
      case 0xff01: this.serial.sb = v; break;
      case 0xff02: this.serial.writeSC(v); break;
      case 0xff04: this.timer.writeDiv(); break;
      case 0xff05: this.timer.tima = v; break;
      case 0xff06: this.timer.tma = v; break;
      case 0xff07: this.timer.tac = v & 0x07; break;
      case 0xff0f: this.ints.flags = v & 0x1f; break;
      case 0xff46: this.oamDMA(v); break;
      default:
        if (addr >= 0xff40 && addr <= 0xff4b) this.ppu.writeReg(addr, v);
      // 0xFF50 (boot ROM disable) and the rest: ignored
    }
  }

  // OAM DMA: copies a 160-byte page into sprite memory. Real hardware takes
  // 160 M-cycles and locks the bus (games run the wait loop from HRAM);
  // we copy instantly, which almost every game tolerates.
  private oamDMA(page: number) {
    const base = page << 8;
    for (let i = 0; i < 0xa0; i++) {
      this.ppu.oam[i] = this.read(base + i);
    }
  }
}
