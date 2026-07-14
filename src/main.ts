import { AudioOut } from "./audio";
import { buildDemoRom } from "./demo";
import { GameBoy } from "./gameboy";
import type { Button } from "./joypad";
import { SCREEN_H, SCREEN_W } from "./ppu";

const canvas = document.getElementById("screen") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const romInput = document.getElementById("rom-input") as HTMLInputElement;
const resetBtn = document.getElementById("reset-btn") as HTMLButtonElement;
const romInfo = document.getElementById("rom-info")!;
const errorEl = document.getElementById("error")!;
const serialPanel = document.getElementById("serial-panel")!;
const serialOut = document.getElementById("serial-out")!;
const soundBtn = document.getElementById("sound-btn") as HTMLButtonElement;

const audio = new AudioOut();
let sampleRate = 0;

let gb: GameBoy;
let image: ImageData;
let currentRom: Uint8Array;
let romName = "SCROLL DEMO (built-in)";

const KEYMAP: Record<string, Button> = {
  ArrowRight: "right",
  ArrowLeft: "left",
  ArrowUp: "up",
  ArrowDown: "down",
  KeyX: "a",
  KeyZ: "b",
  Enter: "start",
  ShiftLeft: "select",
  ShiftRight: "select",
};

function saveKey(): string {
  return `dmg01-save-${gb.cart.title}`;
}

function persistSave() {
  if (!gb.cart.ramDirty || gb.cart.ram.length === 0) return;
  let bin = "";
  for (const b of gb.cart.ram) bin += String.fromCharCode(b);
  localStorage.setItem(saveKey(), btoa(bin));
  gb.cart.ramDirty = false;
}

function restoreSave() {
  const stored = localStorage.getItem(saveKey());
  if (!stored || gb.cart.ram.length === 0) return;
  const bin = atob(stored);
  for (let i = 0; i < Math.min(bin.length, gb.cart.ram.length); i++) {
    gb.cart.ram[i] = bin.charCodeAt(i);
  }
}

function boot(rom: Uint8Array, name: string) {
  try {
    gb = new GameBoy(rom);
  } catch (err) {
    errorEl.textContent = String(err instanceof Error ? err.message : err);
    errorEl.style.display = "block";
    return;
  }
  errorEl.style.display = "none";
  serialPanel.style.display = "none";
  serialOut.textContent = "";
  currentRom = rom;
  romName = name;

  image = new ImageData(gb.ppu.framebuffer, SCREEN_W, SCREEN_H);
  if (sampleRate) gb.apu.setSampleRate(sampleRate);
  restoreSave();
  gb.serial.onOutput = (all) => {
    serialPanel.style.display = "block";
    serialOut.textContent = all;
  };
  romInfo.innerHTML = `<b>${gb.cart.title}</b> · ${name === romName ? "" : ""}${
    ["ROM only", "MBC1", "", "MBC3"][gb.cart.mbc]
  } · <span id="fps"></span>`;
}

// --- input ---
window.addEventListener("keydown", (e) => {
  const btn = KEYMAP[e.code];
  if (!btn) return;
  e.preventDefault();
  gb.joypad.press(btn);
});
window.addEventListener("keyup", (e) => {
  const btn = KEYMAP[e.code];
  if (!btn) return;
  e.preventDefault();
  gb.joypad.release(btn);
});

// --- ROM loading ---
async function loadFile(file: File) {
  const buf = await file.arrayBuffer();
  boot(new Uint8Array(buf), file.name);
}
romInput.addEventListener("change", () => {
  const f = romInput.files?.[0];
  if (f) void loadFile(f);
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files[0];
  if (f) void loadFile(f);
});
resetBtn.addEventListener("click", () => {
  persistSave();
  boot(currentRom, romName);
});

soundBtn.addEventListener("click", async () => {
  if (audio.running) {
    await audio.suspend();
    soundBtn.textContent = "\u{1F507} sound";
  } else {
    sampleRate = await audio.start();
    gb.apu.setSampleRate(sampleRate);
    soundBtn.textContent = "\u{1F50A} sound";
  }
});

// --- save persistence ---
setInterval(persistSave, 3000);
window.addEventListener("beforeunload", persistSave);

// --- main loop ---
// Pace emulation to the Game Boy's 59.73 Hz, decoupled from the display's
// refresh rate (a 120 Hz screen would otherwise run games at double speed).
const FRAME_MS = 1000 / 59.7275;
let acc = 0;
let last = performance.now();
let frames = 0;
let lastFpsTime = last;

function loop(now: number) {
  acc += now - last;
  last = now;
  // After a background-tab stall, drop the backlog instead of fast-forwarding.
  if (acc > 100) acc = 100;

  let drew = false;
  while (acc >= FRAME_MS) {
    gb.runFrame();
    acc -= FRAME_MS;
    frames++;
    drew = true;
  }
  if (drew) {
    ctx.putImageData(image, 0, 0);
    if (audio.running) audio.push(gb.apu.pullSamples());
  }

  if (now - lastFpsTime >= 1000) {
    const el = document.getElementById("fps");
    if (el) el.textContent = `${frames} fps`;
    frames = 0;
    lastFpsTime = now;
  }
  requestAnimationFrame(loop);
}

boot(buildDemoRom(), "SCROLL DEMO (built-in)");
requestAnimationFrame(loop);
