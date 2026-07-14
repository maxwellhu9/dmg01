import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildDemoRom } from "../src/demo";
import { GameBoy } from "../src/gameboy";

describe("demo ROM end to end", () => {
  it("boots, draws the pattern, and scrolls via the VBlank interrupt", () => {
    const gb = new GameBoy(buildDemoRom());
    for (let i = 0; i < 10; i++) gb.runFrame();

    // The HALT + VBlank main loop should have bumped SCX/SCY most frames.
    expect(gb.bus.read(0xff43)).toBeGreaterThan(4);
    expect(gb.bus.read(0xff42)).toBe(gb.bus.read(0xff43));

    // The framebuffer should contain more than one shade.
    const shades = new Set<number>();
    for (let i = 0; i < gb.ppu.framebuffer.length; i += 4) {
      shades.add(gb.ppu.framebuffer[i]);
    }
    expect(shades.size).toBeGreaterThan(1);
  });
});

// Drop Blargg's test ROMs into roms/ to enable this suite:
//   git clone https://github.com/retrio/gb-test-roms roms/gb-test-roms
// The ROM prints its results over the serial port as ASCII.
const CPU_INSTRS = "roms/gb-test-roms/cpu_instrs/cpu_instrs.gb";

describe.skipIf(!existsSync(CPU_INSTRS))("blargg cpu_instrs", () => {
  it("passes the full instruction test suite", () => {
    const rom = new Uint8Array(readFileSync(CPU_INSTRS));
    const gb = new GameBoy(rom);
    // The suite needs a minute-plus of emulated time; bail once it prints a verdict.
    for (let frame = 0; frame < 10_000; frame++) {
      gb.runFrame();
      if (/Passed|Failed/.test(gb.serial.output)) break;
    }
    console.log(`\n${gb.serial.output}\n`);
    expect(gb.serial.output).toContain("Passed");
  }, 120_000);
});
