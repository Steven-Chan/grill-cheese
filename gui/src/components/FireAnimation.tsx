import { useEffect, useRef } from "react";

interface Props {
  size?: number; // css px
  fps?: number;
  style?: React.CSSProperties; // merged onto canvas (overrides width/height)
}

// 16x16 pixel-art flame; CSS upscales w/ image-rendering: pixelated
export function FireAnimation({ size = 80, fps = 7, style }: Props) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // flip y so 0 = bottom
    ctx.setTransform(1, 0, 0, -1, 0, 16);

    const interval = 1000 / fps;
    const start = performance.now();
    let prev = start;
    let raf = 0;
    let cancelled = false;

    const y = [2, 1, 0, 0, 0, 0, 1, 2];
    const max = [7, 9, 11, 13, 13, 11, 9, 7];
    const min = [4, 7, 8, 10, 10, 8, 7, 4];
    const IGNITE_MS = 750; // base-only -> full bloom

    const tick = (now: number) => {
      if (cancelled) return;
      if (now - prev > interval) {
        prev = now;
        // f: 0 = base only, 1 = full flame; easeInExpo
        const t = Math.min(1, (now - start) / IGNITE_MS);
        const f = t <= 0 ? 0 : Math.pow(2, 10 * (t - 1));
        ctx.clearRect(0, 0, 16, 16);

        // outer red — spreads outward from center (x=7.5) as f grows;
        // at f=0 only the 2 middle columns light = a dot, not a U
        const spread = 0.6 + f * 4; // radius in columns from center
        ctx.strokeStyle = "#d14234";
        let i = 0;
        for (let x = 4; x < 12; x++) {
          const dist = Math.abs(x + 0.5 - 8);
          if (dist > spread) {
            i++;
            continue;
          }
          const colF = Math.min(1, (spread - dist) / 1.5);
          const full = Math.random() * (max[i] - min[i] + 1) + min[i];
          const base = y[i] + 1;
          const a = base + (full - base) * f * colF;
          ctx.beginPath();
          ctx.moveTo(x + 0.5, y[i++]);
          ctx.lineTo(x + 0.5, a);
          ctx.stroke();
        }

        // mid orange — fades in after 30% ignite
        if (f > 0.3) {
          const ff = (f - 0.3) / 0.7;
          ctx.strokeStyle = "#f2a55f";
          let j = 1;
          for (let x = 5; x < 11; x++) {
            const full = Math.random() * (max[j] - 5 - (min[j] - 5) + 1) + (min[j] - 5);
            const base = y[j] + 2;
            const a = base + (full - base) * ff;
            ctx.beginPath();
            ctx.moveTo(x + 0.5, y[j++] + 1);
            ctx.lineTo(x + 0.5, a);
            ctx.stroke();
          }
        }

        // inner cream — fades in after 60% ignite
        if (f > 0.6) {
          const ff = (f - 0.6) / 0.4;
          ctx.strokeStyle = "#e8dec5";
          let k = 3;
          for (let x = 7; x < 9; x++) {
            const full = Math.random() * (max[k] - 9 - (min[k] - 9) + 1) + (min[k] - 9);
            const base = y[k] + 1;
            const a = base + (full - base) * ff;
            ctx.beginPath();
            ctx.moveTo(x + 0.5, y[k++]);
            ctx.lineTo(x + 0.5, a);
            ctx.stroke();
          }
        }
      }
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(raf);
    };
  }, [fps]);

  return (
    <canvas
      ref={ref}
      width={16}
      height={16}
      className="gc-fire"
      style={{
        width: size,
        height: size * 1.4,
        paddingBottom: size * 0.4,
        boxSizing: "border-box",
        ...style,
      }}
    />
  );
}
