import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { cn } from "../../lib/cn";

/**
 * A slider drawn as a red rubber band stretched between two thumbtacks on the board. The left tack
 * is fixed; the right one is the thumb. Pull it out of the board, drag it along, and let go: it
 * pushes back in where the value rounds to, snapping back if it was pulled past either end. Near
 * the minimum the band goes slack and droops; further out it pulls taut and thins. No numbers are
 * shown; the page reads the value from `onChange`.
 */
export interface RubberBandProps {
  value: number;
  min: number;
  max: number;
  /** Values round to a multiple of this from `min`. */
  step?: number;
  onChange: (value: number) => void;
  /** Rendered width in px; the band spans it edge to edge. */
  width?: number;
  className?: string;
  "aria-label"?: string;
}

/** How far past either end the thumb can be pulled, with the pull resisting more the further it goes. */
const OVER = 40;
const PIN_R = 9;
const BAND_W = 5.5;
/** The track ends this far from the right edge; pulled past it, the band draws outside the box. */
const EDGE = 22;
/**
 * The component's layout box is only as tall as a tack. The drawing surface is bigger than that
 * box in every direction, placed over it, so the droop, an overpull and a lifted tack all draw past
 * the box over the page without depending on the webview honouring overflow on an svg.
 */
const HEIGHT = PIN_R * 2 + 16;
const BAND_Y = HEIGHT / 2;
const BLEED_X = OVER + PIN_R * 2 + 8;
const BLEED_TOP = 28;
/** The fixed tack sits here; the thumb's track starts just to its right so the two never overlap. */
const FIXED_X = 24;
const TRACK_START = FIXED_X + 30;

// Springs: the thumb snaps home with a little overshoot, the droop lags behind and wobbles.
const X_STIFF = 320;
const X_DAMP = 17;
const SAG_STIFF = 150;
const SAG_DAMP = 6.5;

interface Sim {
  x: number;
  vx: number;
  sag: number;
  vsag: number;
  dragging: boolean;
  /** Where the tack came out of the board, drawn as a hole until it goes back in. */
  hole: number | null;
  holeAge: number;
  grab: number;
  last: number;
  raf: number;
}

