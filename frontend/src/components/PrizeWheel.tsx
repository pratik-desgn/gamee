'use client';

import { useMemo } from 'react';

// The platform's ten real games — slugs match the backend's game ids
// (lib/gameRegistry.ts) so callers can land the wheel on an actual
// assigned game; names/icons match the Featured Games section. Colors are
// the brand's five-hue set repeated twice: adjacent wedges always differ
// and the wrap-around seam is as clean as any interior boundary.
export const WHEEL_GAMES = [
  { slug: 'wing-rush', name: 'Wing Rush', icon: '🐦', color: '#06b6d4' },
  { slug: 'dino-sprint', name: 'Dino Sprint', icon: '🏃', color: '#8b5cf6' },
  { slug: 'perfect-stack', name: 'Perfect Stack', icon: '🔄', color: '#0ea5e9' },
  { slug: 'reaction-test', name: 'Reaction Test', icon: '⏱️', color: '#d946ef' },
  { slug: 'block-merge', name: 'Block Merge', icon: '🧩', color: '#6366f1' },
  { slug: 'simon-pro', name: 'Simon Pro', icon: '🧠', color: '#06b6d4' },
  { slug: 'aim-master', name: 'Aim Master', icon: '🎯', color: '#8b5cf6' },
  { slug: 'sliding-puzzle', name: 'Sliding Puzzle', icon: '🧊', color: '#0ea5e9' },
  { slug: 'helix-drop', name: 'Helix Drop', icon: '🌀', color: '#d946ef' },
  { slug: 'minefield', name: 'Minefield', icon: '💣', color: '#6366f1' },
];

export const SEG = 360 / WHEEL_GAMES.length;

const SIZE = 340; // viewBox units; element scales via CSS
const CENTER = SIZE / 2;
const RIM_R = SIZE / 2 - 4;
const WHEEL_R = RIM_R - 12;
const HUB_R = 34;
const LABEL_START_R = HUB_R + 12;
const LABEL_SPAN = WHEEL_R - 26 - 12 - LABEL_START_R - 4;

/** angle 0 = straight up, sweeping clockwise. */
function pt(angleDeg: number, r: number) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: CENTER + r * Math.cos(rad), y: CENTER + r * Math.sin(rad) };
}

function wedgePath(startDeg: number, endDeg: number): string {
  const o1 = pt(startDeg, WHEEL_R);
  const o2 = pt(endDeg, WHEEL_R);
  const i1 = pt(endDeg, HUB_R + 2);
  const i2 = pt(startDeg, HUB_R + 2);
  return [
    `M ${o1.x} ${o1.y}`,
    `A ${WHEEL_R} ${WHEEL_R} 0 0 1 ${o2.x} ${o2.y}`,
    `L ${i1.x} ${i1.y}`,
    `A ${HUB_R + 2} ${HUB_R + 2} 0 0 0 ${i2.x} ${i2.y}`,
    'Z',
  ].join(' ');
}

/**
 * Given the wheel's accumulated rotation and a target wedge index, return
 * the new accumulated rotation that lands that wedge's midpoint under the
 * pointer after `revolutions` extra full turns. Computed as a delta from
 * the CURRENT resting angle — rotation accumulates across spins, so a
 * fixed absolute target is only correct when the accumulated value is a
 * multiple of 360 (i.e. never after the first spin).
 */
export function rotationToLandOn(prevRotation: number, index: number, revolutions = 6): number {
  const current = ((prevRotation % 360) + 360) % 360;
  const desired = (360 - (index * SEG + SEG / 2)) % 360;
  const delta = (desired - current + 360) % 360;
  return prevRotation + 360 * revolutions + delta;
}

export interface PrizeWheelProps {
  /** Accumulated rotation in degrees; animate by increasing it. */
  rotation: number;
  /** Transition duration for the current rotation change (0 = instant). */
  spinMs: number;
  /** CSS timing function for the current rotation change. */
  easing?: string;
  className?: string;
}

/**
 * Presentational carnival prize wheel (SVG face + pointer + glow), fully
 * controlled via `rotation`/`spinMs` so different pages can drive it
 * differently: the homepage runs an ambient land-pause-spin loop, /spin
 * idles it steadily during the real on-chain randomness draw and then
 * lands it on the actually-assigned game. Face content (names, icons) is
 * oriented radially — the face rotates, so anything drawn "upright" is
 * only upright at one specific angle; radial is correct at every stop.
 */
