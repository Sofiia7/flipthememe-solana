// Generates the arena's 8-bit sound effects as small WAV files (16-bit PCM, mono, 22.05 kHz):
//   node apps/mobile/scripts/gen-sounds.mjs
// Square and triangle waves only, so the sounds match the pixel look. Output: apps/mobile/assets/sounds/.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RATE = 22_050;
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'sounds');
const MAX_BYTES = 30 * 1024;

// Note frequencies (Hz).
const N = {
  E4: 329.63, F4: 349.23, Fs4: 369.99, G4: 392.0, A4: 440.0,
  C5: 523.25, E5: 659.25, G5: 783.99, B5: 987.77,
  C6: 1046.5, E6: 1318.51, G6: 1567.98, A6: 1760.0,
};

const square = (phase, duty = 0.5) => (phase % 1 < duty ? 1 : -1);
const triangle = (phase) => 1 - 4 * Math.abs(((phase + 0.25) % 1) - 0.5);

/**
 * Renders a list of notes into one track. A note: { f, to?, dur, wave, duty?, vol, decay?, vib? }.
 * `to` slides the pitch, `decay` is an exponential fade per second, `vib` adds vibrato (Hz).
 */
function render(notes) {
  const out = [];
  let phase = 0;
  for (const n of notes) {
    const count = Math.round(n.dur * RATE);
    const attack = Math.min(count, Math.round(0.003 * RATE));
    const release = Math.min(count, Math.round(0.012 * RATE));
    for (let i = 0; i < count; i++) {
      const t = i / RATE;
      const k = count > 1 ? i / (count - 1) : 0;
      let f = n.to ? n.f * Math.pow(n.to / n.f, k) : n.f;
      if (n.vib) f *= 1 + 0.012 * Math.sin(2 * Math.PI * n.vib * t);
      phase += f / RATE;
      let env = n.decay ? Math.exp(-n.decay * t) : 1;
      if (i < attack) env *= i / attack;
      if (i >= count - release) env *= (count - 1 - i) / release;
      const wave = n.f === 0 ? 0 : n.wave === 'triangle' ? triangle(phase) : square(phase, n.duty ?? 0.5);
      out.push(wave * env * n.vol);
    }
  }
  return out;
}

/** Sums tracks of different lengths. */
function mix(...tracks) {
  const length = Math.max(...tracks.map((t) => t.length));
  return Array.from({ length }, (_, i) => tracks.reduce((sum, t) => sum + (t[i] ?? 0), 0));
}

function wav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s)) * 32_767), i * 2));
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const SOUNDS = {
  // Countdown blip for the last 5 seconds of entry.
  tick: render([{ f: N.A6, dur: 0.045, wave: 'square', duty: 0.25, vol: 0.34, decay: 40 }]),

  // Bet placed: a quick two-note coin.
  bet: render([
    { f: N.B5, dur: 0.06, wave: 'square', duty: 0.25, vol: 0.32 },
    { f: N.E6, dur: 0.16, wave: 'square', duty: 0.25, vol: 0.32, decay: 9 },
  ]),

  // Win: rising arpeggio into a held, wobbling top note, with a triangle bass under it.
  win: mix(
    render([
      { f: N.C5, dur: 0.07, wave: 'square', duty: 0.5, vol: 0.2 },
      { f: N.E5, dur: 0.07, wave: 'square', duty: 0.5, vol: 0.2 },
      { f: N.G5, dur: 0.07, wave: 'square', duty: 0.5, vol: 0.2 },
      { f: N.C6, dur: 0.07, wave: 'square', duty: 0.5, vol: 0.2 },
      { f: N.G5, dur: 0.06, wave: 'square', duty: 0.25, vol: 0.2 },
      { f: N.C6, dur: 0.26, wave: 'square', duty: 0.25, vol: 0.22, decay: 3, vib: 7 },
    ]),
    render([
      { f: N.C5 / 2, dur: 0.28, wave: 'triangle', vol: 0.32 },
      { f: N.G4 / 2, dur: 0.06, wave: 'triangle', vol: 0.32 },
      { f: N.C5 / 2, dur: 0.26, wave: 'triangle', vol: 0.32, decay: 3 },
    ]),
  ),

  // Loss: the sad trombone, four falling steps with a sliding, wobbling last one.
  loss: mix(
    render([
      { f: N.G4, dur: 0.11, wave: 'square', duty: 0.5, vol: 0.18 },
      { f: N.Fs4, dur: 0.11, wave: 'square', duty: 0.5, vol: 0.18 },
      { f: N.F4, dur: 0.11, wave: 'square', duty: 0.5, vol: 0.18 },
      { f: N.E4, to: N.E4 * 0.84, dur: 0.21, wave: 'square', duty: 0.5, vol: 0.18, decay: 2.5, vib: 6 },
    ]),
    render([
      { f: N.G4 / 2, dur: 0.11, wave: 'triangle', vol: 0.3 },
      { f: N.Fs4 / 2, dur: 0.11, wave: 'triangle', vol: 0.3 },
      { f: N.F4 / 2, dur: 0.11, wave: 'triangle', vol: 0.3 },
      { f: N.E4 / 2, to: (N.E4 / 2) * 0.84, dur: 0.21, wave: 'triangle', vol: 0.3, decay: 2.5 },
    ]),
  ),
};

mkdirSync(OUT, { recursive: true });
for (const [name, samples] of Object.entries(SOUNDS)) {
  const file = wav(samples);
  if (file.length > MAX_BYTES) throw new Error(`${name}.wav is ${file.length} bytes, over ${MAX_BYTES}`);
  writeFileSync(join(OUT, `${name}.wav`), file);
  console.log(`${name}.wav  ${(samples.length / RATE).toFixed(2)} s  ${file.length} bytes`);
}
