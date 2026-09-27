import { useEffect, useRef, type RefObject } from "react";
import { cn } from "../../lib/utils";

/** Bar geometry, matching the reference component's defaults. */
const BAR_WIDTH = 4;
const BAR_GAP = 2;
const BAR_RADIUS = 2;
const MIN_BAR = 3;

/**
 * Live input level as a scrolling bar waveform — newest on the right, older bars
 * fading out.
 *
 * Drawn on a canvas from its own animation-frame loop rather than from React
 * state: level samples arrive ~20x/second and re-rendering the composer at that
 * rate would be wasteful. `peaks` is a mutable ref the recorder fills in.
 */
export function VoiceWaveform({
  peaks,
  active,
  className,
}: {
  peaks: RefObject<number[]>;
  active: boolean;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    let frame = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (!width || !height) return;
      if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
      }
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);
      context.fillStyle = getComputedStyle(canvas).color;

      const pitch = BAR_WIDTH + BAR_GAP;
      const slots = Math.max(1, Math.floor(width / pitch));
      const values = (peaks.current ?? []).slice(-slots);
      // Right-aligned: when the history is shorter than the canvas, the empty
      // space stays on the left so new bars enter from the right.
      const offset = slots - values.length;
      const middle = height / 2;
      for (let i = 0; i < slots; i += 1) {
        const value = i < offset ? 0 : (values[i - offset] ?? 0);
        const barHeight = value <= 0 ? MIN_BAR : Math.max(MIN_BAR, Math.min(height, value * height));
        // Older bars (left) fade out; the newest (right) are full strength.
        const age = slots > 1 ? i / (slots - 1) : 1;
        context.globalAlpha = (active ? 0.2 + age * 0.8 : 0.15 + age * 0.35) * (value <= 0 ? 0.5 : 1);
        const x = i * pitch;
        const y = middle - barHeight / 2;
        if (typeof context.roundRect === "function") {
          context.beginPath();
          context.roundRect(x, y, BAR_WIDTH, barHeight, BAR_RADIUS);
          context.fill();
        } else {
          context.fillRect(x, y, BAR_WIDTH, barHeight);
        }
      }
      context.globalAlpha = 1;
    };

    const tick = () => {
      draw();
      // Respect reduced-motion by redrawing slowly rather than every frame.
      if (reduced) timer = setTimeout(tick, 120);
      else frame = requestAnimationFrame(tick);
    };
    tick();

    return () => {
      cancelAnimationFrame(frame);
      if (timer) clearTimeout(timer);
    };
  }, [peaks, active]);

  return <canvas ref={canvasRef} aria-hidden className={cn("h-5 w-24 shrink-0 text-foreground/75", className)} />;
}
