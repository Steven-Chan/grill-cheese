import { useEffect, useRef } from "react";

interface Props {
  size?: number; // css px
  fps?: number;
  // "fire" = animated flame, "cheese" = static cheese wedge (done state)
  state?: "fire" | "cheese";
  // override fire -> dot shrink duration (ms). default 750.
  fireShrinkMs?: number;
  style?: React.CSSProperties; // merged onto canvas (overrides width/height)
}

// 16x16 cheese-wedge sprite, side-view (pixel emoji style).
// Diagonal top face (bright Y) sloping up to a peak on the right,
// rectangular darker front face (D) below, scattered holes (h), full
// black outline (B).
const CHEESE: readonly string[] = [
  "................",
  "................",
  "................",
  "................",
  "................",
  "................",
  ".............BBB",
  ".........BBBBYYB",
  ".....BBBBYYYYYYB",
  "..BBBYYYhYYYYYYB",
  "..BDDDDDDDDDDDDB",
  "..BDDhDDDDDDDhDB",
  "..BDDDDDDhDDDDDB",
  "..BDDDDDDDDDDDDB",
  "..BDhDDDDDDDDhDB",
  "..BBBBBBBBBBBBBB",
];

// 16x16 pixel-art flame / cheese; CSS upscales w/ image-rendering: pixelated
export function FireAnimation({
  size = 80,
  fps = 7,
  state = "fire",
  fireShrinkMs = 750,
  style,
}: Props) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const fireShrinkRef = useRef(fireShrinkMs);
  fireShrinkRef.current = fireShrinkMs;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const interval = 1000 / fps;
    let renderedMode: "fire" | "cheese" = stateRef.current;
    let prevMode: "fire" | "cheese" = stateRef.current;
    let modeStart = performance.now();
    let prev = modeStart;
    let raf = 0;
    let cancelled = false;

    const y = [2, 1, 0, 0, 0, 0, 1, 2];
    const max = [7, 9, 11, 13, 13, 11, 9, 7];
    const min = [4, 7, 8, 10, 10, 8, 7, 4];
    const IGNITE_MS = 750; // fire base-only -> full bloom
    const MORPH_MS = 750; // dot -> cheese reveal
    // mode handoff: outgoing fades + center dot grows, dot holds, then incoming
    const DOT_HOLD_MS = 400;

    // offscreen canvas for fire so we can drawImage it with arbitrary scale
    // anchored at the dot center (mirror of how cheese scales from the dot).
    const fireCanvas = document.createElement("canvas");
    fireCanvas.width = 16;
    fireCanvas.height = 16;
    const fctx = fireCanvas.getContext("2d");

    const drawFire = (f: number, alpha: number = 1, scale: number = 1) => {
      if (scale <= 0 || !fctx) return;

      // render flame into offscreen at full 16x16, flipped-y
      fctx.clearRect(0, 0, 16, 16);
      fctx.save();
      fctx.setTransform(1, 0, 0, -1, 0, 16);

      // outer red — spreads outward from center (x=7.5) as f grows
      const spread = 0.6 + f * 4;
      fctx.strokeStyle = "#d14234";
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
        fctx.beginPath();
        fctx.moveTo(x + 0.5, y[i++]);
        fctx.lineTo(x + 0.5, a);
        fctx.stroke();
      }

      // mid orange — after 30%
      if (f > 0.3) {
        const ff = (f - 0.3) / 0.7;
        fctx.strokeStyle = "#f2a55f";
        let j = 1;
        for (let x = 5; x < 11; x++) {
          const full = Math.random() * (max[j] - 5 - (min[j] - 5) + 1) + (min[j] - 5);
          const base = y[j] + 2;
          const a = base + (full - base) * ff;
          fctx.beginPath();
          fctx.moveTo(x + 0.5, y[j++] + 1);
          fctx.lineTo(x + 0.5, a);
          fctx.stroke();
        }
      }

      // inner cream — after 60%
      if (f > 0.6) {
        const ff = (f - 0.6) / 0.4;
        fctx.strokeStyle = "#e8dec5";
        let k = 3;
        for (let x = 7; x < 9; x++) {
          const full = Math.random() * (max[k] - 9 - (min[k] - 9) + 1) + (min[k] - 9);
          const base = y[k] + 1;
          const a = base + (full - base) * ff;
          fctx.beginPath();
          fctx.moveTo(x + 0.5, y[k++]);
          fctx.lineTo(x + 0.5, a);
          fctx.stroke();
        }
      }

      fctx.restore();

      // composite to main canvas with scale anchored at dot center (8, 9)
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.globalAlpha = alpha;
      const w = 16 * scale;
      const h = 16 * scale;
      const dx = 8 - 8 * scale;
      const dy = 9 - 9 * scale;
      ctx.drawImage(fireCanvas, dx, dy, w, h);
      ctx.restore();
    };

    // small yellow pixel-circle at canvas center — the morph intermediate
    const drawDot = (scale: number) => {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "#f4e84a";
      const cx = 8;
      const cy = 9; // sit on cheese body's vertical center
      const r = 0.5 + scale; // 0.5 -> 1.5 -> ~3px diameter at scale=1
      for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          if (Math.sqrt(dx * dx + dy * dy) <= r) {
            ctx.fillRect(cx + dx, cy + dy, 1, 1);
          }
        }
      }
      ctx.restore();
    };

    // pre-render cheese sprite once into an offscreen canvas; later we can
    // drawImage it at any scale (with smoothing off) for crisp pixel scaling.
    const cheeseCanvas = document.createElement("canvas");
    cheeseCanvas.width = 16;
    cheeseCanvas.height = 16;
    const cctx = cheeseCanvas.getContext("2d");
    if (cctx) {
      for (let r = 0; r < 16; r++) {
        const row = CHEESE[r];
        for (let c = 0; c < 16; c++) {
          const ch = row[c];
          if (ch === ".") continue;
          cctx.fillStyle =
            ch === "Y"
              ? "#f4e84a"
              : ch === "D"
                ? "#e8a51e"
                : ch === "h"
                  ? "#a86b18"
                  : "#1a1006";
          cctx.fillRect(c, r, 1, 1);
        }
      }
    }

    // draw cheese scaled around the dot center (8, 9). scale=1 = full size,
    // scale=0 = invisible. nearest-neighbor scaling keeps pixels crisp.
    const drawCheese = (alpha: number, scale: number = 1) => {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.globalAlpha = alpha;
      if (scale <= 0) {
        ctx.restore();
        return;
      }
      const w = 16 * scale;
      const h = 16 * scale;
      const dx = 8 - 8 * scale;
      const dy = 9 - 9 * scale;
      ctx.drawImage(cheeseCanvas, dx, dy, w, h);
      ctx.restore();
    };

    const tick = (now: number) => {
      if (cancelled) return;
      if (now - prev > interval) {
        prev = now;
        // pick up mode prop changes
        if (stateRef.current !== renderedMode) {
          prevMode = renderedMode;
          renderedMode = stateRef.current;
          modeStart = now;
        }
        ctx.clearRect(0, 0, 16, 16);
        const elapsed = now - modeStart;
        const transitioning = prevMode !== renderedMode;
        // per-frame so caller can tune via prop without remounting the effect
        const FIRE_SHRINK_MS = fireShrinkRef.current;
        const HANDOFF_END = FIRE_SHRINK_MS + DOT_HOLD_MS;

        // fire -> cheese: 3-phase via dot (fire shrinks into dot, then cheese).
        // cheese -> fire: no dot; cheese fades out while fire ignites.
        if (transitioning && renderedMode === "cheese" && elapsed < FIRE_SHRINK_MS) {
          // fire shrinks uniformly toward the dot at (8, 9) — full bloom but
          // scale 1 -> 0 (mirror of how cheese grows from the dot).
          const t = elapsed / FIRE_SHRINK_MS;
          drawFire(1, 1, 1 - t);
          // dot only emerges in the last 30% so it minimally overlaps the fire.
          const dotScale = Math.max(0, (t - 0.7) / 0.3);
          if (dotScale > 0) drawDot(dotScale);
        } else if (transitioning && renderedMode === "cheese" && elapsed < HANDOFF_END) {
          drawDot(1);
        } else if (renderedMode === "cheese") {
          const inElapsed = transitioning ? elapsed - HANDOFF_END : elapsed;
          const t = Math.min(1, inElapsed / MORPH_MS);
          const eased = 1 - Math.pow(1 - t, 3);
          // dot stays visible until cheese has grown past it
          if (transitioning && eased < 0.5) drawDot(1);
          // cheese scales from 0 (dot-sized) to 1 (full)
          const scale = transitioning ? eased : 1;
          drawCheese(1, scale);
        } else {
          // fire mode — cheese -> fire is an instant swap; only fire's own
          // ignite animation plays.
          const t = Math.min(1, elapsed / IGNITE_MS);
          const f = t <= 0 ? 0 : Math.pow(2, 10 * (t - 1));
          drawFire(f, 1);
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
