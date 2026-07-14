import { describe, expect, it } from "vitest";
import { buildDemoRom } from "../src/demo";
import { GameBoy } from "../src/gameboy";

function freshGB(): GameBoy {
  const gb = new GameBoy(buildDemoRom());
  gb.apu.setSampleRate(48000);
  return gb;
}

// Route everything everywhere at full volume, then set up channel 2
// (square, no sweep) the way a game would.
function playSquare(gb: GameBoy) {
  gb.bus.write(0xff26, 0x80); // power on
  gb.bus.write(0xff25, 0xff); // all channels to both sides
  gb.bus.write(0xff24, 0x77); // max master volume
  gb.bus.write(0xff17, 0xf0); // volume 15, no envelope
  gb.bus.write(0xff18, 0x00); // frequency low byte
  gb.bus.write(0xff19, 0x87); // trigger + frequency high bits
}

describe("APU", () => {
  it("a triggered square channel produces a non-silent waveform", () => {
    const gb = freshGB();
    playSquare(gb);
    gb.apu.tick(70224);
    const s = gb.apu.pullSamples();
    expect(s.length).toBeGreaterThan(1500); // ~one frame of stereo samples
    const min = Math.min(...s);
    const max = Math.max(...s);
    expect(max).toBeGreaterThan(0.01); // swings both ways => a real wave,
    expect(min).toBeLessThan(-0.01); //   not a stuck DC level
  });

  it("reports channel status in NR52", () => {
    const gb = freshGB();
    playSquare(gb);
    expect(gb.bus.read(0xff26) & 0x02).toBeTruthy(); // CH2 on
    expect(gb.bus.read(0xff26) & 0x80).toBeTruthy(); // power on
  });

  it("the length counter silences the channel", () => {
    const gb = freshGB();
    playSquare(gb);
    gb.bus.write(0xff16, 0x3f); // length load 63 -> counts down from 1
    gb.bus.write(0xff19, 0xc7); // retrigger with length enabled
    gb.apu.tick(16384 * 2); // > one 256 Hz length tick
    expect(gb.bus.read(0xff26) & 0x02).toBe(0);
  });

  it("the envelope decays volume to zero", () => {
    const gb = freshGB();
    playSquare(gb);
    gb.bus.write(0xff17, 0xf1); // volume 15, decreasing, period 1
    gb.bus.write(0xff19, 0x87);
    gb.apu.tick(65536 * 16); // 16 envelope ticks at 64 Hz
    expect(gb.apu.ch2.volume).toBe(0);
    expect(gb.bus.read(0xff26) & 0x02).toBeTruthy(); // still on, just silent
  });

  it("powering the APU off clears registers and kills channels", () => {
    const gb = freshGB();
    playSquare(gb);
    gb.bus.write(0xff26, 0x00);
    expect(gb.bus.read(0xff26) & 0x0f).toBe(0);
    gb.bus.write(0xff17, 0xf0); // writes are dead while off
    expect(gb.bus.read(0xff17)).toBe(0x00);
  });

  it("noise channel runs and reports status", () => {
    const gb = freshGB();
    gb.bus.write(0xff26, 0x80);
    gb.bus.write(0xff25, 0xff);
    gb.bus.write(0xff24, 0x77);
    gb.bus.write(0xff21, 0xf0); // volume 15
    gb.bus.write(0xff22, 0x00); // fastest clock
    gb.bus.write(0xff23, 0x80); // trigger
    gb.apu.tick(70224);
    expect(gb.bus.read(0xff26) & 0x08).toBeTruthy();
    const s = gb.apu.pullSamples();
    expect(Math.max(...s)).toBeGreaterThan(0.01);
  });
});
