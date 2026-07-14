import { Int, Interrupts } from "./interrupts";

// TIMA tick period in T-cycles for each TAC frequency selection.
const PERIODS = [1024, 16, 64, 256];

// Timer registers: DIV (0xFF04), TIMA (0xFF05), TMA (0xFF06), TAC (0xFF07).
// DIV is the top 8 bits of an internal 16-bit counter that runs always;
// TIMA counts at the TAC-selected rate and requests an interrupt on
// overflow, reloading from TMA. Games use this for music tempo, RNG
// seeding, and scheduling.
export class Timer {
  tima = 0;
  tma = 0;
  tac = 0;
  private divCounter = 0;
  private acc = 0;

  constructor(private ints: Interrupts) {}

  get div(): number {
    return this.divCounter >> 8;
  }

  // Any write to DIV resets the whole internal counter — a common way for
  // games to (accidentally) mess up their own timing.
  writeDiv() {
    this.divCounter = 0;
    this.acc = 0;
  }

  tick(cycles: number) {
    this.divCounter = (this.divCounter + cycles) & 0xffff;
    if (!(this.tac & 0x04)) return; // timer disabled

    this.acc += cycles;
    const period = PERIODS[this.tac & 0x03];
    while (this.acc >= period) {
      this.acc -= period;
      this.tima++;
      if (this.tima > 0xff) {
        this.tima = this.tma;
        this.ints.request(Int.Timer);
      }
    }
  }
}
