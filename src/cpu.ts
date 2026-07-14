import type { Bus } from "./bus";

// The Game Boy CPU is a Sharp SM83: an 8080-family core (often mislabeled
// "a Z80") clocked at 4.194304 MHz. All timings in this file are T-cycles.
//
// Instead of a 512-entry opcode table, we decode by bit pattern. Every
// opcode splits into fields  x = op>>6, y = (op>>3)&7, z = op&7  and the
// instruction set is regular in those fields (e.g. all of 0x40-0x7F is
// "LD r[y], r[z]"). See https://izik1.github.io/gbops for the full map.

// Flag bits in F. The low nibble of F does not physically exist: it always
// reads 0, which is why POP AF and LD A/F ops mask with 0xF0.
const FZ = 0x80; // zero
const FN = 0x40; // subtract (only DAA reads this)
const FH = 0x20; // half-carry (carry out of bit 3; only DAA reads this)
const FC = 0x10; // carry

// Interrupt vectors in priority order: VBlank, STAT, Timer, Serial, Joypad.
const VECTORS = [0x40, 0x48, 0x50, 0x58, 0x60];

export class CPU {
  // Register values after the DMG boot ROM hands control to the cartridge.
  // We don't emulate the boot ROM itself, so we start from this state.
  a = 0x01;
  f = 0xb0;
  b = 0x00;
  c = 0x13;
  d = 0x00;
  e = 0xd8;
  h = 0x01;
  l = 0x4d;
  sp = 0xfffe;
  pc = 0x0100;

  ime = false; // interrupt master enable
  halted = false;
  private eiPending = false; // set by EI: enable IME one instruction late
  private imeNext = false; // the delayed enable lands after the current instruction
  private haltBug = false; // HALT with IME=0 + pending int reads next byte twice

  constructor(private bus: Bus) {}

  get bc() { return (this.b << 8) | this.c; }
  set bc(v: number) { this.b = (v >> 8) & 0xff; this.c = v & 0xff; }
  get de() { return (this.d << 8) | this.e; }
  set de(v: number) { this.d = (v >> 8) & 0xff; this.e = v & 0xff; }
  get hl() { return (this.h << 8) | this.l; }
  set hl(v: number) { this.h = (v >> 8) & 0xff; this.l = v & 0xff; }
  get af() { return (this.a << 8) | this.f; }
  set af(v: number) { this.a = (v >> 8) & 0xff; this.f = v & 0xf0; }

  // Executes one instruction (or services one interrupt) and returns the
  // T-cycles it took. The rest of the machine advances by the same amount.
  step(): number {
    const pending = this.bus.ints.enable & this.bus.ints.flags & 0x1f;
    if (pending) {
      this.halted = false;
      if (this.ime) return this.serviceInterrupt(pending);
    }
    if (this.halted) return 4;

    this.imeNext = this.eiPending;
    this.eiPending = false;

    const op = this.fetch8();
    if (this.haltBug) {
      // The halt bug: PC fails to increment, so the byte after HALT
      // is executed twice.
      this.pc = (this.pc - 1) & 0xffff;
      this.haltBug = false;
    }
    const cycles = this.exec(op);

    if (this.imeNext) {
      this.ime = true;
      this.imeNext = false;
    }
    return cycles;
  }

  private serviceInterrupt(pending: number): number {
    // Lowest set bit = highest priority interrupt.
    const n = 31 - Math.clz32(pending & -pending);
    this.ime = false;
    this.haltBug = false; // a latched halt bug must not leak into the handler
    this.bus.ints.flags &= ~(1 << n);
    this.push16(this.pc);
    this.pc = VECTORS[n];
    return 20;
  }

  // ---- memory helpers ----

  private fetch8(): number {
    const v = this.bus.read(this.pc);
    this.pc = (this.pc + 1) & 0xffff;
    return v;
  }

  private fetch16(): number {
    const lo = this.fetch8();
    return lo | (this.fetch8() << 8);
  }