export default function PrizeWheel({ rotation, spinMs, easing, className }: PrizeWheelProps) {
  const wedges = useMemo(
    () =>
      WHEEL_GAMES.map((g, i) => {
        const start = i * SEG;
        const mid = start + SEG / 2;
        return {
          game: g,
          path: wedgePath(start, start + SEG),
          mid,
          iconPos: pt(mid, WHEEL_R - 26),
          labelPos: pt(mid, LABEL_START_R),
        };
      }),
    [],
  );

  const bulbs = useMemo(
    () => Array.from({ length: WHEEL_GAMES.length * 2 }, (_, i) => pt(i * (SEG / 2), RIM_R - 6)),
    [],
  );

  return (
    <div className={`relative select-none ${className ?? 'h-[300px] w-[300px] sm:h-[340px] sm:w-[340px]'}`}>
      {/* Ambient glow behind everything */}
      <div
        className="absolute inset-[-10%] rounded-full blur-3xl opacity-70"
        style={{ background: 'radial-gradient(circle, rgba(139,92,246,0.4), rgba(6,182,212,0.22) 55%, transparent 72%)' }}
        aria-hidden
      />

      {/* Pointer — static, above the rotating face, with a pivot pin */}
      <div className="absolute left-1/2 top-[3px] z-20 -translate-x-1/2">
        <svg width="34" height="34" viewBox="0 0 34 34" fill="none" className="drop-shadow-[0_3px_8px_rgba(0,0,0,0.55)]">
          <path d="M17 30 L6 8 Q17 1 28 8 Z" fill="url(#ptr)" stroke="rgba(255,255,255,0.5)" strokeWidth="1" />
          <circle cx="17" cy="9" r="4.5" fill="#0e0e1a" stroke="rgba(255,255,255,0.6)" strokeWidth="1.5" />
          <defs>
            <linearGradient id="ptr" x1="17" y1="1" x2="17" y2="30">
              <stop offset="0%" stopColor="#f5f3ff" />
              <stop offset="100%" stopColor="#c4b5fd" />
            </linearGradient>
          </defs>
        </svg>
      </div>

      <svg
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className="relative z-10 h-full w-full"
        style={{
          transform: `rotate(${rotation}deg)`,
          transitionProperty: 'transform',
          transitionDuration: `${spinMs}ms`,
          transitionTimingFunction: easing ?? 'cubic-bezier(0.12, 0.68, 0.10, 1)',
        }}
      >
        <defs>
          {WHEEL_GAMES.map((g, i) => (
            <linearGradient
              key={i}
              id={`wedge-${i}`}
              gradientUnits="userSpaceOnUse"
              x1={CENTER}
              y1={CENTER}
              x2={pt(i * SEG + SEG / 2, WHEEL_R).x}
              y2={pt(i * SEG + SEG / 2, WHEEL_R).y}
            >
              <stop offset="0%" stopColor={g.color} stopOpacity="0.55" />
              <stop offset="55%" stopColor={g.color} stopOpacity="0.95" />
              <stop offset="100%" stopColor={g.color} stopOpacity="1" />
            </linearGradient>
          ))}
          <radialGradient id="hub-sheen" cx="35%" cy="28%" r="75%">
            <stop offset="0%" stopColor="#fff" stopOpacity="0.45" />
            <stop offset="100%" stopColor="#fff" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="face-vignette" cx="50%" cy="50%" r="50%">
            <stop offset="78%" stopColor="#000" stopOpacity="0" />
            <stop offset="100%" stopColor="#000" stopOpacity="0.35" />
          </radialGradient>
        </defs>

        {/* Carnival rim */}
        <circle cx={CENTER} cy={CENTER} r={RIM_R} fill="#12101f" stroke="rgba(255,255,255,0.16)" strokeWidth="2" />
        <circle cx={CENTER} cy={CENTER} r={WHEEL_R + 1.5} fill="none" stroke="rgba(255,255,255,0.10)" strokeWidth="1" />

        {wedges.map(({ game, path }, i) => (
          <path key={game.slug} d={path} fill={`url(#wedge-${i})`} stroke="#0c0a17" strokeWidth="2" />
        ))}

        <circle cx={CENTER} cy={CENTER} r={WHEEL_R} fill="url(#face-vignette)" pointerEvents="none" />

        {/* Radial name labels — horizontal text rotated by (mid − 90°) so
            it reads hub→rim along the wedge centerline; textLength
            force-fits every name to the same radial span. */}
        {wedges.map(({ game, mid, labelPos }) => (
          <text
            key={`label-${game.slug}`}
            x={labelPos.x}
            y={labelPos.y}
            transform={`rotate(${mid - 90} ${labelPos.x} ${labelPos.y})`}
            fontSize="11"
            fontWeight="700"
            letterSpacing="0.06em"
            fill="rgba(255,255,255,0.95)"
            textAnchor="start"
            dominantBaseline="central"
            textLength={LABEL_SPAN}
            lengthAdjust="spacingAndGlyphs"
            style={{ filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.7))' }}
          >
            {game.name.toUpperCase()}
          </text>
        ))}

        {/* Icons near the rim, rotated to point outward with the wedge */}
        {wedges.map(({ game, mid, iconPos }) => (
          <text
            key={`icon-${game.slug}`}
            x={iconPos.x}
            y={iconPos.y}
            transform={`rotate(${mid} ${iconPos.x} ${iconPos.y})`}
            fontSize="24"
            textAnchor="middle"
            dominantBaseline="central"
            style={{ filter: 'drop-shadow(0 1px 3px rgba(0,0,0,0.8))' }}
          >
            {game.icon}
          </text>
        ))}

        {/* Rim bulbs */}
        {bulbs.map((b, i) => (
          <circle
            key={i}
            cx={b.x}
            cy={b.y}
            r={i % 2 === 0 ? 3 : 2}
            fill={i % 2 === 0 ? '#fde68a' : 'rgba(255,255,255,0.55)'}
            style={i % 2 === 0 ? { filter: 'drop-shadow(0 0 3px rgba(253,230,138,0.9))' } : undefined}
          />
        ))}

        {/* Hub */}
        <circle cx={CENTER} cy={CENTER} r={HUB_R} fill="#0e0e1a" stroke="rgba(255,255,255,0.25)" strokeWidth="2.5" />
        <circle cx={CENTER} cy={CENTER} r={HUB_R - 6} fill="none" stroke="rgba(139,92,246,0.55)" strokeWidth="1.5" />
        <circle cx={CENTER} cy={CENTER} r={HUB_R} fill="url(#hub-sheen)" opacity="0.35" />
        <text x={CENTER} y={CENTER} fontSize="26" textAnchor="middle" dominantBaseline="central">
          🎡
        </text>
      </svg>
    </div>
  );
}