interface Frame {
  x: number;
  sag: number;
  lifted: boolean;
  hole: number | null;
  holeAlpha: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Pulling past an end gives less and less: the first few px are easy, the last are nearly stuck. */
function resist(over: number): number {
  return OVER * (1 - Math.exp(-over / OVER));
}

export function RubberBand({ value, min, max, step = 1, onChange, width = 320, className, "aria-label": ariaLabel = "Rubber band slider" }: RubberBandProps) {
  const gradId = useId();
  const trackEnd = width - EDGE;
  const trackLen = trackEnd - TRACK_START;
  /** The band's unstretched length: taut from a bit under halfway, slack before that. */
  const restLen = (trackEnd - FIXED_X) * 0.5;
  // Below the band: the deepest droop plus the wobble past it.
  const bleedBottom = Math.ceil(0.42 * restLen + 24);

  const span = max - min || 1;
  const restXFor = useCallback((v: number) => TRACK_START + clamp((v - min) / span, 0, 1) * trackLen, [min, span, trackLen]);
  const valueAt = useCallback((x: number) => {
    const raw = min + (clamp(x, TRACK_START, trackEnd) - TRACK_START) / trackLen * span;
    return clamp(min + Math.round((raw - min) / step) * step, min, max);
  }, [min, max, span, step, trackLen, trackEnd]);

  const sim = useRef<Sim>({ x: restXFor(value), vx: 0, sag: 0, vsag: 0, dragging: false, hole: null, holeAge: 0, grab: 0, last: 0, raf: 0 });
  const [frame, setFrame] = useState<Frame>({ x: sim.current.x, sag: 0, lifted: false, hole: null, holeAlpha: 0 });

  const restX = useRef(restXFor(value));
  restX.current = restXFor(value);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  /** How far the band droops for a given distance between tacks: a slack string hangs as a shallow V. */
  const sagFor = useCallback((d: number) => (d >= restLen ? 0 : 0.42 * Math.sqrt(restLen * restLen - d * d)), [restLen]);

  const wake = useCallback(() => {
    const s = sim.current;
    if (s.raf) return;
    s.last = performance.now();
    const tick = (now: number) => {
      const dt = clamp((now - s.last) / 1000, 0, 1 / 30);
      s.last = now;
      if (!s.dragging) {
        const ax = -X_STIFF * (s.x - restX.current) - X_DAMP * s.vx;
        s.vx += ax * dt;
        s.x += s.vx * dt;
      }
      const target = sagFor(s.x - FIXED_X);
      const as = -SAG_STIFF * (s.sag - target) - SAG_DAMP * s.vsag;
      s.vsag += as * dt;
      s.sag += s.vsag * dt;
      if (s.hole !== null && !s.dragging) s.holeAge += dt;
      const holeAlpha = s.hole === null ? 0 : s.dragging ? 1 : Math.max(0, 1 - s.holeAge / 0.6);
      if (holeAlpha === 0) s.hole = null;
      setFrame({ x: s.x, sag: s.sag, lifted: s.dragging, hole: s.hole, holeAlpha });
      const settled = !s.dragging && Math.abs(s.x - restX.current) < 0.05 && Math.abs(s.vx) < 0.5
        && Math.abs(s.sag - target) < 0.05 && Math.abs(s.vsag) < 0.5 && s.hole === null;
      if (settled) {
        s.x = restX.current; s.vx = 0; s.sag = target; s.vsag = 0;
        setFrame({ x: s.x, sag: s.sag, lifted: false, hole: null, holeAlpha: 0 });
        s.raf = 0;
      } else {
        s.raf = requestAnimationFrame(tick);
      }
    };
    s.raf = requestAnimationFrame(tick);
  }, [sagFor]);

  // The value moved from outside (keyboard, a reset): the thumb springs over to it.
  useEffect(() => { wake(); }, [value, width, wake]);
  useEffect(() => () => { if (sim.current.raf) cancelAnimationFrame(sim.current.raf); }, []);

  const onPointerDown = (e: PointerEvent<SVGGElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const s = sim.current;
    s.dragging = true;
    s.vx = 0;
    s.grab = e.clientX - s.x;
    s.hole = s.x;
    s.holeAge = 0;
    wake();
  };
  const onPointerMove = (e: PointerEvent<SVGGElement>) => {
    const s = sim.current;
    if (!s.dragging) return;
    const raw = e.clientX - s.grab;
    s.x = raw > trackEnd ? trackEnd + resist(raw - trackEnd) : raw < TRACK_START ? TRACK_START - resist(TRACK_START - raw) : raw;
    const next = valueAt(s.x);
    if (next !== value) onChangeRef.current(next);
    wake();
  };
  const onPointerUp = (e: PointerEvent<SVGGElement>) => {
    const s = sim.current;
    if (!s.dragging) return;
    s.dragging = false;
    e.currentTarget.releasePointerCapture(e.pointerId);
    // Letting go of a stretched band twangs it: the further from home, the bigger the pluck.
    s.vsag -= Math.abs(s.x - restX.current) * 5;
    wake();
  };

  const onKeyDown = (e: KeyboardEvent<SVGSVGElement>) => {
    const by: Record<string, number> = { ArrowRight: step, ArrowUp: step, ArrowLeft: -step, ArrowDown: -step, PageUp: step * 10, PageDown: -step * 10 };
    const next = e.key === "Home" ? min : e.key === "End" ? max : e.key in by ? clamp(value + by[e.key], min, max) : null;
    if (next === null) return;
    e.preventDefault();
    if (next !== value) onChange(next);
  };

  const d = frame.x - FIXED_X;
  const stretch = Math.max(1, d / restLen);
  const bandW = clamp(BAND_W / Math.sqrt(stretch), 3, BAND_W);
  const midX = (FIXED_X + frame.x) / 2;
  const path = `M ${FIXED_X} ${BAND_Y} Q ${midX} ${BAND_Y + 2 * frame.sag} ${frame.x} ${BAND_Y}`;

  return (
    <span
      role="slider"
      tabIndex={0}
      aria-label={ariaLabel}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      onKeyDown={onKeyDown}
      style={{ width, height: HEIGHT }}
      className={cn("relative z-10 block rounded-xl outline-none select-none focus-visible:ring-2 focus-visible:ring-lake/60", className)}
    >
      <svg
        width={width + 2 * BLEED_X}
        height={BLEED_TOP + HEIGHT + bleedBottom}
        viewBox={`${-BLEED_X} ${-BLEED_TOP} ${width + 2 * BLEED_X} ${BLEED_TOP + HEIGHT + bleedBottom}`}
        style={{ left: -BLEED_X, top: -BLEED_TOP }}
        className="pointer-events-none absolute max-w-none touch-none"
      >
        <defs>
          <radialGradient id={gradId} cx="35%" cy="30%" r="75%">
            <stop offset="0" stopColor="#f3a98c" />
            <stop offset="0.45" stopColor="var(--color-clay)" />
            <stop offset="1" stopColor="#a84b2e" />
          </radialGradient>
        </defs>

        {/* A pencilled guide along the track, min to max, with a short tick at each end. */}
        <g stroke="var(--color-rim)" strokeWidth={1.5} strokeLinecap="round" opacity={0.4} fill="none">
          <path d={`M ${TRACK_START} ${BAND_Y} L ${trackEnd} ${BAND_Y}`} strokeDasharray="1 6" />
          <path d={`M ${TRACK_START} ${BAND_Y - 5} V ${BAND_Y + 5} M ${trackEnd} ${BAND_Y - 5} V ${BAND_Y + 5}`} />
        </g>

        {frame.hole !== null && (
          <circle cx={frame.hole} cy={BAND_Y} r={2.6} fill="var(--color-mud)" opacity={0.45 * frame.holeAlpha} />
        )}

        {/* The band: a shadow on the board, the red body, and a sheen along its top. */}
        <path d={path} fill="none" stroke="rgba(43,30,22,0.22)" strokeWidth={bandW} strokeLinecap="round" transform="translate(1.5 3)" />
        <path d={path} fill="none" stroke="#d2342c" strokeWidth={bandW} strokeLinecap="round" />
        <path d={path} fill="none" stroke="#ff8f7f" strokeWidth={bandW * 0.3} strokeLinecap="round" opacity={0.8} transform="translate(0 -1.1)" />

        <Tack x={FIXED_X} y={BAND_Y} gradId={gradId} lifted={false} />
        <g
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          className={cn("pointer-events-auto", frame.lifted ? "cursor-grabbing" : "cursor-grab")}
        >
          {/* A wider invisible target so the tack is easy to grab. */}
          <circle cx={frame.x} cy={BAND_Y} r={PIN_R + 10} fill="transparent" />
          <Tack x={frame.x} y={BAND_Y} gradId={gradId} lifted={frame.lifted} />
        </g>
      </svg>
    </span>
  );
}

/** A thumbtack head. Lifted, it rises off the board, grows, and its shadow spreads out beneath. */
function Tack({ x, y, gradId, lifted }: { x: number; y: number; gradId: string; lifted: boolean }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <ellipse
        cx={lifted ? 3 : 1.5} cy={lifted ? 7 : 3} rx={lifted ? PIN_R * 1.3 : PIN_R} ry={lifted ? PIN_R * 0.9 : PIN_R * 0.8}
        fill="rgba(43,30,22,0.3)" opacity={lifted ? 0.6 : 1}
        style={{ transition: "all 120ms ease-out" }}
      />
      <g style={{ transform: lifted ? "translateY(-5px) scale(1.18)" : "none", transition: "transform 120ms ease-out" }}>
        <circle r={PIN_R} fill={`url(#${gradId})`} stroke="var(--color-rim)" strokeWidth={2} />
        <circle cx={-3} cy={-3.2} r={2.6} fill="#fff" opacity={0.45} />
      </g>
    </g>
  );
}
