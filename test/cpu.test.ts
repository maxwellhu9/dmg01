import { describe, expect, it } from "vitest";
import { buildDemoRom } from "../src/demo";
import { GameBoy } from "../src/gameboy";

// Each test hand-assembles a tiny program into work RAM (0xC000), points PC
// at it, and runs until HALT. IE is 0 at boot, so HALT just parks the CPU.
function boot(program: number[]): GameBoy {
  const gb = new GameBoy(buildDemoRom());
  program.forEach((b, i) => gb.bus.write(0xc000 + i, b));
  gb.cpu.pc = 0xc000;
  return gb;
}

function run(gb: GameBoy, maxSteps = 10_000) {
  let n = 0;
  while (!gb.cpu.halted && n++ < maxSteps) gb.cpu.step();
  expect(n).toBeLessThan(maxSteps);
}

const FZ = 0x80, FN = 0x40, FH = 0x20, FC = 0x10;

describe("SM83 core", () => {
  it("ADD sets half-carry across bit 3", () => {
    const gb = boot([0x3e, 0x0f, 0xc6, 0x01, 0x76]); // LD A,0x0F; ADD 0x01; HALT
    run(gb);
    expect(gb.cpu.a).toBe(0x10);
    expect(gb.cpu.f & FH).toBeTruthy();
    expect(gb.cpu.f & (FZ | FN | FC)).toBe(0);
  });

  it("ADC chains the carry and sets Z on wraparound", () => {
    // SCF; LD A,0xFF; ADC 0x00; HALT  →  0xFF + 0 + carry = 0x100
    const gb = boot([0x37, 0x3e, 0xff, 0xce, 0x00, 0x76]);
    run(gb);
    expect(gb.cpu.a).toBe(0x00);
    expect(gb.cpu.f & FZ).toBeTruthy();
    expect(gb.cpu.f & FC).toBeTruthy();
    expect(gb.cpu.f & FH).toBeTruthy();
  });

  it("DAA fixes up BCD addition", () => {
    // LD A,0x45; ADD 0x38; DAA; HALT  →  BCD 45 + 38 = 83
    const gb = boot([0x3e, 0x45, 0xc6, 0x38, 0x27, 0x76]);
    run(gb);
    expect(gb.cpu.a).toBe(0x83);
    expect(gb.cpu.f & FC).toBe(0);
  });

  it("DAA carries out of the top BCD digit", () => {
    // LD A,0x99; ADD 0x01; DAA; HALT  →  BCD 99 + 01 = 100 → A=0x00, C set
    const gb = boot([0x3e, 0x99, 0xc6, 0x01, 0x27, 0x76]);
    run(gb);
    expect(gb.cpu.a).toBe(0x00);
    expect(gb.cpu.f & FZ).toBeTruthy();
    expect(gb.cpu.f & FC).toBeTruthy();
  });

  it("PUSH/POP round-trips through the stack", () => {
    // LD SP,0xDFF0; LD BC,0x1234; PUSH BC; POP DE; HALT
    const gb = boot([0x31, 0xf0, 0xdf, 0x01, 0x34, 0x12, 0xc5, 0xd1, 0x76]);
    run(gb);
    expect(gb.cpu.de).toBe(0x1234);
    expect(gb.cpu.sp).toBe(0xdff0);
  });

  it("POP AF masks the phantom low nibble of F", () => {
    // LD SP,0xDFF0; LD BC,0x12FF; PUSH BC; POP AF; HALT
    const gb = boot([0x31, 0xf0, 0xdf, 0x01, 0xff, 0x12, 0xc5, 0xf1, 0x76]);
    run(gb);
    expect(gb.cpu.a).toBe(0x12);
    expect(gb.cpu.f).toBe(0xf0); // low nibble doesn't exist in hardware
  });

  it("JR with a negative offset loops until the counter hits zero", () => {
    // LD B,3; DEC B; JR NZ,-3; HALT
    const gb = boot([0x06, 0x03, 0x05, 0x20, 0xfd, 0x76]);
    run(gb);
    expect(gb.cpu.b).toBe(0);
  });

  it("CB ops: SWAP, SET, BIT", () => {
    // LD A,0xF0; SWAP A; SET 3,A; BIT 3,A; HALT
    const gb = boot([0x3e, 0xf0, 0xcb, 0x37, 0xcb, 0xdf, 0xcb, 0x5f, 0x76]);
    run(gb);
    expect(gb.cpu.a).toBe(0x0f | 0x08);
    expect(gb.cpu.f & FZ).toBe(0); // bit 3 is set, so Z clear
    expect(gb.cpu.f & FH).toBeTruthy();
  });

  it("ADD SP,e computes flags from unsigned low-byte math", () => {
    // LD SP,0x00FF; ADD SP,+1; HALT → SP=0x0100, H and C both set
    const gb = boot([0x31, 0xff, 0x00, 0xe8, 0x01, 0x76]);
    run(gb);
    expect(gb.cpu.sp).toBe(0x0100);
    expect(gb.cpu.f & FH).toBeTruthy();
    expect(gb.cpu.f & FC).toBeTruthy();
    expect(gb.cpu.f & FZ).toBe(0);
  });

  it("EI; HALT with an already-pending interrupt dispatches cleanly", () => {
    // Regression: this exact race crashed Tobu Tobu Girl. The pending
    // interrupt must NOT trigger the halt bug (EI's delayed enable counts),
    // so the handler's first instruction runs exactly once and INC B here
    // runs exactly once after RETI.
    const gb = boot([0xfb, 0x76, 0x04, 0x76]); // EI; HALT; INC B; HALT
    gb.bus.write(0xff0f, 0x01); // VBlank already pending before EI
    gb.bus.write(0xffff, 0x01);
    for (let i = 0; i < 12 && !(gb.cpu.halted && gb.cpu.pc === 0xc004); i++) {
      gb.cpu.step();
    }
    expect(gb.cpu.b).toBe(1); // ran once — a doubled handler op would derail this
    expect(gb.cpu.pc).toBe(0xc004); // parked at the second HALT
    expect(gb.cpu.ime).toBe(true);
  });

  it("EI immediately followed by DI leaves interrupts disabled", () => {
    const gb = boot([0xfb, 0xf3, 0x00, 0x76]); // EI; DI; NOP; HALT
    gb.bus.write(0xff0f, 0x00);
    run(gb);
    expect(gb.cpu.ime).toBe(false);
  });

  it("services an interrupt: jumps to the vector, RETI comes back", () => {
    const gb = boot([0xfb, 0x00, 0x00, 0x76]); // EI; NOP; NOP; HALT
    gb.bus.write(0xff0f, 0x00); // clear the post-boot pending VBlank
    gb.bus.write(0xffff, 0x01); // enable VBlank

    gb.cpu.step(); // EI (takes effect after next instruction)
    gb.cpu.step(); // NOP → IME now on
    gb.ints.flags |= 0x01; // request VBlank
    gb.cpu.step(); // dispatch
    expect(gb.cpu.pc).toBe(0x40);
    expect(gb.cpu.ime).toBe(false);

    gb.cpu.step(); // RETI in the demo ROM's vector
    expect(gb.cpu.pc).toBe(0xc002); // back to the second NOP's address
    expect(gb.cpu.ime).toBe(true);
  });
});

describe("timer", () => {
  it("TIMA overflow reloads from TMA and requests the interrupt", () => {
    const gb = new GameBoy(buildDemoRom());
    gb.bus.write(0xff0f, 0x00);
    gb.bus.write(0xff07, 0x05); // enabled, 262144 Hz → every 16 cycles
    gb.bus.write(0xff05, 0xff); // TIMA one tick from overflow
    gb.bus.write(0xff06, 0x42); // TMA reload value
    gb.timer.tick(16);
    expect(gb.timer.tima).toBe(0x42);
    expect(gb.ints.flags & 0x04).toBeTruthy();
  });
});

describe("serial", () => {
  it("captures bytes written out the link port", () => {
    const gb = new GameBoy(buildDemoRom());
    gb.bus.write(0xff01, "H".charCodeAt(0));
    gb.bus.write(0xff02, 0x81);
    gb.bus.write(0xff01, "i".charCodeAt(0));
    gb.bus.write(0xff02, 0x81);
    expect(gb.serial.output).toBe("Hi");
  });
});
