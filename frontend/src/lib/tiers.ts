/**
 * Jackpot tier constants and the qualification ladder.
 *
 * Mirrors backend/internal/jackpot/tiers.go — a wallet unlocks a tier by
 * accumulating enough prior small-tier jackpot wins. The backend is the
 * authority on qualification (it verifies this on `/tickets/confirm`); the
 * frontend only needs these thresholds to label tiers in the picker. Keep
 * in sync if tiers.go's thresholds ever change.
 */

export type JackpotTier = 'small' | 'medium' | 'mega' | 'legend';

/** Every tier, ascending by qualification requirement. Small is always first. */
export const JACKPOT_TIERS: JackpotTier[] = ['small', 'medium', 'mega', 'legend'];

/** Number of prior small-tier wins required to unlock each tier. */
export const TIER_ENTRY_THRESHOLDS: Record<JackpotTier, number> = {
  small: 0,
  medium: 1,
  mega: 3,
  legend: 10,
};

export const TIER_LABELS: Record<JackpotTier, string> = {
  small: 'Small',
  medium: 'Medium',
  mega: 'Mega',
  legend: 'Legend',
};

/** Human-readable unlock requirement, e.g. "Unlock with 1 win". */
export function tierRequirementLabel(tier: JackpotTier): string {
  const n = TIER_ENTRY_THRESHOLDS[tier];
  if (n === 0) return 'No wins required';
  return `Unlock with ${n} win${n === 1 ? '' : 's'}`;
}

/** Display-only glyph per tier — used by the tier ladder and picker UI. */
export const TIER_ICONS: Record<JackpotTier, string> = {
  small: '🥈',
  medium: '🥇',
  mega: '💎',
  legend: '👑',
};

/**
 * Display-only Tailwind class fragments per tier, so the jackpot ladder and
 * ticket picker share one consistent accent scheme instead of each
 * component inventing its own colors. Purely presentational — has no
 * bearing on qualification, which the backend enforces on confirm.
 */
export const TIER_ACCENT: Record<
  JackpotTier,
  { gradient: string; text: string; border: string; bg: string; glow: string; dot: string }
> = {
  small: {
    gradient: 'from-cyan-500 to-cyan-300',
    text: 'text-cyan-300',
    border: 'border-cyan-400/40',
    bg: 'bg-cyan-500/10',
    glow: 'shadow-cyan-500/30',
    dot: 'bg-cyan-300',
  },
  medium: {
    gradient: 'from-purple-500 to-fuchsia-400',
    text: 'text-purple-300',
    border: 'border-purple-400/40',
    bg: 'bg-purple-500/10',
    glow: 'shadow-purple-500/30',
    dot: 'bg-purple-300',
  },
  mega: {
    gradient: 'from-pink-500 to-rose-400',
    text: 'text-pink-300',
    border: 'border-pink-400/40',
    bg: 'bg-pink-500/10',
    glow: 'shadow-pink-500/30',
    dot: 'bg-pink-300',
  },
  legend: {
    gradient: 'from-amber-400 to-yellow-300',
    text: 'text-amber-300',
    border: 'border-amber-400/40',
    bg: 'bg-amber-500/10',
    glow: 'shadow-amber-400/30',
    dot: 'bg-amber-300',
  },
};
