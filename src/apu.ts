// The APU: four independent sound channels mixed into stereo.
//   CH1: square wave with frequency sweep + volume envelope  (lead / effects)
//   CH2: square wave with volume envelope                    (harmony)
//   CH3: 32-sample 4-bit wavetable                           (bass / voices)
//   CH4: LFSR noise with volume envelope                     (drums / hits)
//
// A "frame sequencer" ticks 512 times a second and clocks the slow parts:
// length counters at 256 Hz, the sweep at 128 Hz, envelopes at 64 Hz. The
// channels' waveform timers run at the full 4.19 MHz; we resample down to
// the host sample rate with a fractional accumulator.
//
// One quirk worth knowing: each channel has a DAC, switched on by the upper
// bits of its envelope register (or bit 7 of NR30 for CH3). A channel whose
// DAC is off contributes true silence; a channel that is merely *disabled*
// but has its DAC on contributes a DC offset — which is why real hardware
// pops when games toggle DACs. The high-pass filter at the end models the
// series capacitor that bleeds that offset away.

const CLOCK = 4194304;
const DUTY = [0b00000001, 0b10000001, 0b10000111, 0b01111110];
const NOISE_DIV = [8, 16, 32, 48, 64, 80, 96, 112];
const WAVE_SHIFT = [4, 0, 1, 2]; // NR32 volume code -> right-shift (mute/100/50/25%)

// Read masks: unused/write-only register bits read back as 1s.
// prettier-ignore
const MASK = [
  0x80, 0x3f, 0x00, 0xff, 0xbf, // NR10-NR14
  0xff, 0x3f, 0x00, 0xff, 0xbf, // ----,NR21-NR24
  0x7f, 0xff, 0x9f, 0xff, 0xbf, // NR30-NR34
  0xff, 0xff, 0x00, 0x00, 0xbf, // ----,NR41-NR44
  0x00, 0x00, 0x70,             // NR50-NR52
];

class Square {
  enabled = false;
  duty = 0;
  freq = 0;
  lengthEnable = false;
  length = 0;
  envVol = 0;
  envDir = 0;
  envPeriod = 0;
  volume = 0;
  private timer = 0;
  private dutyPos = 0;
  private envTimer = 0;
  // sweep (CH1 only)
  sweepPeriod = 0;
  sweepNeg = false;
  sweepShift = 0;
  private sweepTimer = 0;
  private shadowFreq = 0;
  private sweepOn = false;

  get dacOn(): boolean {
    return this.envVol !== 0 || this.envDir !== 0;
  }

  trigger(hasSweep: boolean) {
    this.enabled = this.dacOn;
    if (this.length === 0) this.length = 64;
    this.timer = (2048 - this.freq) * 4;
    this.volume = this.envVol;
    this.envTimer = this.envPeriod;
    if (hasSweep) {
      this.shadowFreq = this.freq;
      this.sweepTimer = this.sweepPeriod || 8;
      this.sweepOn = this.sweepPeriod > 0 || this.sweepShift > 0;
      if (this.sweepShift) this.sweepCalc(); // immediate overflow check
    }
  }

  private sweepCalc(): number {
    const d = this.shadowFreq >> this.sweepShift;
    const f = this.sweepNeg ? this.shadowFreq - d : this.shadowFreq + d;
    if (f > 2047) this.enabled = false;
    return f;
  }

  sweepClock() {
    if (!this.sweepOn || --this.sweepTimer > 0) return;
    this.sweepTimer = this.sweepPeriod || 8;
    if (this.sweepPeriod === 0) return;
    const f = this.sweepCalc();
    if (f <= 2047 && this.sweepShift) {
      this.shadowFreq = f;
      this.freq = f;
      this.sweepCalc(); // writing back runs the overflow check again
    }
  }

