/**
 * Level history → waveform geometry.
 *
 * Two things make this read like a recorder rather than a level meter, and both
 * are here rather than in the component so they can be tested without a
 * microphone:
 *
 *   * **Each column is an aggregate** of a slice of time (mean intensity over
 *     ~400ms), so the strip advances a couple of columns a second instead of one
 *     per level sample. One sample moves the shape by a fraction of a column.
 *   * **Amplitudes are scaled against the recent average**, so a quiet speaker
 *     still gets a lively shape instead of a nearly flat line, and a loud one
 *     does not clip everything flat.
 */

export interface ColumnOptions {
  /** Canvas width in CSS pixels. */
  width: number;
  /** Canvas height in CSS pixels. */
  height: number;
  /** Pixels per column. */
  pitch?: number;
  /** Level samples aggregated per column. At 20/s, 8 is a 400ms slice. */
  samplesPerColumn?: number;
  /** How far above the recent average the scale is set. */
  gain?: number;
  /** Floor on the scale, so near-silence is not amplified into noise. */
  minReference?: number;
  /** Half-height floor, so silence still draws a line. */
  minHalf?: number;
}

export interface Columns {
  slots: number;
  pitch: number;
  /** Aggregate intensity per column, left to right, before scaling. */
  columns: number[];
  /** Half-height per column, left to right, in CSS pixels. */
  half: number[];
  /** The adaptive scale the columns were divided by. */
  reference: number;
}

const clamp01 = (value: number): number => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);

export function levelColumns(
  values: number[],
  { width, height, pitch = 2, samplesPerColumn = 8, gain = 1.6, minReference = 0.02, minHalf = 1 }: ColumnOptions,
): Columns {
  const slots = Math.max(2, Math.floor(width / pitch));
  const needed = slots * samplesPerColumn;
  const window = values.slice(-needed);
  // Right-aligned: with less history than the canvas holds, the gap stays on the
  // left so new audio enters from the right.
  const offset = needed - window.length;

  const columns: number[] = [];
  for (let slot = 0; slot < slots; slot += 1) {
    const start = slot * samplesPerColumn - offset;
    let sum = 0;
    let count = 0;
    for (let i = 0; i < samplesPerColumn; i += 1) {
      const index = start + i;
      if (index < 0 || index >= window.length) continue;
      sum += clamp01(window[index]);
      count += 1;
    }
    columns.push(count ? sum / count : 0);
  }

  // The "learning" part: scale against the recent average so variation stays
  // visible at any input level.
  const mean = columns.reduce((total, value) => total + value, 0) / Math.max(1, columns.length);
  const reference = Math.max(minReference, mean * gain);
  const reach = Math.max(1, height / 2 - minHalf);
  const half = columns.map((value) => Math.max(minHalf, Math.min(1, value / reference) * reach));

  return { slots, pitch, columns, half, reference };
}
