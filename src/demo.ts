// A built-in 32KB demo cartridge, hand-assembled byte by byte. This is real
// SM83 machine code the emulator boots when no game is loaded: it copies
// tile data and a tile map into VRAM with the LCD off, turns the LCD on,
// then scrolls diagonally forever — waking once per frame via the VBlank
// interrupt (EI + HALT is the canonical Game Boy main loop).
//
// Layout: code at 0x0150, tile data at 0x1000, tile map at 0x1800.

export function buildDemoRom(): Uint8Array {
  const rom = new Uint8Array(0x8000);

  // VBlank handler at the 0x40 vector: just return.
  rom[0x40] = 0xd9; // RETI

  // Cartridge entry point: the boot ROM jumps to 0x100.
  rom.set([0x00, 0xc3, 0x50, 0x01], 0x100); // NOP; JP 0x0150

  // Header: title + type 0 (ROM only, no MBC).
  const title = "SCROLL DEMO";
  for (let i = 0; i < title.length; i++) rom[0x134 + i] = title.charCodeAt(i);
  rom[0x147] = 0x00;

  // prettier-ignore
  rom.set([
    0xf3,             // 0150  DI
    0x31, 0xfe, 0xff, // 0151  LD SP,0xFFFE
    0xaf,             // 0154  XOR A
    0xe0, 0x40,       // 0155  LDH (LCDC),A     ; LCD off so VRAM is writable
    0x21, 0x00, 0x80, // 0157  LD HL,0x8000     ; dst: tile data
    0x11, 0x00, 0x10, // 015A  LD DE,0x1000     ; src: tiles in this ROM
    0x01, 0x40, 0x00, // 015D  LD BC,0x0040     ; 4 tiles x 16 bytes
    0x1a,             // 0160  LD A,(DE)        ; -- copy loop --
    0x22,             // 0161  LD (HL+),A
    0x13,             // 0162  INC DE
    0x0b,             // 0163  DEC BC
    0x78,             // 0164  LD A,B
    0xb1,             // 0165  OR C
    0x20, 0xf8,       // 0166  JR NZ,-8         ; until BC == 0
    0x21, 0x00, 0x98, // 0168  LD HL,0x9800     ; dst: tile map
    0x11, 0x00, 0x18, // 016B  LD DE,0x1800     ; src: map in this ROM
    0x01, 0x00, 0x04, // 016E  LD BC,0x0400     ; 32x32 entries
    0x1a,             // 0171  LD A,(DE)        ; -- copy loop --
    0x22, 0x13, 0x0b, // 0172  LD (HL+),A; INC DE; DEC BC
    0x78, 0xb1,       // 0175  LD A,B; OR C
    0x20, 0xf8,       // 0177  JR NZ,-8
    0x3e, 0xe4,       // 0179  LD A,0xE4
    0xe0, 0x47,       // 017B  LDH (BGP),A      ; palette 3,2,1,0
    0x3e, 0x91,       // 017D  LD A,0x91
    0xe0, 0x40,       // 017F  LDH (LCDC),A     ; LCD on, BG on
    0xaf,             // 0181  XOR A
    0xe0, 0x0f,       // 0182  LDH (IF),A       ; drop stale interrupt requests
    0x3e, 0x01,       // 0184  LD A,1
    0xe0, 0xff,       // 0186  LDH (IE),A       ; enable VBlank only
    0xfb,             // 0188  EI
    0x76,             // 0189  HALT             ; -- main loop: sleep to VBlank --
    0xf0, 0x43,       // 018A  LDH A,(SCX)
    0x3c,             // 018C  INC A
    0xe0, 0x43,       // 018D  LDH (SCX),A
    0xf0, 0x42,       // 018F  LDH A,(SCY)
    0x3c,             // 0191  INC A
    0xe0, 0x42,       // 0192  LDH (SCY),A
    0x18, 0xf3,       // 0194  JR -13           ; back to HALT
  ], 0x150);

  // Tile data, 2 bits per pixel. Each row is two bytes: low bit-plane then
  // high bit-plane, MSB = leftmost pixel.
  const tiles = [
    // tile 0: empty (color 0)
    ...Array(16).fill(0),
    // tile 1: 1x1 checker of colors 1 and 2
    ...[0xaa, 0x55, 0x55, 0xaa, 0xaa, 0x55, 0x55, 0xaa,
        0xaa, 0x55, 0x55, 0xaa, 0xaa, 0x55, 0x55, 0xaa],
    // tile 2: hollow box in color 3
    ...[0xff, 0xff, 0x81, 0x81, 0x81, 0x81, 0x81, 0x81,
        0x81, 0x81, 0x81, 0x81, 0x81, 0x81, 0xff, 0xff],
    // tile 3: diagonal stripe in color 3
    ...[0x80, 0x80, 0x40, 0x40, 0x20, 0x20, 0x10, 0x10,
        0x08, 0x08, 0x04, 0x04, 0x02, 0x02, 0x01, 0x01],
  ];
  rom.set(tiles, 0x1000);

  // Tile map: concentric diamond bands around the map center.
  for (let ty = 0; ty < 32; ty++) {
    for (let tx = 0; tx < 32; tx++) {
      const d = Math.abs(tx - 16) + Math.abs(ty - 16);
      rom[0x1800 + ty * 32 + tx] = (d >> 1) & 3;
    }
  }

  return rom;
}
