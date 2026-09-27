import { useEffect, useRef, type RefObject } from "react";
import { cn } from "../../lib/utils";
import { levelColumns } from "../../lib/waveform";

/**
 * The captured audio as a scrolling waveform: everything recorded so far is on
 * screen, shifted left as new samples arrive, with the newest at the right edge.
 *
 * Drawn as one mirrored filled path rather than as separate bars so it stays
 * legible in a strip this narrow, and drawn from its own animation-frame loop
 * rather than from React state — level samples arrive 10x/second and re-rendering
 * the composer at that rate would be wasteful. `peaks` is a mutable ref the
 * recorder fills in.
 *
 * The history is deliberately *not* faded out: an age gradient made earlier audio
 * invisible, which left only the newest fragment visible and read as a level
 * meter of the current moment instead of a recording. Pacing and scaling live in
 * lib/waveform.ts — columns aggregate ~400ms each and are scaled against the
 * recent average, so it scrolls slowly and stays lively at any input level.
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
      context.globalAlpha = active ? 0.95 : 0.55;

      const { slots, pitch, half } = levelColumns(peaks.current ?? [], { width, height });
      const middle = height / 2;
      const x = (index: number) => index * pitch + pitch / 2;

      context.beginPath();
      context.moveTo(x(0), middle - half[0]);
      for (let i = 1; i < slots; i += 1) context.lineTo(x(i), middle - half[i]);
      for (let i = slots - 1; i >= 0; i -= 1) context.lineTo(x(i), middle + half[i]);
      context.closePath();
      context.fill();
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

  return <canvas ref={canvasRef} aria-hidden className={cn("h-5 w-16 shrink-0 text-foreground/80 sm:w-20", className)} />;
}