  private push16(v: number) {
    this.sp = (this.sp - 1) & 0xffff;
    this.bus.write(this.sp, (v >> 8) & 0xff);
    this.sp = (this.sp - 1) & 0xffff;
    this.bus.write(this.sp, v & 0xff);
  }

  private pop16(): number {
    const lo = this.bus.read(this.sp);
    this.sp = (this.sp + 1) & 0xffff;
    const hi = this.bus.read(this.sp);
    this.sp = (this.sp + 1) & 0xffff;
    return (hi << 8) | lo;
  }

  // ---- operand tables ----
  // r[i] for i=0..7 means B, C, D, E, H, L, (HL), A. Index 6 is a memory
  // access through HL, which is why those variants cost 4 extra cycles.

  private getR(i: number): number {
    switch (i) {
      case 0: return this.b;
      case 1: return this.c;
      case 2: return this.d;
      case 3: return this.e;
      case 4: return this.h;
      case 5: return this.l;
      case 6: return this.bus.read(this.hl);
      default: return this.a;
    }
  }

  private setR(i: number, v: number) {
    switch (i) {
      case 0: this.b = v; break;
      case 1: this.c = v; break;
      case 2: this.d = v; break;
      case 3: this.e = v; break;
      case 4: this.h = v; break;
      case 5: this.l = v; break;
      case 6: this.bus.write(this.hl, v); break;
      default: this.a = v;
    }
  }

  // rp[p]: BC, DE, HL, SP (used by 16-bit loads/arithmetic)
  private getRP(p: number): number {
    switch (p) {
      case 0: return this.bc;
      case 1: return this.de;
      case 2: return this.hl;
      default: return this.sp;
    }
  }

  private setRP(p: number, v: number) {
    switch (p) {
      case 0: this.bc = v; break;
      case 1: this.de = v; break;
      case 2: this.hl = v; break;
      default: this.sp = v;
    }
  }

  // rp2[p]: BC, DE, HL, AF (used by PUSH/POP)
  private getRP2(p: number): number {
    return p === 3 ? this.af : this.getRP(p);
  }

  private setRP2(p: number, v: number) {
    if (p === 3) this.af = v;
    else this.setRP(p, v);
  }

  private flag(mask: number, on: boolean) {
    this.f = on ? this.f | mask : this.f & ~mask & 0xf0;
  }

  // cc[i]: NZ, Z, NC, C
  private cond(i: number): boolean {
    switch (i) {
      case 0: return (this.f & FZ) === 0;
      case 1: return (this.f & FZ) !== 0;
      case 2: return (this.f & FC) === 0;
      default: return (this.f & FC) !== 0;
    }
  }

  // ---- 8-bit ALU ----

  private add(v: number, withCarry: boolean) {
    const c = withCarry && this.f & FC ? 1 : 0;
    const a = this.a;
    const r = a + v + c;
    this.flag(FZ, (r & 0xff) === 0);
    this.flag(FN, false);
    this.flag(FH, (a & 0xf) + (v & 0xf) + c > 0xf);
    this.flag(FC, r > 0xff);
    this.a = r & 0xff;
  }

  private sub(v: number, withCarry: boolean, store: boolean) {
    const c = withCarry && this.f & FC ? 1 : 0;
    const a = this.a;
    const r = a - v - c;
    this.flag(FZ, (r & 0xff) === 0);
    this.flag(FN, true);
    this.flag(FH, (a & 0xf) - (v & 0xf) - c < 0);
    this.flag(FC, r < 0);
    if (store) this.a = r & 0xff;
  }

  // alu[y]: ADD, ADC, SUB, SBC, AND, XOR, OR, CP
  private alu(y: number, v: number) {
    switch (y) {
      case 0: this.add(v, false); break;
      case 1: this.add(v, true); break;
      case 2: this.sub(v, false, true); break;
      case 3: this.sub(v, true, true); break;
      case 4:
        this.a &= v;
        this.f = (this.a === 0 ? FZ : 0) | FH;
        break;
      case 5:
        this.a ^= v;
        this.f = this.a === 0 ? FZ : 0;
        break;
      case 6:
        this.a |= v;
        this.f = this.a === 0 ? FZ : 0;
        break;
      default: this.sub(v, false, false); // CP: compare = SUB that discards
    }
  }

