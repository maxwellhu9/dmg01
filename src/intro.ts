import { SCREEN_H, SCREEN_W } from "./ppu";

// The startup sequence shown before a game runs, drawn straight onto the
// screen canvas while the emulator waits:
//
//   insert: the screen sits blank with the power light off, and a click,
//           like a cartridge being pushed into the slot
//   boot:   "DMG-01" scrolls down from the top and stops, then ding-DING,
//           after the real Game Boy's startup logo
//
// This is presentation, not emulation: the real logo comes from a boot ROM
// inside the console, which this emulator skips.

const LOGO_FONT: Record<string, string[]> = {
  D: ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."],
  M: ["#...#", "##.##", "#.#.#", "#.#.#", "#...#", "#...#", "#...#"],
  G: [".####", "#....", "#....", "#..##", "#...#", "#...#", ".####"],
  "-": [".....", ".....", ".....", "####.", ".....", ".....", "....."],
  "0": [".###.", "#...#", "#..##", "#.#.#", "##..#", "#...#", ".###."],
  "1": ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."],
};
const LOGO_TEXT = "DMG-01";
const FAT = 2;                                     // each logo pixel is 2x2
const LOGO_W = (LOGO_TEXT.length * 6 - 1) * FAT;
const LOGO_H = 7 * FAT;
const LOGO_X = (SCREEN_W - LOGO_W) >> 1;
const LOGO_REST_Y = (SCREEN_H - LOGO_H) >> 1;

const INSERT_FRAMES = 20;
const SCROLL_FRAMES = LOGO_REST_Y + LOGO_H;        // one pixel per frame
const DING_1 = SCROLL_FRAMES + 2;
const DING_2 = DING_1 + 6;
const BOOT_FRAMES = DING_2 + 44;

const LIGHT = [0xe0, 0xf8, 0xd0];                  // the green LCD's lightest shade
const DARK = [0x08, 0x18, 0x20];
const OFF = [0xb8, 0xc4, 0x9c];                    // an unpowered LCD

export type IntroHooks = {
  led(on: boolean): void;
  click(): void;
  ding(freq: number, seconds: number): void;
};

export class Intro {
  private phase: "idle" | "insert" | "boot" = "idle";
  private frame = 0;
  private pixels = new Uint8ClampedArray(SCREEN_W * SCREEN_H * 4);
  private image = new ImageData(this.pixels, SCREEN_W, SCREEN_H);

  constructor(private hooks: IntroHooks) {}

  get active(): boolean {
    return this.phase !== "idle";
  }

  start(withInsert: boolean) {
    this.frame = 0;
    if (withInsert) {
      this.phase = "insert";
      this.hooks.led(false);
      this.hooks.click();
    } else {
      this.phase = "boot";
      this.hooks.led(true);
    }
  }

  skip() {
    if (this.phase === "idle") return;
    this.phase = "idle";
    this.hooks.led(true);
  }

  // Advances one frame and draws it. Returns false once the game should run.
  step(ctx: CanvasRenderingContext2D): boolean {
    if (this.phase === "insert") {
      this.fill(OFF);
      if (++this.frame >= INSERT_FRAMES) {
        this.phase = "boot";
        this.frame = 0;
        this.hooks.led(true);
      }
    } else if (this.phase === "boot") {
      this.fill(LIGHT);
      this.drawLogo(Math.min(this.frame, SCROLL_FRAMES) - LOGO_H);
      if (this.frame === DING_1) this.hooks.ding(1048, 0.09);
      if (this.frame === DING_2) this.hooks.ding(2096, 0.6);
      if (++this.frame >= BOOT_FRAMES) this.phase = "idle";
    }
    ctx.putImageData(this.image, 0, 0);
    return this.active;
  }

  private fill([r, g, b]: number[]) {
    for (let i = 0; i < this.pixels.length; i += 4) {
      this.pixels[i] = r;
      this.pixels[i + 1] = g;
      this.pixels[i + 2] = b;
      this.pixels[i + 3] = 255;
    }
  }

  private drawLogo(top: number) {
    [...LOGO_TEXT].forEach((ch, i) => {
      LOGO_FONT[ch].forEach((row, gy) => {
        [...row].forEach((cell, gx) => {
          if (cell !== "#") return;
          for (let dy = 0; dy < FAT; dy++) {
            for (let dx = 0; dx < FAT; dx++) {
              const x = LOGO_X + (i * 6 + gx) * FAT + dx;
              const y = top + gy * FAT + dy;
              if (y < 0 || y >= SCREEN_H) continue;
              const o = (y * SCREEN_W + x) * 4;
              this.pixels[o] = DARK[0];
              this.pixels[o + 1] = DARK[1];
              this.pixels[o + 2] = DARK[2];
            }
          }
        });
      });
    });
  }
}