  envClock() {
    if (this.envPeriod === 0 || --this.envTimer > 0) return;
    this.envTimer = this.envPeriod;
    if (this.envDir && this.volume < 15) this.volume++;
    else if (!this.envDir && this.volume > 0) this.volume--;
  }

  lengthClock() {
    if (this.lengthEnable && this.length > 0 && --this.length === 0) this.enabled = false;
  }

  tick(cycles: number) {
    this.timer -= cycles;
    while (this.timer <= 0) {
      this.timer += (2048 - this.freq) * 4;
      this.dutyPos = (this.dutyPos + 1) & 7;
    }
  }

  out(): number {
    if (!this.enabled) return 0;
    return DUTY[this.duty] & (1 << this.dutyPos) ? this.volume : 0;
  }
}

class Wave {
  enabled = false;
  dacOn = false;
  freq = 0;
  lengthEnable = false;
  length = 0;
  volShift = 4;
  ram = new Uint8Array(16);
  private timer = 0;
  private pos = 0;
  private sample = 0;

  trigger() {
    this.enabled = this.dacOn;
    if (this.length === 0) this.length = 256;
    this.timer = (2048 - this.freq) * 2;
    this.pos = 0;
  }

  lengthClock() {
    if (this.lengthEnable && this.length > 0 && --this.length === 0) this.enabled = false;
  }

  tick(cycles: number) {
    this.timer -= cycles;
    while (this.timer <= 0) {
      this.timer += (2048 - this.freq) * 2;
      this.pos = (this.pos + 1) & 31;
      const byte = this.ram[this.pos >> 1];
      this.sample = this.pos & 1 ? byte & 0x0f : byte >> 4;
    }
  }

  out(): number {
    if (!this.enabled) return 0;
    return this.sample >> this.volShift;
  }
}

class Noise {
  enabled = false;
  lengthEnable = false;
  length = 0;
  envVol = 0;
  envDir = 0;
  envPeriod = 0;
  volume = 0;
  shift = 0;
  width7 = false;
  divCode = 0;
  private timer = 0;
  private envTimer = 0;
  private lfsr = 0x7fff;

  get dacOn(): boolean {
    return this.envVol !== 0 || this.envDir !== 0;
  }

  trigger() {
    this.enabled = this.dacOn;
    if (this.length === 0) this.length = 64;
    this.timer = NOISE_DIV[this.divCode] << this.shift;
    this.volume = this.envVol;
    this.envTimer = this.envPeriod;
    this.lfsr = 0x7fff;
  }

  envClock() {
    if (this.envPeriod === 0 || --this.envTimer > 0) return;
    this.envTimer = this.envPeriod;
    if (this.envDir && this.volume < 15) this.volume++;
    else if (!this.envDir && this.volume > 0) this.volume--;
  }

  lengthClock() {
    if (this.lengthEnable && this.length > 0 && --this.length === 0) this.enabled = false;
  }

  tick(cycles: number) {
    this.timer -= cycles;
    while (this.timer <= 0) {
      this.timer += NOISE_DIV[this.divCode] << this.shift;
      // 15-bit LFSR: xor the low two bits, shift right, feed back into
      // bit 14 (and bit 6 in short mode, which sounds metallic).
      const x = (this.lfsr ^ (this.lfsr >> 1)) & 1;
      this.lfsr = (this.lfsr >> 1) | (x << 14);
      if (this.width7) this.lfsr = (this.lfsr & ~0x40) | (x << 6);
    }
  }

  out(): number {
    if (!this.enabled) return 0;
    return this.lfsr & 1 ? 0 : this.volume; // output is the *inverted* low bit
  }
}

export class APU {
  readonly ch1 = new Square();
  readonly ch2 = new Square();
  readonly ch3 = new Wave();
  readonly ch4 = new Noise();

  private power = true;
  private regs = new Uint8Array(0x17); // raw NRxx bytes for readback
  private nr50 = 0x77;
  private nr51 = 0xf3;

  private seqTimer = 8192; // 512 Hz frame sequencer
  private seqStep = 0;

