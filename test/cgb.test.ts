import { describe, expect, it } from "vitest";
import { GameBoy } from "../src/gameboy";

// A minimal cartridge header we can point at any mapper / hardware flag.
function makeRom(opts: { cgbFlag?: number; type?: number; banks?: number } = {}): Uint8Array {
  const banks = opts.banks ?? 4;
  const rom = new Uint8Array(banks * 0x4000);
  rom[0x100] = 0x00;
  rom[0x101] = 0xc3; // JP 0x0150
  rom[0x102] = 0x50;
  rom[0x103] = 0x01;
  rom[0x143] = opts.cgbFlag ?? 0x00;
  rom[0x147] = opts.type ?? 0x00;
  rom[0x149] = 0x02; // 8KB cart RAM
  rom[0x150] = 0x76; // HALT
  // Stamp each bank so we can tell which one is mapped in.
  for (let b = 0; b < banks; b++) rom[b * 0x4000 + 0x10] = b;
  return rom;
}

describe("Game Boy Color mode", () => {
  it("stays in mono mode for a plain DMG cartridge", () => {
    const gb = new GameBoy(makeRom());
    expect(gb.cart.cgb).toBe(false);
    expect(gb.ppu.cgb).toBe(false);
    expect(gb.cpu.a).toBe(0x01); // DMG boot value
    expect(gb.bus.read(0xff4f)).toBe(0xff); // banking registers read as absent
  });

  it("enters color mode and reports Color hardware to the game", () => {
    const gb = new GameBoy(makeRom({ cgbFlag: 0xc0 }));
    expect(gb.cart.cgb).toBe(true);
    expect(gb.cart.cgbOnly).toBe(true);
    // Games check A at startup to find out what they are running on.
    expect(gb.cpu.a).toBe(0x11);
  });

  it("banks VRAM so the two banks hold different bytes", () => {
    const gb = new GameBoy(makeRom({ cgbFlag: 0x80 }));
    gb.bus.write(0xff4f, 0); // bank 0
    gb.bus.write(0x8000, 0xaa);
    gb.bus.write(0xff4f, 1); // bank 1
    gb.bus.write(0x8000, 0x55);
    expect(gb.bus.read(0x8000)).toBe(0x55);
    gb.bus.write(0xff4f, 0);
    expect(gb.bus.read(0x8000)).toBe(0xaa);
  });

  it("banks the upper half of work RAM, with bank 0 aliased to 1", () => {
    const gb = new GameBoy(makeRom({ cgbFlag: 0x80 }));
    gb.bus.write(0xff70, 1);
    gb.bus.write(0xd000, 0x11);
    gb.bus.write(0xff70, 2);
    gb.bus.write(0xd000, 0x22);
    expect(gb.bus.read(0xd000)).toBe(0x22);
    gb.bus.write(0xff70, 0); // 0 means bank 1 on real hardware
    expect(gb.bus.read(0xd000)).toBe(0x11);
    // 0xC000 is always bank 0 regardless of SVBK.
    gb.bus.write(0xc000, 0x99);
    gb.bus.write(0xff70, 3);
    expect(gb.bus.read(0xc000)).toBe(0x99);
  });

  it("writes color palettes through the auto-incrementing index register", () => {
    const gb = new GameBoy(makeRom({ cgbFlag: 0x80 }));
    gb.bus.write(0xff68, 0x80); // index 0, auto-increment on
    gb.bus.write(0xff69, 0x1f); // color 0 low byte  (pure red, 15-bit)
    gb.bus.write(0xff69, 0x00); // color 0 high byte
    gb.bus.write(0xff68, 0x00); // rewind index, no increment
    expect(gb.bus.read(0xff69)).toBe(0x1f);
    gb.bus.write(0xff68, 0x01);
    expect(gb.bus.read(0xff69)).toBe(0x00);
  });

  it("switches to double speed only when the game asks before STOP", () => {
    const gb = new GameBoy(makeRom({ cgbFlag: 0x80 }));
    expect(gb.bus.doubleSpeed).toBe(false);
    // STOP with no request pending changes nothing.
    gb.bus.trySpeedSwitch();
    expect(gb.bus.doubleSpeed).toBe(false);
    gb.bus.write(0xff4d, 0x01); // arm the switch
    gb.bus.trySpeedSwitch(); // what STOP does
    expect(gb.bus.doubleSpeed).toBe(true);
    expect(gb.bus.read(0xff4d) & 0x80).toBeTruthy();
  });

  it("copies VRAM with a general-purpose HDMA transfer", () => {
    const gb = new GameBoy(makeRom({ cgbFlag: 0x80 }));
    for (let i = 0; i < 16; i++) gb.bus.write(0xc000 + i, i + 1);
    gb.bus.write(0xff51, 0xc0); // source 0xC000
    gb.bus.write(0xff52, 0x00);
    gb.bus.write(0xff53, 0x00); // destination 0x8000
    gb.bus.write(0xff54, 0x00);
    gb.bus.write(0xff55, 0x00); // one 16-byte block, start now
    for (let i = 0; i < 16; i++) expect(gb.bus.read(0x8000 + i)).toBe(i + 1);
    expect(gb.bus.read(0xff55)).toBe(0xff); // no transfer still running
  });
});

describe("MBC5", () => {
  it("selects ROM banks, including bank 0", () => {
    const gb = new GameBoy(makeRom({ type: 0x1b, banks: 4 }));
    expect(gb.cart.mbc).toBe(5);
    gb.bus.write(0x2000, 2);
    expect(gb.bus.read(0x4010)).toBe(2);
    gb.bus.write(0x2000, 3);
    expect(gb.bus.read(0x4010)).toBe(3);
    // Unlike MBC1, selecting bank 0 really gives you bank 0.
    gb.bus.write(0x2000, 0);
    expect(gb.bus.read(0x4010)).toBe(0);
  });

  it("reads and writes battery RAM once enabled", () => {
    const gb = new GameBoy(makeRom({ type: 0x1b }));
    expect(gb.bus.read(0xa000)).toBe(0xff); // disabled by default
    gb.bus.write(0x0000, 0x0a); // enable
    gb.bus.write(0xa000, 0x42);
    expect(gb.bus.read(0xa000)).toBe(0x42);
    expect(gb.cart.ramDirty).toBe(true);
  });
});
