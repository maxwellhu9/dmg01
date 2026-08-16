# DMG-01

A Game Boy emulator I wrote from scratch in TypeScript. It plays real games in
your browser, with sound, at full speed.

**[Play it here](https://maxwellhu9.github.io/dmg01/)** — drag any `.gb` file
onto the page. No ROM handy? It boots a little demo cartridge I hand-assembled
in raw machine code.

No emulation libraries, no frameworks. Everything in `src/` is the machine.

```
npm install
npm run dev     # emulator at localhost:5173
npm test        # 22 tests
```

## What's actually going on here

A Game Boy is a 4.19 MHz CPU sharing a bus with a graphics chip, a sound chip,
a timer, and a cartridge. No operating system, no scheduler, no framebuffer.
The game *is* the machine. Everything runs off one crystal in lockstep, and the
emulator copies that exactly:

```
while (cycles < 70224) {          // one video frame, 59.7 times a second
  n = cpu.step()                  // run one instruction, count its cycles
  ppu.tick(n)                     // everything else advances by the same amount
  timer.tick(n)
  apu.tick(n)
}
```

That loop in `src/gameboy.ts` is the entire architecture. The cycle counts
aren't a performance detail, they're the contract. Games count cycles to race
the display beam, so an emulator that runs every instruction correctly but with
sloppy timing still breaks games. (Ask me how I know.)

## Which file is which chip

| File | What it is |
| --- | --- |
| `cpu.ts` | The Sharp SM83 processor. Decodes instructions by bit pattern instead of a 512-case switch, so whole families of opcodes share one code path |
| `ppu.ts` | Graphics. Draws the screen one scanline at a time from tiles, sprites, and a scrolling background |
| `apu.ts` | Sound. Two square waves, a wavetable channel, and a noise generator, mixed and filtered |
| `audio.ts` | Ships those samples to the browser's audio thread without gaps |
| `bus.ts` | The address decoder. Maps the CPU's 16-bit address space onto everything else |
| `cartridge.ts` | ROM header parsing and bank switching for MBC1/MBC3 carts |
| `timer.ts`, `joypad.ts`, `serial.ts`, `interrupts.ts` | The small stuff, all necessary |
| `demo.ts` | The built-in demo cart, assembled byte by byte |

## The bug that taught me the most

Tobu Tobu Girl booted fine, played fine, then froze about eight seconds in.
Every time.

The CPU was passing all 11 of Blargg's hardware test ROMs at that point, so I
figured the problem was somewhere else. It wasn't. Sampling the program counter
showed the game stuck in a crash loop, and tracing backwards showed the stack
pointer drifting two bytes every time an interrupt fired.

The cause was a one-instruction race. `EI` turns interrupts on, but not until
*after* the next instruction runs. The game idles on `EI; HALT`. If an
interrupt happened to already be pending at that exact moment, my code took a
path meant for a different situation entirely (the "halt bug", where the CPU
famously fails to advance) and re-ran the first instruction of the interrupt
handler. That instruction was a `PUSH`. Two bytes leaked per interrupt, and
thirty instructions later the game returned into its own sprite data.

Test ROMs check instructions in isolation. Real games check how they interact.

## Tests

```
npm test
```

Hand-written CPU programs, APU checks, and a headless boot of the demo ROM. For
the real validation, grab Blargg's test suite, which runs on actual Game Boy
hardware and prints its results over the link cable port:

```
git clone https://github.com/retrio/gb-test-roms roms/gb-test-roms
npm test    # cpu_instrs gets picked up automatically, currently 11/11
```

You can also drop any test ROM into the web UI and watch the serial output in
the panel under the screen.

CI runs all of this on every push and only deploys if everything passes.

## Where to get games

[Homebrew Hub](https://hh.gbdev.io) has hundreds of free, legally
distributable games. Look for the plain `GAME BOY` badge, since Game Boy Color
titles won't run here yet. Tobu Tobu Girl is a good one. Commercial games are
copyrighted, so dump your own carts.

Put ROMs in `games/`. It's gitignored.

## Status

Done:
- Full instruction set, interrupts, and the weird edge cases (halt bug, BCD, the `EI` delay)
- Graphics: background, window, sprites, both sprite sizes, OAM DMA
- All four sound channels with envelopes, sweep, and length counters
- MBC1 and MBC3 cartridges, battery saves that survive a refresh
- Runs a frame in about 0.45 ms, roughly 35x faster than it needs to

Not done:
- Save states and rewind
- Memory timing below instruction granularity (Blargg's `mem_timing` will fail)
- MBC5, which a lot of later games need
- Game Boy Color
- MBC3's real-time clock, so Pokémon Gold's day/night cycle won't tick

## If you want to build one

- [Pan Docs](https://gbdev.io/pandocs/) is the reference. Everything is in here.
- [gbops](https://izik1.github.io/gbops/) is the instruction set as a visual map.
- [The Ultimate Game Boy Talk](https://www.youtube.com/watch?v=HyzD8pNlpwI) is the best hour you can spend on this hardware.

Start with CHIP-8 if you've never done this before. It's a weekend, and it
teaches you the shape of the problem.
