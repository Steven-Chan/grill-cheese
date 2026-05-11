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
    let prev = performance.now();
    let raf = 0;
    let cancelled = false;

    const y = [2, 1, 0, 0, 0, 0, 1, 2];
    const max = [7, 9, 11, 13, 13, 11, 9, 7];
    const min = [4, 7, 8, 10, 10, 8, 7, 4];

    const tick = (now: number) => {
      if (cancelled) return;
      if (now - prev > interval) {
        prev = now;
        ctx.clearRect(0, 0, 16, 16);

        // outer red
        ctx.strokeStyle = "#d14234";
        let i = 0;
        for (let x = 4; x < 12; x++) {
          const a = Math.random() * (max[i] - min[i] + 1) + min[i];
          ctx.beginPath();
          ctx.moveTo(x + 0.5, y[i++]);
          ctx.lineTo(x + 0.5, a);
          ctx.stroke();
        }

        // mid orange
        ctx.strokeStyle = "#f2a55f";
        let j = 1;
        for (let x = 5; x < 11; x++) {
          const a = Math.random() * (max[j] - 5 - (min[j] - 5) + 1) + (min[j] - 5);
          ctx.beginPath();
          ctx.moveTo(x + 0.5, y[j++] + 1);
          ctx.lineTo(x + 0.5, a);
          ctx.stroke();
        }

        // inner cream
        ctx.strokeStyle = "#e8dec5";
        let k = 3;
        for (let x = 7; x < 9; x++) {
          const a = Math.random() * (max[k] - 9 - (min[k] - 9) + 1) + (min[k] - 9);
          ctx.beginPath();
          ctx.moveTo(x + 0.5, y[k++]);
          ctx.lineTo(x + 0.5, a);
          ctx.stroke();
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
      style={{ width: size, height: size, ...style }}
    />
  );
}
