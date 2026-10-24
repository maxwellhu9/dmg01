import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildDemoRom } from "../src/demo";
import { GameBoy } from "../src/gameboy";
import { Rewind } from "../src/savestate";

const run = (gb: GameBoy, n: number) => { for (let i = 0; i < n; i++) gb.runFrame(); };
const screen = (gb: GameBoy) => Array.from(gb.ppu.framebuffer);

// The real test of a save state: load it, replay the same stretch of time,
// and land on exactly the same pixels and CPU state. If any piece of the
// machine's state were missing from the snapshot, the two runs would drift.
function replaysIdentically(rom: Uint8Array, warmup: number, span: number) {
  const gb = new GameBoy(rom);
  run(gb, warmup);
  const snap = gb.saveState();
  run(gb, span);
  const first = { screen: screen(gb), pc: gb.cpu.pc, sp: gb.cpu.sp, ly: gb.ppu.ly };
  gb.loadState(snap);
  run(gb, span);
  expect({ screen: screen(gb), pc: gb.cpu.pc, sp: gb.cpu.sp, ly: gb.ppu.ly }).toEqual(first);
}

describe("save states", () => {
  it("loading restores the exact moment, and replays identically", () => {
    replaysIdentically(buildDemoRom(), 30, 120);
  });

  it("loading puts the old picture back on screen immediately", () => {
    const gb = new GameBoy(buildDemoRom());
    run(gb, 20);
    const snap = gb.saveState();
    const before = screen(gb);
    run(gb, 60);                       // the demo keeps scrolling
    expect(screen(gb)).not.toEqual(before);
    gb.loadState(snap);
    expect(screen(gb)).toEqual(before);
  });

  it("a snapshot is a copy, not a live view of the machine", () => {
    const gb = new GameBoy(buildDemoRom());
    run(gb, 10);
    const snap = gb.saveState();
    const saved = JSON.stringify(snap.cpu);
    run(gb, 30);
    expect(JSON.stringify(snap.cpu)).toBe(saved);
  });
});

describe("rewind", () => {
  it("steps back through recent history, newest first", () => {
    const gb = new GameBoy(buildDemoRom());
    const rewind = new Rewind(4, 150);
    const marks: number[][] = [];
    for (let i = 1; i <= 40; i++) {
      gb.runFrame();
      rewind.record(() => gb.saveState());
      if (i % 4 === 0) marks.push(screen(gb));
    }
    for (let k = marks.length - 1; k >= 0; k--) {
      gb.loadState(rewind.back()!);
      expect(screen(gb)).toEqual(marks[k]);
    }
    expect(rewind.back()).toBeUndefined();   // ran out of history
  });

  it("only keeps the most recent history", () => {
    const rewind = new Rewind(1, 5);
    for (let i = 0; i < 20; i++) rewind.record(() => ({ i }));
    expect(rewind.back()).toEqual({ i: 19 });
    expect(rewind.seconds).toBeCloseTo(4 / 60);
  });
});

describe("save states on Game Boy Color hardware", () => {
  // Bundled with the site, so this always runs. It switches the CPU to
  // double speed and uses banked memory, which all has to survive a load.
  it("Fortune & Glory replays identically after a load", () => {
    const rom = new Uint8Array(readFileSync("public/fortune-and-glory.gbc"));
    replaysIdentically(rom, 400, 200);
  });
});

const TOBU = "games/tobu.gb";
describe.skipIf(!existsSync(TOBU))("save states on a real game", () => {
  it("Tobu Tobu Girl replays identically after a load", () => {
    replaysIdentically(new Uint8Array(readFileSync(TOBU)), 600, 300);
  });
});
