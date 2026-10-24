// Save states. Every chip's state is plain data: numbers, flags, and byte
// arrays. So a save state is a deep copy of each chip's fields, and loading
// one writes those values back in place.
//
// Two rules make that safe:
//   - Links between chips (the CPU's reference to the bus, and so on) are
//     wiring, not state, so they're skipped. The machine stays wired the same.
//   - Arrays are copied *into* the existing ones rather than replaced, because
//     other code holds on to them (the screen draws straight from the PPU's
//     framebuffer, for one).

export type Snapshot = { [key: string]: unknown };

// Fields that aren't machine state: the cartridge ROM never changes, the
// audio buffer is just samples waiting for the speakers, and which buttons
// are held belongs to the player, not the save.
const SKIP_KEYS = new Set(["rom", "buf", "dpad", "buttons"]);

export function capture(obj: object, links: Set<object>): Snapshot {
  const out: Snapshot = {};
  for (const [key, value] of Object.entries(obj)) {
    if (SKIP_KEYS.has(key) || typeof value === "function") continue;
    if (value && typeof value === "object" && links.has(value)) continue;
    if (ArrayBuffer.isView(value)) {
      out[key] = (value as Uint8Array).slice();
    } else if (value && typeof value === "object") {
      out[key] = capture(value, links);   // e.g. each APU sound channel
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function restore(obj: object, snap: Snapshot) {
  const target = obj as Snapshot;
  for (const [key, value] of Object.entries(snap)) {
    const current = target[key];
    if (ArrayBuffer.isView(current)) {
      (current as Uint8Array).set(value as Uint8Array);
    } else if (current && typeof current === "object") {
      restore(current, value as Snapshot);
    } else {
      target[key] = value;
    }
  }
}

// Rewind: a rolling history of recent snapshots, popped newest-first.
export class Rewind {
  private history: Snapshot[] = [];
  private frame = 0;

  // One snapshot every 4 frames, 150 kept: the last ten seconds. Popping one
  // per frame while rewinding plays time backward at 4x speed.
  constructor(private every = 4, private keep = 150) {}

  record(take: () => Snapshot) {
    if (++this.frame % this.every) return;
    this.history.push(take());
    if (this.history.length > this.keep) this.history.shift();
  }

  back(): Snapshot | undefined {
    return this.history.pop();
  }

  clear() {
    this.history = [];
    this.frame = 0;
  }

  get seconds(): number {
    return (this.history.length * this.every) / 60;
  }
}
