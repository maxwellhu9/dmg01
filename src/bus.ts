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
//
// Game Boy Color banks two of these regions: VRAM has two switchable banks,
// and the upper half of work RAM has seven.
export class Bus {
  // 8 banks of 4KB on Color hardware; a DMG game only ever sees the first two.
  private wram = new Uint8Array(0x8000);
  private hram = new Uint8Array(0x7f);
  private svbk = 1; // which WRAM bank is mapped at 0xD000

  cgb = false;
  // KEY1: games ask for double speed by setting bit 0, then executing STOP.
  doubleSpeed = false;
  private speedRequested = false;

  // HDMA copies VRAM much faster than the CPU can, either all at once or 16
  // bytes per H-blank so it never fights the PPU for the bus.
  private hdmaSrc = 0;
  private hdmaDst = 0;
  private hdmaBlocks = 0; // 16-byte blocks left in an active H-blank transfer
  private hdmaActive = false;

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
    if (addr < 0xa000) return this.ppu.vram[this.ppu.vbk * 0x2000 + addr - 0x8000];
    if (addr < 0xc000) return this.cart.read(addr);
    if (addr < 0xe000) return this.wram[this.wramOffset(addr)];
    if (addr < 0xfe00) return this.wram[this.wramOffset(addr - 0x2000)]; // echo RAM
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
    if (addr < 0xa000) { this.ppu.vram[this.ppu.vbk * 0x2000 + addr - 0x8000] = v; return; }
    if (addr < 0xc000) return this.cart.write(addr, v);
    if (addr < 0xe000) { this.wram[this.wramOffset(addr)] = v; return; }
    if (addr < 0xfe00) { this.wram[this.wramOffset(addr - 0x2000)] = v; return; }
    if (addr < 0xfea0) { this.ppu.oam[addr - 0xfe00] = v; return; }
    if (addr < 0xff00) return;
    if (addr < 0xff80) return this.writeIO(addr, v);
    if (addr < 0xffff) { this.hram[addr - 0xff80] = v; return; }
    this.ints.enable = v;
  }

  // 0xC000-0xCFFF is always bank 0; 0xD000-0xDFFF is the switchable one.
  // Bank 0 is not selectable, so writing 0 to SVBK means bank 1.
  private wramOffset(addr: number): number {
    if (addr < 0xd000) return addr - 0xc000;
    return this.svbk * 0x1000 + (addr - 0xd000);
  }

  // Called when STOP runs: commits a requested speed switch.
  trySpeedSwitch(): boolean {
    if (!this.cgb || !this.speedRequested) return false;
    this.doubleSpeed = !this.doubleSpeed;
    this.speedRequested = false;
    return true;
  }

  private startHDMA(v: number) {
    const blocks = (v & 0x7f) + 1;
    if (!(v & 0x80)) {
      if (this.hdmaActive) {
        this.hdmaActive = false; // writing bit 7 = 0 cancels an H-blank transfer
        return;
      }
      // General purpose: the CPU is stalled on real hardware, so copy it all.
      this.copyHDMA(blocks);
      return;
    }
    this.hdmaBlocks = blocks;
    this.hdmaActive = true;
  }

  private copyHDMA(blocks: number) {
    for (let n = 0; n < blocks; n++) {
      for (let i = 0; i < 16; i++) {
        const value = this.read((this.hdmaSrc + i) & 0xffff);
        this.ppu.vram[this.ppu.vbk * 0x2000 + ((this.hdmaDst + i) & 0x1fff)] = value;
      }
      this.hdmaSrc = (this.hdmaSrc + 16) & 0xffff;
      this.hdmaDst = (this.hdmaDst + 16) & 0x1fff;
    }
  }

  // One 16-byte block per H-blank, driven by the PPU.
  hdmaStep() {
    if (!this.hdmaActive) return;
    this.copyHDMA(1);
    if (--this.hdmaBlocks === 0) this.hdmaActive = false;
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
      case 0xff4d:
        return this.cgb
          ? (this.doubleSpeed ? 0x80 : 0) | (this.speedRequested ? 1 : 0) | 0x7e
          : 0xff;
      case 0xff55:
        // Bit 7 clear means a transfer is running; the low bits count the
        // blocks still to go.
        return this.cgb && this.hdmaActive ? this.hdmaBlocks - 1 : 0xff;
      case 0xff70: return this.cgb ? this.svbk | 0xf8 : 0xff;
      default:
        if (addr >= 0xff40 && addr <= 0xff4b) return this.ppu.readReg(addr);
        if (addr === 0xff4f || (addr >= 0xff68 && addr <= 0xff6b)) {
          return this.ppu.readReg(addr);
        }
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
      case 0xff4d: if (this.cgb) this.speedRequested = (v & 1) !== 0; break;
      case 0xff51: this.hdmaSrc = (this.hdmaSrc & 0x00ff) | (v << 8); break;
      case 0xff52: this.hdmaSrc = (this.hdmaSrc & 0xff00) | (v & 0xf0); break;
      case 0xff53: this.hdmaDst = (this.hdmaDst & 0x00ff) | ((v & 0x1f) << 8); break;
      case 0xff54: this.hdmaDst = (this.hdmaDst & 0xff00) | (v & 0xf0); break;
      case 0xff55: if (this.cgb) this.startHDMA(v); break;
      case 0xff70: if (this.cgb) this.svbk = (v & 7) || 1; break;
      default:
        if (addr >= 0xff40 && addr <= 0xff4b) this.ppu.writeReg(addr, v);
        else if (addr === 0xff4f || (addr >= 0xff68 && addr <= 0xff6b)) {
          this.ppu.writeReg(addr, v);
        }
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
