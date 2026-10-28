// Microphone capture for voicemail and live calls.
// Captures mono audio, resamples to 24 kHz 16-bit PCM (what Muse Voice Transcribe expects),
// and either hands back a WAV (voicemail) or streams 80 ms frames (live call).

const RATE = 24000;
const FRAME = (RATE * 80) / 1000; // 1920 samples = 80 ms

const workletSrc = `
class Tap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('tap', Tap);
`;

function downsample(input, fromRate) {
  if (fromRate === RATE) return input;
  const ratio = fromRate / RATE;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio), end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    out[i] = sum / Math.max(1, end - start);
  }
  return out;
}

function toInt16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

export function wavFromInt16(samples) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE');
  w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, RATE, true); v.setUint32(28, RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, samples.length * 2, true);
  new Int16Array(buf, 44).set(samples);
  return new Blob([buf], { type: 'audio/wav' });
}

// Start the mic. onFrame(Int16Array of 1920 samples) is called every 80 ms. onLevel(0..1) for a meter.
export async function startMic({ onFrame, onLevel } = {}) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  const ctx = new AudioContext();
  const url = URL.createObjectURL(new Blob([workletSrc], { type: 'application/javascript' }));
  await ctx.audioWorklet.addModule(url);
  const src = ctx.createMediaStreamSource(stream);
  const tap = new AudioWorkletNode(ctx, 'tap');
  src.connect(tap);
  const all = [];
  let pending = new Int16Array(0);
  tap.port.onmessage = (e) => {
    const f32 = e.data;
    if (onLevel) {
      let peak = 0;
      for (let i = 0; i < f32.length; i++) peak = Math.max(peak, Math.abs(f32[i]));
      onLevel(peak);
    }
    const pcm = toInt16(downsample(f32, ctx.sampleRate));
    all.push(pcm);
    const merged = new Int16Array(pending.length + pcm.length);
    merged.set(pending);
    merged.set(pcm, pending.length);
    let off = 0;
    while (merged.length - off >= FRAME) {
      onFrame?.(merged.slice(off, off + FRAME));
      off += FRAME;
    }
    pending = merged.slice(off);
  };
  return {
    stop() {
      stream.getTracks().forEach((t) => t.stop());
      tap.disconnect();
      src.disconnect();
      ctx.close();
      const total = all.reduce((n, a) => n + a.length, 0);
      const joined = new Int16Array(total);
      let o = 0;
      for (const a of all) {
        joined.set(a, o);
        o += a.length;
      }
      return { samples: joined, seconds: total / RATE };
    },
  };
}