  private cyclesPerSample = 0; // 0 until the host enables audio
  private sampleAcc = 0;
  private buf = new Float32Array(16384); // interleaved L/R
  private bufIdx = 0;
  private capL = 0;
  private capR = 0;
  private charge = 0.996;

  setSampleRate(rate: number) {
    this.cyclesPerSample = CLOCK / rate;
    // High-pass charge factor scaled to the sample rate (models the
    // output capacitor; also what keeps DAC DC offsets from thumping).
    this.charge = Math.pow(0.999958, CLOCK / rate);
  }

  pullSamples(): Float32Array {
    const out = this.buf.slice(0, this.bufIdx);
    this.bufIdx = 0;
    return out;
  }

  tick(cycles: number) {
    for (let i = 0; i < cycles; i++) {
      if (this.power) {
        if (--this.seqTimer === 0) {
          this.seqTimer = 8192;
          this.seqClock();
        }
        this.ch1.tick(1);
        this.ch2.tick(1);
        this.ch3.tick(1);
        this.ch4.tick(1);
      }
      if (this.cyclesPerSample) {
        if (++this.sampleAcc >= this.cyclesPerSample) {
          this.sampleAcc -= this.cyclesPerSample;
          this.emitSample();
        }
      }
    }
  }

  private seqClock() {
    const s = this.seqStep;
    if ((s & 1) === 0) {
      this.ch1.lengthClock();
      this.ch2.lengthClock();
      this.ch3.lengthClock();
      this.ch4.lengthClock();
    }
    if (s === 2 || s === 6) this.ch1.sweepClock();
    if (s === 7) {
      this.ch1.envClock();
      this.ch2.envClock();
      this.ch4.envClock();
    }
    this.seqStep = (s + 1) & 7;
  }

  private emitSample() {
    // Each DAC maps its 0-15 input onto -1..1; disabled-but-powered DACs
    // sit at -1, matching hardware's DC offset behavior.
    let l = 0;
    let r = 0;
    if (this.power) {
      const a = [
        this.ch1.dacOn ? this.ch1.out() / 7.5 - 1 : 0,
        this.ch2.dacOn ? this.ch2.out() / 7.5 - 1 : 0,
        this.ch3.dacOn ? this.ch3.out() / 7.5 - 1 : 0,
        this.ch4.dacOn ? this.ch4.out() / 7.5 - 1 : 0,
      ];
      for (let c = 0; c < 4; c++) {
        if (this.nr51 & (0x10 << c)) l += a[c];
        if (this.nr51 & (0x01 << c)) r += a[c];
      }
      l *= (((this.nr50 >> 4) & 7) + 1) / 8 / 4;
      r *= ((this.nr50 & 7) + 1) / 8 / 4;
    }
    // High-pass filter (the output capacitor).
    const outL = l - this.capL;
    this.capL = l - outL * this.charge;
    const outR = r - this.capR;
    this.capR = r - outR * this.charge;

    if (this.bufIdx + 2 <= this.buf.length) {
      this.buf[this.bufIdx++] = outL * 0.5;
      this.buf[this.bufIdx++] = outR * 0.5;
    }
  }

  read(addr: number): number {
    if (addr >= 0xff30 && addr <= 0xff3f) return this.ch3.ram[addr - 0xff30];
    if (addr === 0xff26) {
      return (
        (this.power ? 0x80 : 0) | 0x70 |
        (this.ch1.enabled ? 1 : 0) | (this.ch2.enabled ? 2 : 0) |
        (this.ch3.enabled ? 4 : 0) | (this.ch4.enabled ? 8 : 0)
      );
    }
    if (addr === 0xff24) return this.nr50;
    if (addr === 0xff25) return this.nr51;
    const i = addr - 0xff10;
    if (i < 0 || i >= MASK.length) return 0xff;
    return this.regs[i] | MASK[i];
  }

