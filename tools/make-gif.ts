// Records the README's demo GIF by running the emulator itself, with no
// browser and no screen recorder:
//
//   npx tsx tools/make-gif.ts        (writes docs/demo.gif)
//
// It plays the startup logo, a stretch of Tobu Tobu Girl, and a stretch of
// Fortune & Glory with scripted button presses, then encodes the frames with
// the small GIF writer at the bottom of this file.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { GameBoy } from "../src/gameboy";
import type { Button } from "../src/joypad";

const W = 160, H = 144;
const SCALE = 2;        // GitHub smooths scaled images, so bake the 2x in
const SKIP = 2;         // keep every 2nd frame...
const DELAY_CS = 3;     // ...shown for 3/100 s each, close to real speed

type Press = [frame: number, button: Button, hold: number];
type Clip = { rom: string; from: number; to: number; presses: Press[] };

// Frame numbers count from power-on. The presses before `from` just get the
// game to the interesting part.
const CLIPS: Clip[] = [
  {
    rom: "public/tobu.gb",
    from: 1275, to: 1450,
    presses: [[600, "start", 6], [780, "start", 6], [960, "start", 6], [1140, "a", 6],
              [1260, "a", 6], [1300, "left", 40], [1350, "a", 6], [1370, "right", 50]],
  },
  {
    rom: "public/fortune-and-glory.gbc",
    from: 410, to: 480,       // the title screen
    presses: [[300, "start", 6]],
  },
  {
    rom: "public/fortune-and-glory.gbc",
    from: 905, to: 1090,      // running through the first chapter
    presses: [[300, "start", 6], [500, "start", 6], [620, "a", 6], [700, "right", 120],
              [860, "a", 6], [900, "right", 100], [1040, "a", 6]],
  },
];

async function record(): Promise<Uint8ClampedArray[]> {
  const frames: Uint8ClampedArray[] = [];
  let n = 0;
  const keep = (pixels: Uint8ClampedArray) => {
    if (n++ % SKIP === 0) frames.push(new Uint8ClampedArray(pixels));
  };

  // The startup logo is drawn by the page, not the emulator, so give it the
  // two browser pieces it expects: an ImageData and a canvas to draw on.
  let drawn = new Uint8ClampedArray(W * H * 4);
  (globalThis as any).ImageData = class {
    constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
  };
  const canvas = { putImageData: (img: { data: Uint8ClampedArray }) => { drawn = img.data; } };
  const { Intro } = await import("../src/intro");
  const intro = new Intro({ led() {}, click() {}, ding() {} });
  intro.start(false);
  // Skip the first moments, when the logo is still above the screen, so the
  // GIF's first frame (what shows while it loads) isn't blank.
  for (let f = 0; intro.step(canvas as unknown as CanvasRenderingContext2D); f++) {
    if (f >= 16) keep(drawn);
  }

  for (const clip of CLIPS) {
    const gb = new GameBoy(new Uint8Array(readFileSync(clip.rom)));
    for (let f = 0; f < clip.to; f++) {
      for (const [at, button, hold] of clip.presses) {
        if (f === at) gb.joypad.press(button);
        if (f === at + hold) gb.joypad.release(button);
      }
      gb.runFrame();
      if (f >= clip.from) keep(gb.ppu.framebuffer);
    }
  }
  return frames;
}

// ------------------------------------------------------------- GIF writer
// A GIF is a list of images, each with its own small color table, squeezed
// with LZW compression. Two tricks keep the file small: every frame gets only
// the colors it actually uses, and pixels that didn't change since the last
// frame are marked see-through so they cost almost nothing.

function lzw(indices: Uint8Array, minCodeSize: number): number[] {
  const clear = 1 << minCodeSize, end = clear + 1;
  const out: number[] = [];
  let bits = 0, bitCount = 0;
  let codeSize = minCodeSize + 1, next = end + 1;
  let table = new Map<number, number>();
  const emit = (code: number) => {
    bits |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) { out.push(bits & 0xff); bits >>>= 8; bitCount -= 8; }
  };

  emit(clear);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = (prefix << 8) | k;
    const found = table.get(key);
    if (found !== undefined) { prefix = found; continue; }
    emit(prefix);
    if (next === 4096) {          // dictionary full: start a fresh one
      emit(clear);
      table = new Map();
      codeSize = minCodeSize + 1;
      next = end + 1;
    } else {
      if (next === 1 << codeSize) codeSize++;
      table.set(key, next++);
    }
    prefix = k;
  }
  emit(prefix);
  emit(end);
  if (bitCount > 0) out.push(bits & 0xff);
  return out;
}

function encodeGif(frames: Uint8ClampedArray[]): Buffer {
  const w = W * SCALE, h = H * SCALE;
  const bytes: number[] = [];
  const u16 = (v: number) => bytes.push(v & 0xff, v >> 8);

  bytes.push(...Buffer.from("GIF89a"));
  u16(w); u16(h);
  bytes.push(0x70, 0, 0);                                    // no shared color table
  bytes.push(0x21, 0xff, 0x0b, ...Buffer.from("NETSCAPE2.0"), 3, 1, 0, 0, 0);   // loop forever

  let prev: Uint8ClampedArray | null = null;
  for (const frame of frames) {
    // This frame's colors, plus one extra slot meaning "same as before".
    const palette: number[] = [];
    const slot = new Map<number, number>();
    const small = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) {
      const rgb = (frame[i * 4] << 16) | (frame[i * 4 + 1] << 8) | frame[i * 4 + 2];
      const same = prev !== null && prev[i * 4] === frame[i * 4] &&
                   prev[i * 4 + 1] === frame[i * 4 + 1] && prev[i * 4 + 2] === frame[i * 4 + 2];
      if (same) { small[i] = 255; continue; }                // patched below
      let s = slot.get(rgb);
      if (s === undefined) { s = palette.length; palette.push(rgb); slot.set(rgb, s); }
      small[i] = s;
    }
    const clearSlot = palette.length;
    if (clearSlot > 254) throw new Error("too many colors in one frame");
    let tableBits = 1;
    while (1 << tableBits < clearSlot + 1) tableBits++;

    const big = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = small[((y / SCALE) | 0) * W + ((x / SCALE) | 0)];
        big[y * w + x] = v === 255 ? clearSlot : v;
      }
    }

    bytes.push(0x21, 0xf9, 4, prev ? 0x05 : 0x04);           // keep the last frame underneath
    u16(DELAY_CS);
    bytes.push(clearSlot, 0);
    bytes.push(0x2c); u16(0); u16(0); u16(w); u16(h);
    bytes.push(0x80 | (tableBits - 1));
    for (let i = 0; i < 1 << tableBits; i++) {
      const rgb = palette[i] ?? 0;
      bytes.push(rgb >> 16, (rgb >> 8) & 0xff, rgb & 0xff);
    }
    const minCode = Math.max(2, tableBits);
    bytes.push(minCode);
    const data = lzw(big, minCode);
    for (let i = 0; i < data.length; i += 255) {
      const block = data.slice(i, i + 255);
      bytes.push(block.length, ...block);
    }
    bytes.push(0);
    prev = frame;
  }
  bytes.push(0x3b);
  return Buffer.from(bytes);
}

const frames = await record();
const gif = encodeGif(frames);
mkdirSync("docs", { recursive: true });
writeFileSync("docs/demo.gif", gif);
const seconds = (frames.length * DELAY_CS) / 100;
console.log(`docs/demo.gif: ${frames.length} frames, ${seconds.toFixed(1)}s, ${(gif.length / 1e6).toFixed(2)} MB`);
