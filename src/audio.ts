// Browser audio output. The emulator produces interleaved stereo Float32
// samples; an AudioWorklet (running on the real-time audio thread) consumes
// them from a small chunk queue. If the queue runs dry it plays silence; if
// it grows past ~120 ms it drops old chunks so latency can't creep up.
//
// The worklet source is inlined as a Blob so it needs no separate file and
// survives any bundler/deploy setup.

const WORKLET_SRC = `
class DmgPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.cur = null;
    this.off = 0;
    this.port.onmessage = (e) => {
      this.queue.push(e.data);
      while (this.queue.length > 8) this.queue.shift(); // cap latency
    };
  }
  process(inputs, outputs) {
    const L = outputs[0][0], R = outputs[0][1];
    for (let i = 0; i < L.length; i++) {
      if (!this.cur || this.off >= this.cur.length) {
        this.cur = this.queue.shift() ?? null;
        this.off = 0;
      }
      if (this.cur) {
        L[i] = this.cur[this.off++];
        R[i] = this.cur[this.off++];
      } else {
        L[i] = R[i] = 0; // underrun: silence beats garbage
      }
    }
    return true;
  }
}
registerProcessor("dmg-player", DmgPlayer);
`;

export class AudioOut {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  running = false;

  // Must be called from a user gesture (browser autoplay policy).
  async start(): Promise<number> {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: "application/javascript" }));
      await this.ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      this.node = new AudioWorkletNode(this.ctx, "dmg-player", { outputChannelCount: [2] });
      this.node.connect(this.ctx.destination);
    }
    await this.ctx.resume();
    this.running = true;
    return this.ctx.sampleRate;
  }

  push(samples: Float32Array) {
    if (samples.length === 0 || !this.node) return;
    this.node.port.postMessage(samples, [samples.buffer]);
  }

  async suspend() {
    await this.ctx?.suspend();
    this.running = false;
  }
}
