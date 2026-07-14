import { Int, Interrupts } from "./interrupts";

// The PPU draws a 160x144 screen from 8x8 tiles. There is no framebuffer
// in the machine: every scanline is composed live from three layers:
//   background — a 32x32 tile map, scrolled by SCX/SCY, wraps around
//   window     — a second, non-scrolling tile map (status bars, menus)
//   sprites    — up to 40 OAM entries, max 10 per scanline
//
// Each scanline takes 456 dots (T-cycles) and cycles through modes:
//   mode 2 (0-79):    OAM scan       mode 3 (80-251): drawing pixels
//   mode 0 (252-455): horizontal blank
// Lines 144-153 are mode 1, the vertical blank — the only safe window for
// the game to write lots of VRAM, which is why VBlank is *the* heartbeat
// interrupt every game syncs to.
//
// This is a scanline renderer: we draw a whole line at once when mode 3
// ends, rather than emulating the per-pixel FIFO. Accurate enough for the
// vast majority of games.

export const SCREEN_W = 160;
export const SCREEN_H = 144;

// The four shades of the original DMG's green LCD, light to dark.
const SHADES = [
  [0xe0, 0xf8, 0xd0],
  [0x88, 0xc0, 0x70],
  [0x34, 0x68, 0x56],
  [0x08, 0x18, 0x20],
];

export class PPU {
  vram = new Uint8Array(0x2000);
  oam = new Uint8Array(0xa0);
  framebuffer = new Uint8ClampedArray(SCREEN_W * SCREEN_H * 4); // RGBA

  lcdc = 0x91;
  scy = 0;
  scx = 0;
  ly = 0;
  lyc = 0;
  bgp = 0xfc;
  obp0 = 0xff;
  obp1 = 0xff;
  wy = 0;
  wx = 0;

  private stat = 0; // writable bits 3-6 only; the rest are derived on read
  private mode = 0;
  private dot = 0;
  private windowLine = 0; // window keeps its own line counter
  private lineColor = new Uint8Array(SCREEN_W); // BG color ids, for sprite priority

  constructor(private ints: Interrupts) {
    this.clearScreen();
  }

  readReg(addr: number): number {
    switch (addr) {
      case 0xff40: return this.lcdc;
      case 0xff41:
        return 0x80 | this.stat | (this.ly === this.lyc ? 0x04 : 0) | this.mode;
      case 0xff42: return this.scy;
      case 0xff43: return this.scx;
      case 0xff44: return this.ly;
      case 0xff45: return this.lyc;
      case 0xff47: return this.bgp;
      case 0xff48: return this.obp0;
      case 0xff49: return this.obp1;
      case 0xff4a: return this.wy;
      case 0xff4b: return this.wx;
      default: return 0xff;
    }
  }

  writeReg(addr: number, v: number) {
    switch (addr) {
      case 0xff40:
        if (this.lcdc & 0x80 && !(v & 0x80)) {
          // LCD switched off: LY resets and the screen goes blank.
          this.ly = 0;
          this.dot = 0;
          this.mode = 0;
          this.windowLine = 0;
          this.clearScreen();
        }
        this.lcdc = v;
        break;
      case 0xff41: this.stat = v & 0x78; break;
      case 0xff42: this.scy = v; break;
      case 0xff43: this.scx = v; break;
      case 0xff44: break; // LY is read-only
      case 0xff45: this.lyc = v; this.checkLYC(); break;
      case 0xff47: this.bgp = v; break;
      case 0xff48: this.obp0 = v; break;
      case 0xff49: this.obp1 = v; break;
      case 0xff4a: this.wy = v; break;
      case 0xff4b: this.wx = v; break;
    }
  }

  tick(cycles: number) {
    if (!(this.lcdc & 0x80)) return; // LCD off: nothing advances

    this.dot += cycles;
    while (this.dot >= 456) {
      this.dot -= 456;
      this.ly++;
      if (this.ly === 144) {
        this.ints.request(Int.VBlank);
      } else if (this.ly > 153) {
        this.ly = 0;
        this.windowLine = 0;
      }
      this.checkLYC();
    }

    const newMode =
      this.ly >= 144 ? 1 : this.dot < 80 ? 2 : this.dot < 252 ? 3 : 0;

    if (newMode !== this.mode) {
      this.mode = newMode;
      if (newMode === 0) {
        this.renderScanline();
        if (this.stat & 0x08) this.ints.request(Int.Stat);
      } else if (newMode === 1) {
        if (this.stat & 0x10) this.ints.request(Int.Stat);
      } else if (newMode === 2) {
        if (this.stat & 0x20) this.ints.request(Int.Stat);
      }
    }
  }

  private checkLYC() {
    if (this.ly === this.lyc && this.stat & 0x40) this.ints.request(Int.Stat);
  }