  // Decimal Adjust: patches A back into packed BCD after an add/subtract.
  // The only instruction that reads the N and H flags.
  private daa() {
    let a = this.a;
    if (this.f & FN) {
      if (this.f & FC) a = (a - 0x60) & 0xff;
      if (this.f & FH) a = (a - 0x06) & 0xff;
    } else {
      if (this.f & FC || a > 0x99) {
        a += 0x60;
        this.flag(FC, true);
      }
      if (this.f & FH || (a & 0x0f) > 0x09) a += 0x06;
    }
    a &= 0xff;
    this.a = a;
    this.flag(FZ, a === 0);
    this.flag(FH, false);
  }

  // ADD SP,e and LD HL,SP+e: flags come from *unsigned byte* math on the
  // low byte even though the operand is signed. Z is always cleared.
  private addSPe(e: number): number {
    const sp = this.sp;
    this.flag(FZ, false);
    this.flag(FN, false);
    this.flag(FH, (sp & 0xf) + (e & 0xf) > 0xf);
    this.flag(FC, (sp & 0xff) + (e & 0xff) > 0xff);
    return (sp + e) & 0xffff;
  }

  // The four A-register rotates (RLCA etc.) always clear Z; the CB-prefixed
  // versions of the same operations set Z from the result.
  private rotAFlags(carry: number) {
    this.f = carry ? FC : 0;
  }

  // rot[y]: RLC, RRC, RL, RR, SLA, SRA, SWAP, SRL (CB-prefixed, x=0)
  private rot(y: number, v: number): number {
    let r: number;
    let c: number;
    switch (y) {
      case 0: c = v >> 7; r = ((v << 1) | c) & 0xff; break;
      case 1: c = v & 1; r = (v >> 1) | (c << 7); break;
      case 2: c = v >> 7; r = ((v << 1) | (this.f & FC ? 1 : 0)) & 0xff; break;
      case 3: c = v & 1; r = (v >> 1) | (this.f & FC ? 0x80 : 0); break;
      case 4: c = v >> 7; r = (v << 1) & 0xff; break;
      case 5: c = v & 1; r = (v >> 1) | (v & 0x80); break; // arithmetic: keeps sign bit
      case 6: c = 0; r = ((v << 4) | (v >> 4)) & 0xff; break;
      default: c = v & 1; r = v >> 1;
    }
    this.f = (r === 0 ? FZ : 0) | (c ? FC : 0);
    return r;
  }

  // ---- decode & execute ----

  private exec(op: number): number {
    const x = op >> 6;
    const y = (op >> 3) & 7;
    const z = op & 7;
    const p = y >> 1;
    const q = y & 1;

    if (x === 1) {
      if (op === 0x76) {
        // HALT sits where "LD (HL),(HL)" would be. The halt bug only
        // triggers when IME is *and stays* off: after "EI; HALT" the
        // delayed enable counts, and the interrupt dispatches normally.
        if (!this.ime && !this.imeNext && this.bus.ints.enable & this.bus.ints.flags & 0x1f) {
          this.haltBug = true;
        } else {
          this.halted = true;
        }
        return 4;
      }
      this.setR(y, this.getR(z)); // LD r,r'
      return y === 6 || z === 6 ? 8 : 4;
    }

    if (x === 2) {
      this.alu(y, this.getR(z));
      return z === 6 ? 8 : 4;
    }

    return x === 0 ? this.execX0(y, z, p, q) : this.execX3(op, y, z, p, q);
  }