  write(addr: number, v: number) {
    if (addr >= 0xff30 && addr <= 0xff3f) {
      this.ch3.ram[addr - 0xff30] = v;
      return;
    }
    if (addr === 0xff26) {
      const wasOn = this.power;
      this.power = (v & 0x80) !== 0;
      if (wasOn && !this.power) this.reset(); // power off clears every register
      return;
    }
    if (!this.power) return; // registers are dead while the APU is off

    const i = addr - 0xff10;
    if (i >= 0 && i < this.regs.length) this.regs[i] = v;

    const c1 = this.ch1;
    const c2 = this.ch2;
    const c3 = this.ch3;
    const c4 = this.ch4;
    switch (addr) {
      case 0xff10:
        c1.sweepPeriod = (v >> 4) & 7;
        c1.sweepNeg = (v & 8) !== 0;
        c1.sweepShift = v & 7;
        break;
      case 0xff11: c1.duty = v >> 6; c1.length = 64 - (v & 0x3f); break;
      case 0xff12:
        c1.envVol = v >> 4; c1.envDir = (v >> 3) & 1; c1.envPeriod = v & 7;
        if (!c1.dacOn) c1.enabled = false;
        break;
      case 0xff13: c1.freq = (c1.freq & 0x700) | v; break;
      case 0xff14:
        c1.freq = (c1.freq & 0xff) | ((v & 7) << 8);
        c1.lengthEnable = (v & 0x40) !== 0;
        if (v & 0x80) c1.trigger(true);
        break;
      case 0xff16: c2.duty = v >> 6; c2.length = 64 - (v & 0x3f); break;
      case 0xff17:
        c2.envVol = v >> 4; c2.envDir = (v >> 3) & 1; c2.envPeriod = v & 7;
        if (!c2.dacOn) c2.enabled = false;
        break;
      case 0xff18: c2.freq = (c2.freq & 0x700) | v; break;
      case 0xff19:
        c2.freq = (c2.freq & 0xff) | ((v & 7) << 8);
        c2.lengthEnable = (v & 0x40) !== 0;
        if (v & 0x80) c2.trigger(false);
        break;
      case 0xff1a:
        c3.dacOn = (v & 0x80) !== 0;
        if (!c3.dacOn) c3.enabled = false;
        break;
      case 0xff1b: c3.length = 256 - v; break;
      case 0xff1c: c3.volShift = WAVE_SHIFT[(v >> 5) & 3]; break;
      case 0xff1d: c3.freq = (c3.freq & 0x700) | v; break;
      case 0xff1e:
        c3.freq = (c3.freq & 0xff) | ((v & 7) << 8);
        c3.lengthEnable = (v & 0x40) !== 0;
        if (v & 0x80) c3.trigger();
        break;
      case 0xff20: c4.length = 64 - (v & 0x3f); break;
      case 0xff21:
        c4.envVol = v >> 4; c4.envDir = (v >> 3) & 1; c4.envPeriod = v & 7;
        if (!c4.dacOn) c4.enabled = false;
        break;
      case 0xff22:
        c4.shift = v >> 4; c4.width7 = (v & 8) !== 0; c4.divCode = v & 7;
        break;
      case 0xff23:
        c4.lengthEnable = (v & 0x40) !== 0;
        if (v & 0x80) c4.trigger();
        break;
      case 0xff24: this.nr50 = v; break;
      case 0xff25: this.nr51 = v; break;
    }
  }

  private reset() {
    const wave = this.ch3.ram; // wave RAM survives power cycles
    this.regs.fill(0);
    this.nr50 = 0;
    this.nr51 = 0;
    const fresh = new APU();
    Object.assign(this.ch1, fresh.ch1);
    Object.assign(this.ch2, fresh.ch2);
    Object.assign(this.ch3, fresh.ch3, { ram: wave });
    Object.assign(this.ch4, fresh.ch4);
  }
}
