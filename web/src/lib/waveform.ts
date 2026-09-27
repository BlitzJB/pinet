/**
 * Level history → waveform geometry, kept pure so the scrolling behaviour is
 * testable without a microphone.
 *
 * The newest sample always sits at the right edge and everything captured before
 * it is shifted left, which is what makes it read as a recording rather than a
 * level meter.
 */

export interface SlotOptions {
  /** Canvas width in CSS pixels. */
  width: number;
  /** Canvas height in CSS pixels. */
  height: number;
  /** Pixels per level sample. */
  pitch?: number;
  /** Half-height floor, so silence still draws a line. */
  minHalf?: number;
}

export interface Slots {
  slots: number;
  pitch: number;
  /** Half-height per slot, left to right, in CSS pixels. */
  half: number[];
}

export function levelSlots(values: number[], { width, height, pitch = 2, minHalf = 1 }: SlotOptions): Slots {
  const slots = Math.max(2, Math.floor(width / pitch));
  const window = values.slice(-slots);
  // Right-aligned: with less history than the canvas can hold, the gap stays on
  // the left so new samples enter from the right.
  const offset = slots - window.length;
  const reach = Math.max(1, height / 2 - minHalf);
  const half = Array.from({ length: slots }, (_, index) => {
    if (index < offset) return minHalf;
    const value = Math.min(1, Math.max(0, window[index - offset] ?? 0));
    return Math.max(minHalf, value * reach);
  });
  return { slots, pitch, half };
}
