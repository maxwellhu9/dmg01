// Game Boy cartridges larger than 32KB contain a Memory Bank Controller
// (MBC) chip that pages 16KB ROM banks into 0x4000-0x7FFF and optional
// battery-backed RAM into 0xA000-0xBFFF. The CPU "writes to ROM" to talk
// to the MBC — those writes are register pokes, not memory stores.
//
// Supported here: ROM-only (Tetris), MBC1 (Zelda, Mario Land 2),
// MBC3 minus the real-time clock (Pokémon Red/Blue).

const RAM_SIZES = [0, 0x800, 0x2000, 0x8000, 0x20000, 0x10000];

export class Cartridge {
  readonly rom: Uint8Array;
  readonly ram: Uint8Array;
  readonly mbc: 0 | 1 | 3;
  readonly title: string;
  ramDirty = false; // set on RAM writes so the UI knows when to persist saves

  private romBank = 1;
  private ramBank = 0;
  private ramEnabled = false;
  private mode = 0; // MBC1 banking mode

  constructor(rom: Uint8Array) {
    if (rom.length < 0x150) throw new Error("File too small to be a Game Boy ROM.");
    this.rom = rom;

    const type = rom[0x147];
    if (type === 0x00 || type === 0x08 || type === 0x09) this.mbc = 0;
    else if (type >= 0x01 && type <= 0x03) this.mbc = 1;
    else if (type >= 0x0f && type <= 0x13) this.mbc = 3;
    else {
      throw new Error(
        `Unsupported mapper (cartridge type 0x${type.toString(16).padStart(2, "0")}). ` +
        `Supported: ROM-only, MBC1, MBC3.`,
      );
    }

    this.ram = new Uint8Array(RAM_SIZES[rom[0x149]] ?? 0);

    let title = "";
    for (let i = 0x134; i < 0x144; i++) {
      const ch = rom[i];
      if (ch === 0) break;
      title += String.fromCharCode(ch);
    }
    this.title = title.trim() || "UNTITLED";
  }

  read(addr: number): number {
    if (addr < 0x4000) return this.rom[addr];
    if (addr < 0x8000) {
      const off = this.romBankBase() + (addr - 0x4000);
      return this.rom[off % this.rom.length];
    }
    // 0xA000-0xBFFF external RAM
    if (!this.ramEnabled || this.ram.length === 0) return 0xff;
    if (this.mbc === 3 && this.ramBank > 3) return 0x00; // RTC registers, unimplemented
    return this.ram[(this.ramBank * 0x2000 + (addr - 0xa000)) % this.ram.length];
  }

  write(addr: number, v: number) {
    if (addr >= 0xa000 && addr < 0xc000) {
      if (!this.ramEnabled || this.ram.length === 0) return;
      if (this.mbc === 3 && this.ramBank > 3) return;
      this.ram[(this.ramBank * 0x2000 + (addr - 0xa000)) % this.ram.length] = v;
      this.ramDirty = true;
      return;
    }
    if (this.mbc === 0) return;

    if (addr < 0x2000) {
      this.ramEnabled = (v & 0x0f) === 0x0a;
    } else if (addr < 0x4000) {
      if (this.mbc === 1) {
        // 5-bit bank number; writing 0 selects 1 (so banks 0x20/0x40/0x60
        // are unreachable — a real MBC1 quirk games had to design around).
        this.romBank = v & 0x1f || 1;
      } else {
        this.romBank = v & 0x7f || 1;
      }
    } else if (addr < 0x6000) {
      this.ramBank = this.mbc === 1 ? v & 0x03 : v & 0x0f;
    } else if (this.mbc === 1) {
      this.mode = v & 1;
    }
    // MBC3 0x6000-0x7FFF is the RTC latch; ignored without an RTC.
  }

  private romBankBase(): number {
    let bank = this.romBank;
    // In MBC1 mode 0 the 2-bit RAM bank register supplies ROM bank bits 5-6.
    if (this.mbc === 1 && this.mode === 0) bank |= this.ramBank << 5;
    return bank * 0x4000;
  }
}
