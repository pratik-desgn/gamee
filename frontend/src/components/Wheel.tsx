'use client';

import { useEffect, useRef, useState } from 'react';
import PrizeWheel, { WHEEL_GAMES, rotationToLandOn } from '@/components/PrizeWheel';

const SPIN_MS = 4200;
const PAUSE_MS = 2600;

/**
 * Homepage hero wrapper around the shared PrizeWheel: spins on its own on
 * a loop, purely as ambient motion illustrating the "spin picks your
 * game" mechanic. Deliberately has no button and no connection to the
 * real /spin flow (a control that looks clickable but does nothing real
 * is worse than none; the page's actual CTA is "🎮 Play Now"). The real
 * spin experience — this same wheel landing on the actually-assigned
 * game — lives on /spin.
 */
export default function Wheel() {
  const [rotation, setRotation] = useState(0);
  const [spinning, setSpinning] = useState(false);
  const [landed, setLanded] = useState<typeof WHEEL_GAMES[number] | null>(null);
  const timeoutRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    const runSpin = () => {
      setSpinning(true);
      setLanded(null);
      const index = Math.floor(Math.random() * WHEEL_GAMES.length);
      setRotation((prev) => rotationToLandOn(prev, index));
      timeoutRef.current = window.setTimeout(() => {
        setSpinning(false);
        setLanded(WHEEL_GAMES[index]);
        timeoutRef.current = window.setTimeout(runSpin, PAUSE_MS);
      }, SPIN_MS);
    };

    timeoutRef.current = window.setTimeout(runSpin, 900);
    return () => window.clearTimeout(timeoutRef.current);
  }, []);

  return (
    <div className="flex flex-col items-center gap-4">
      <PrizeWheel rotation={rotation} spinMs={spinning ? SPIN_MS : 0} />
      <div className="h-12 flex items-center justify-center text-sm text-gamee-muted">
        {landed ? (
          <span className="flex items-center gap-2 animate-fade-in-up">
            <span aria-hidden className="text-base">{landed.icon}</span>
            Landed on <span className="font-semibold text-gamee-text">{landed.name}</span>
          </span>
        ) : (
          'A verifiable random spin picks your game…'
        )}
      </div>
    </div>
  );
}