  private execX0(y: number, z: number, p: number, q: number): number {
    switch (z) {
      case 0:
        switch (y) {
          case 0: return 4; // NOP
          case 1: { // LD (nn),SP
            const addr = this.fetch16();
            this.bus.write(addr, this.sp & 0xff);
            this.bus.write((addr + 1) & 0xffff, this.sp >> 8);
            return 20;
          }
          case 2: // STOP: enters very-low-power mode; encoded with a pad byte
            this.fetch8();
            return 4;
          case 3: { // JR e
            const e = (this.fetch8() << 24) >> 24; // sign-extend
            this.pc = (this.pc + e) & 0xffff;
            return 12;
          }
          default: { // JR cc,e
            const e = (this.fetch8() << 24) >> 24;
            if (this.cond(y - 4)) {
              this.pc = (this.pc + e) & 0xffff;
              return 12;
            }
            return 8;
          }
        }
      case 1:
        if (q === 0) { // LD rp,nn
          this.setRP(p, this.fetch16());
          return 12;
        }
        { // ADD HL,rp (Z untouched)
          const v = this.getRP(p);
          const hl = this.hl;
          const r = hl + v;
          this.flag(FN, false);
          this.flag(FH, (hl & 0xfff) + (v & 0xfff) > 0xfff);
          this.flag(FC, r > 0xffff);
          this.hl = r & 0xffff;
          return 8;
        }
      case 2: { // LD between A and (BC)/(DE)/(HL+)/(HL-)
        const addr = p === 0 ? this.bc : p === 1 ? this.de : this.hl;
        if (q === 0) this.bus.write(addr, this.a);
        else this.a = this.bus.read(addr);
        if (p === 2) this.hl = (this.hl + 1) & 0xffff;
        else if (p === 3) this.hl = (this.hl - 1) & 0xffff;
        return 8;
      }
      case 3: // INC/DEC rp (no flags — 16-bit inc/dec never touches F)
        this.setRP(p, (this.getRP(p) + (q === 0 ? 1 : -1)) & 0xffff);
        return 8;
      case 4: { // INC r (C untouched)
        const v = this.getR(y);
        const r = (v + 1) & 0xff;
        this.flag(FZ, r === 0);
        this.flag(FN, false);
        this.flag(FH, (v & 0xf) === 0xf);
        this.setR(y, r);
        return y === 6 ? 12 : 4;
      }
      case 5: { // DEC r (C untouched)
        const v = this.getR(y);
        const r = (v - 1) & 0xff;
        this.flag(FZ, r === 0);
        this.flag(FN, true);
        this.flag(FH, (v & 0xf) === 0);
        this.setR(y, r);
        return y === 6 ? 12 : 4;
      }
      case 6: // LD r,n
        this.setR(y, this.fetch8());
        return y === 6 ? 12 : 8;
      default: // z=7: accumulator/flag ops
        switch (y) {
          case 0: { // RLCA
            const c = this.a >> 7;
            this.a = ((this.a << 1) | c) & 0xff;
            this.rotAFlags(c);
            return 4;
          }
          case 1: { // RRCA
            const c = this.a & 1;
            this.a = (this.a >> 1) | (c << 7);
            this.rotAFlags(c);
            return 4;
          }
          case 2: { // RLA
            const c = this.a >> 7;
            this.a = ((this.a << 1) | (this.f & FC ? 1 : 0)) & 0xff;
            this.rotAFlags(c);
            return 4;
          }
          case 3: { // RRA
            const c = this.a & 1;
            this.a = (this.a >> 1) | (this.f & FC ? 0x80 : 0);
            this.rotAFlags(c);
            return 4;
          }
          case 4:
            this.daa();
            return 4;
          case 5: // CPL
            this.a ^= 0xff;
            this.flag(FN, true);
            this.flag(FH, true);
            return 4;
          case 6: // SCF
            this.flag(FC, true);
            this.flag(FN, false);
            this.flag(FH, false);
            return 4;
          default: // CCF
            this.flag(FC, (this.f & FC) === 0);
            this.flag(FN, false);
            this.flag(FH, false);
            return 4;
        }
    }
  }

