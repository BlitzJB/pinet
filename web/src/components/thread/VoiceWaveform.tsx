import { useEffect, useRef, type RefObject } from "react";
import { cn } from "../../lib/utils";

/** Horizontal pitch, in CSS pixels, between level samples. */
const PITCH = 2;
/** Half-height floor so silence still reads as a line. */
const MIN_HALF = 1;

/**
 * Live input level as a scrolling envelope — amplitude over time, newest on the
 * right, older audio fading to the left. Drawn as one mirrored filled path (the
 * shape a voice recorder shows) rather than as separate vertical bars, so it
 * still reads as a timeline when it is only a couple of centimetres wide.
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
      context.globalAlpha = active ? 0.95 : 0.5;

      const slots = Math.max(2, Math.floor(width / PITCH));
      const history = peaks.current ?? [];
      const values = history.slice(-slots);
      const offset = slots - values.length;
      const middle = height / 2;
      const reach = middle - MIN_HALF;

      const half = (index: number) => {
        if (index < offset) return 0;
        const value = values[index - offset] ?? 0;
        return Math.max(MIN_HALF, Math.min(1, value) * reach);
      };

      // Mirrored envelope: left-to-right along the top, then back along the
      // bottom, so it fills like a waveform rather than a row of bars.
      context.beginPath();
      context.moveTo(PITCH / 2, middle - half(0));
      for (let i = 1; i < slots; i += 1) context.lineTo(i * PITCH + PITCH / 2, middle - half(i));
      for (let i = slots - 1; i >= 0; i -= 1) context.lineTo(i * PITCH + PITCH / 2, middle + half(i));
      context.closePath();
      context.fill();

      // Age fade: erase the left side progressively, so recent audio stands out.
      const fade = context.createLinearGradient(0, 0, width, 0);
      fade.addColorStop(0, "rgba(0, 0, 0, 0.8)");
      fade.addColorStop(0.45, "rgba(0, 0, 0, 0.25)");
      fade.addColorStop(1, "rgba(0, 0, 0, 0)");
      context.globalCompositeOperation = "destination-out";
      context.fillStyle = fade;
      context.fillRect(0, 0, width, height);
      context.globalCompositeOperation = "source-over";
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

  return <canvas ref={canvasRef} aria-hidden className={cn("h-4 w-12 shrink-0 text-foreground/80 sm:w-14", className)} />;
}
