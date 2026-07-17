/**
 * "How to play" copy for every game — the single source for the homepage
 * guide modal, the pre-game overlay on /play, and the /practice idle
 * panel. Goal/controls text is written from the actual win conditions and
 * input handling in each game's own index.ts (and mirrors the exact input
 * semantics in lib/gameRegistry.ts) — not guessed.
 *
 * Keyed by game slug (the id every page already has); `name`/`icon` let
 * the play/practice pages render a proper title without re-declaring them.
 */
export interface GameGuide {
  name: string;
  icon: string;
  goal: string;
  /** One sentence naming the concrete win condition, with the live target
   * number substituted in where the page knows it ("{target}"). */
  objective: string;
  controls: { desktop: string; mobile: string };
  tip?: string;
}

export const GAME_GUIDES: Record<string, GameGuide> = {
  'wing-rush': {
    name: 'Wing Rush',
    icon: '🐦',
    goal: 'Fly through the gaps between pipes. Touching a pipe, the ground, or the ceiling ends the run.',
    objective: 'Pass {target} pipes to win.',
    controls: {
      desktop: 'Click or press Space to flap upward — gravity does the rest',
      mobile: 'Tap anywhere on the board to flap upward',
    },
    tip: 'Short, frequent flaps are easier to control than big rescues.',
  },
  'dino-sprint': {
    name: 'Dino Sprint',
    icon: '🏃',
    goal: 'Your dino runs automatically. Jump over every obstacle — hitting one ends the run.',
    objective: 'Clear {target} obstacles to win.',
    controls: {
      desktop: 'Click or press Space to jump (only while on the ground)',
      mobile: 'Tap anywhere on the board to jump',
    },
    tip: 'Jump late rather than early — the arc carries you further than it looks.',
  },
  'perfect-stack': {
    name: 'Perfect Stack',
    icon: '🔄',
    goal: 'A block slides back and forth above your tower. Lock it in as precisely as you can — any overhang is sliced off, and the next block starts that much smaller. Miss completely and the game ends.',
    objective: 'Stack {target} blocks before you run out of width.',
    controls: {
      desktop: 'Click or press Space to lock the moving block',
      mobile: 'Tap anywhere on the board to lock the moving block',
    },
    tip: 'The block speeds up as the tower grows — bank precision early.',
  },
  'reaction-test': {
    name: 'Reaction Test',
    icon: '⏱️',
    goal: 'Wait for the GO signal, then react as fast as you can. Your average over several rounds is what counts — and jumping the gun costs you.',
    objective: 'Beat the target average reaction time across all rounds to win.',
    controls: {
      desktop: 'Click or press Space the instant the signal appears',
      mobile: 'Tap the board the instant the signal appears',
    },
    tip: 'Stay relaxed and watch the screen, not the clock.',
  },
  'block-merge': {
    name: 'Block Merge',
    icon: '🧩',
    goal: 'A 2048-style puzzle: every slide moves all tiles at once, and equal tiles that collide merge into one of double the value. Each move also spawns a new tile — run out of moves or space and it’s over.',
    objective: 'Build a single {target} tile within the move budget to win.',
    controls: {
      desktop: 'Arrow keys to slide all tiles in that direction',
      mobile: 'Swipe on the board in any direction',
    },
    tip: 'Keep your biggest tile in a corner and build toward it.',
  },
  'simon-pro': {
    name: 'Simon Pro',
    icon: '🧠',
    goal: 'Watch the buttons flash in sequence during WATCH, then repeat the exact order during YOUR TURN. Every round replays the full sequence with one new step added. One wrong button ends the game.',
    objective: 'Repeat a {target}-step sequence to win.',
    controls: {
      desktop: 'Press the number keys shown on the buttons (1–6), or click them',
      mobile: 'Tap the buttons in the order they flashed',
    },
    tip: 'Say the sequence in your head as it plays — sound memory beats color memory.',
  },
  'aim-master': {
    name: 'Aim Master',
    icon: '🎯',
    goal: 'Targets pop up around the field and shrink away fast. Hit them before they vanish — accuracy and speed both matter.',
    objective: 'Score {target} points before time runs out.',
    controls: {
      desktop: 'Click each target as it appears',
      mobile: 'Tap each target as it appears',
    },
    tip: 'Aim for the center — bigger targets are worth hitting early while they’re large.',
  },
  'sliding-puzzle': {
    name: 'Sliding Puzzle',
    icon: '🧊',
    goal: 'Slide numbered tiles into the empty slot until they read 1, 2, 3… in order, left to right, top to bottom, with the empty slot ending bottom-right.',
    objective: 'Solve the puzzle within the move limit to win — "Par" is the benchmark, the move limit is the real deadline.',
    controls: {
      desktop: 'Click any tile next to the empty slot to slide it (or arrow keys)',
      mobile: 'Tap any tile next to the empty slot to slide it',
    },
    tip: 'Solve the top row first, then the left column, and repeat on what remains.',
  },
  'helix-drop': {
    name: 'Helix Drop',
    icon: '🌀',
    goal: 'A ball rests on a rotating tower. Spin the tower so the gap comes under the ball and it falls through to the next platform — but never sweep the red danger zone under it.',
    objective: 'Fall through {target} platforms to win.',
    controls: {
      desktop: 'Hold ← / → arrow keys to rotate the tower',
      mobile: 'Touch and hold the left or right half of the board to rotate',
    },
    tip: 'Approach the gap from the side away from the red zone — one direction is always safe.',
  },
  minefield: {
    name: 'Minefield',
    icon: '💣',
    goal: 'Reveal tiles one by one. Each number tells you how many mines touch that tile. Hit a mine and it’s over.',
    objective: 'Reveal every safe tile without detonating a mine.',
    controls: {
      desktop: 'Click a tile to reveal it',
      mobile: 'Tap a tile to reveal it',
    },
    tip: 'Start from tiles adjacent to low numbers — a "1" with one flagged neighbor makes every other neighbor safe.',
  },
};

/** Fills the live target number into a guide's objective line. */
export function objectiveText(guide: GameGuide, target: number | null | undefined): string {
  if (target == null || target === 0) return guide.objective.replace('{target}', '…');
  return guide.objective.replace('{target}', String(target));
}