  private execX3(op: number, y: number, z: number, p: number, q: number): number {
    switch (z) {
      case 0:
        switch (y) {
          case 4: // LDH (n),A — write to high page 0xFF00+n
            this.bus.write(0xff00 | this.fetch8(), this.a);
            return 12;
          case 5: { // ADD SP,e
            const e = (this.fetch8() << 24) >> 24;
            this.sp = this.addSPe(e);
            return 16;
          }
          case 6: // LDH A,(n)
            this.a = this.bus.read(0xff00 | this.fetch8());
            return 12;
          case 7: { // LD HL,SP+e
            const e = (this.fetch8() << 24) >> 24;
            this.hl = this.addSPe(e);
            return 12;
          }
          default: // RET cc
            if (this.cond(y)) {
              this.pc = this.pop16();
              return 20;
            }
            return 8;
        }
      case 1:
        if (q === 0) { // POP rp2
          this.setRP2(p, this.pop16());
          return 12;
        }
        switch (p) {
          case 0: // RET
            this.pc = this.pop16();
            return 16;
          case 1: // RETI — unlike EI, enables interrupts immediately
            this.pc = this.pop16();
            this.ime = true;
            return 16;
          case 2: // JP HL
            this.pc = this.hl;
            return 4;
          default: // LD SP,HL
            this.sp = this.hl;
            return 8;
        }
      case 2:
        switch (y) {
          case 4: // LD (0xFF00+C),A
            this.bus.write(0xff00 | this.c, this.a);
            return 8;
          case 5: // LD (nn),A
            this.bus.write(this.fetch16(), this.a);
            return 16;
          case 6: // LD A,(0xFF00+C)
            this.a = this.bus.read(0xff00 | this.c);
            return 8;
          case 7: // LD A,(nn)
            this.a = this.bus.read(this.fetch16());
            return 16;
          default: { // JP cc,nn
            const addr = this.fetch16();
            if (this.cond(y)) {
              this.pc = addr;
              return 16;
            }
            return 12;
          }
        }
      case 3:
        switch (op) {
          case 0xc3: // JP nn
            this.pc = this.fetch16();
            return 16;
          case 0xcb:
            return this.execCB();
          case 0xf3: // DI (also cancels a pending EI, even mid-delay)
            this.ime = false;
            this.eiPending = false;
            this.imeNext = false;
            return 4;
          case 0xfb: // EI — takes effect after the *next* instruction
            this.eiPending = true;
            return 4;
          default: // 0xD3/0xDB/0xE3/0xE4... don't exist; real hardware locks up
            return 4;
        }
      case 4: { // CALL cc,nn
        if (y >= 4) return 4; // illegal opcodes 0xE4/0xEC/0xF4/0xFC
        const addr = this.fetch16();
        if (this.cond(y)) {
          this.push16(this.pc);
          this.pc = addr;
          return 24;
        }
        return 12;
      }
      case 5:
        if (q === 0) { // PUSH rp2
          this.push16(this.getRP2(p));
          return 16;
        }
        if (p === 0) { // CALL nn
          const addr = this.fetch16();
          this.push16(this.pc);
          this.pc = addr;
          return 24;
        }
        return 4; // illegal 0xDD/0xED/0xFD (no Z80-style prefixes here)
      case 6: // ALU A,n
        this.alu(y, this.fetch8());
        return 8;
      default: // RST — one-byte call to a fixed low address
        this.push16(this.pc);
        this.pc = y * 8;
        return 16;
    }
  }

  // 0xCB prefix: a second, fully regular opcode space for bit operations.
  private execCB(): number {
    const op = this.fetch8();
    const x = op >> 6;
    const y = (op >> 3) & 7;
    const z = op & 7;

    if (x === 0) { // rotates/shifts
      this.setR(z, this.rot(y, this.getR(z)));
      return z === 6 ? 16 : 8;
    }
    if (x === 1) { // BIT y,r — test only, so (HL) variant skips the write-back
      this.flag(FZ, (this.getR(z) & (1 << y)) === 0);
      this.flag(FN, false);
      this.flag(FH, true);
      return z === 6 ? 12 : 8;
    }
    if (x === 2) { // RES y,r
      this.setR(z, this.getR(z) & ~(1 << y) & 0xff);
      return z === 6 ? 16 : 8;
    }
    this.setR(z, this.getR(z) | (1 << y)); // SET y,r
    return z === 6 ? 16 : 8;
  }
}
