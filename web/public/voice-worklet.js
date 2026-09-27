// Dictation capture worklet.
//
// Served as a real same-origin file rather than built from a Blob URL: the app's
// Content-Security-Policy is `worker-src 'self'`, which blocks `blob:` worklets
// outright. Loading a Blob silently failed every capture attempt on every
// browser — the button did nothing and said nothing, which is exactly how it was
// reported. Do not move this back to a Blob without relaxing the CSP.
//
// Two things are posted to the main thread:
//   * { peaks }  — level samples ~20x/second, for the waveform
//   * { audio }  — ~250ms of samples, so the main thread gets 4 messages a
//                  second for audio instead of ~370
//
// 128-sample render quanta are used as-is; batching happens here.

const PEAK_INTERVAL_MS = 50;

class PinetCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.parts = [];
    this.total = 0;
    this.want = Math.round((sampleRate * 250) / 1000);
    this.quantumPeaks = [];
    this.lastPeakAt = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel || !channel.length) return true;

    let peak = 0;
    for (let i = 0; i < channel.length; i += 1) {
      const value = Math.abs(channel[i]);
      if (value > peak) peak = value;
    }
    this.quantumPeaks.push(peak);

    const nowMs = (currentFrame / sampleRate) * 1000;
    if (nowMs - this.lastPeakAt >= PEAK_INTERVAL_MS) {
      this.port.postMessage({ peaks: this.quantumPeaks });
      this.quantumPeaks = [];
      this.lastPeakAt = nowMs;
    }

    this.parts.push(channel.slice(0));
    this.total += channel.length;
    if (this.total >= this.want) {
      const merged = new Float32Array(this.total);
      let offset = 0;
      for (const part of this.parts) {
        merged.set(part, offset);
        offset += part.length;
      }
      this.parts = [];
      this.total = 0;
      this.port.postMessage({ audio: merged }, [merged.buffer]);
    }

    // Keep the processor alive even while the track is silent.
    return true;
  }
}

registerProcessor("pinet-capture", PinetCapture);