  private clearScreen() {
    const [r, g, b] = SHADES[0];
    for (let i = 0; i < this.framebuffer.length; i += 4) {
      this.framebuffer[i] = r;
      this.framebuffer[i + 1] = g;
      this.framebuffer[i + 2] = b;
      this.framebuffer[i + 3] = 255;
    }
  }

  private putPixel(x: number, shade: number) {
    const o = (this.ly * SCREEN_W + x) * 4;
    const c = SHADES[shade];
    this.framebuffer[o] = c[0];
    this.framebuffer[o + 1] = c[1];
    this.framebuffer[o + 2] = c[2];
    this.framebuffer[o + 3] = 255;
  }

  private renderScanline() {
    const y = this.ly;
    if (y >= SCREEN_H) return;

    // --- background & window ---
    if (this.lcdc & 0x01) {
      const winActive =
        (this.lcdc & 0x20) !== 0 && y >= this.wy && this.wx <= 166;
      let windowDrawn = false;

      for (let x = 0; x < SCREEN_W; x++) {
        const useWin = winActive && x >= this.wx - 7;
        let mapBase: number, px: number, py: number;
        if (useWin) {
          mapBase = this.lcdc & 0x40 ? 0x1c00 : 0x1800;
          px = x - (this.wx - 7);
          py = this.windowLine;
          windowDrawn = true;
        } else {
          mapBase = this.lcdc & 0x08 ? 0x1c00 : 0x1800;
          px = (x + this.scx) & 0xff; // & 0xff makes the 256px map wrap
          py = (y + this.scy) & 0xff;
        }

        const tileIdx = this.vram[mapBase + (py >> 3) * 32 + (px >> 3)];
        // LCDC bit 4 picks the tile-data addressing mode: unsigned from
        // 0x8000, or signed from 0x9000 (tile -128..127).
        const tileAddr =
          this.lcdc & 0x10
            ? tileIdx * 16
            : 0x1000 + ((tileIdx << 24) >> 24) * 16;

        const row = (py & 7) * 2;
        const lo = this.vram[tileAddr + row];
        const hi = this.vram[tileAddr + row + 1];
        // 2bpp: each pixel's color id is one bit from each byte, MSB first.
        const bit = 7 - (px & 7);
        const colorId = (((hi >> bit) & 1) << 1) | ((lo >> bit) & 1);

        this.lineColor[x] = colorId;
        this.putPixel(x, (this.bgp >> (colorId * 2)) & 3);
      }
      if (windowDrawn) this.windowLine++;
    } else {
      // BG disabled: white line, and sprites treat it as color 0 everywhere.
      this.lineColor.fill(0);
      for (let x = 0; x < SCREEN_W; x++) this.putPixel(x, 0);
    }

    // --- sprites ---
    if (!(this.lcdc & 0x02)) return;
    const height = this.lcdc & 0x04 ? 16 : 8;

    // OAM scan: hardware takes the first 10 sprites on this line in OAM order.
    const onLine: number[] = [];
    for (let i = 0; i < 40 && onLine.length < 10; i++) {
      const sy = this.oam[i * 4] - 16;
      if (y >= sy && y < sy + height) onLine.push(i);
    }

    // DMG priority: smaller X wins, ties broken by OAM index. We sort into
    // *reverse* priority order and let later draws overwrite earlier ones.
    onLine.sort((a, b) => this.oam[b * 4 + 1] - this.oam[a * 4 + 1] || b - a);

    for (const i of onLine) {
      const sy = this.oam[i * 4] - 16;
      const sx = this.oam[i * 4 + 1] - 8;
      let tile = this.oam[i * 4 + 2];
      const attr = this.oam[i * 4 + 3];
      if (height === 16) tile &= 0xfe; // 8x16 sprites use an even/odd tile pair

      let row = y - sy;
      if (attr & 0x40) row = height - 1 - row; // Y flip
      const addr = tile * 16 + row * 2;
      const lo = this.vram[addr];
      const hi = this.vram[addr + 1];
      const pal = attr & 0x10 ? this.obp1 : this.obp0;

      for (let px = 0; px < 8; px++) {
        const x = sx + px;
        if (x < 0 || x >= SCREEN_W) continue;
        const bit = attr & 0x20 ? px : 7 - px; // X flip
        const colorId = (((hi >> bit) & 1) << 1) | ((lo >> bit) & 1);
        if (colorId === 0) continue; // color 0 is transparent for sprites
        // "Behind BG" attribute: BG colors 1-3 win over this sprite.
        if (attr & 0x80 && this.lineColor[x] !== 0) continue;
        this.putPixel(x, (pal >> (colorId * 2)) & 3);
      }
    }
  }
}
