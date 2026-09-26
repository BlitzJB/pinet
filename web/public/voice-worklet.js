// Dictation capture worklet.
//
// Served as a real same-origin file rather than built from a Blob URL: the app's
// Content-Security-Policy is `worker-src 'self'`, which blocks `blob:` worklets
// outright. Loading a Blob silently failed every capture attempt on every
// browser — the button did nothing and said nothing, which is exactly how it was
// reported. Do not move this back to a Blob without relaxing the CSP.
//
// 128-sample render quantum frames are batched to ~250ms before being posted, so
// the main thread receives ~4 messages a second instead of ~370.

class PinetCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.parts = [];
    this.total = 0;
    this.want = Math.round((sampleRate * 250) / 1000);
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) {
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
        this.port.postMessage(merged, [merged.buffer]);
      }
    }
    // Keep the processor alive even while the track is silent.
    return true;
  }
}

registerProcessor("pinet-capture", PinetCapture);
