/**
 * "How to play" copy for every game — the single source for the homepage
 * guide modal, the pre-game overlay on /play, and the /practice idle
 * panel. Written from the actual win conditions and input handling in
 * each game's own index.ts (and mirrors the exact input semantics in
 * lib/gameRegistry.ts) — not guessed.
 *
 * Structure is deliberately scannable for someone who has never seen the
 * game: what it is (goal), what to actually do (steps, in order), and
 * the exact win/lose conditions. Every page also offers a self-playing
 * demo (lib/demoBots.ts) for players who learn by watching.
 *
 * Keyed by game slug (the id every page already has).
 */
export interface GameGuide {
  name: string;
  icon: string;
  /** One-line what-is-this. */
  goal: string;
  /** What to actually do, in order, device-neutral. */
  steps: string[];
  /** Exact win condition — "{target}" is replaced with the live number. */
  win: string;
  lose: string;
  controls: { desktop: string; mobile: string };
  tip?: string;
}

export const GAME_GUIDES: Record<string, GameGuide> = {
  'wing-rush': {
    name: 'Wing Rush',
    icon: '🐦',
    goal: 'Flappy-bird style: keep the bird airborne and thread it through the pipe gaps.',
    steps: [
      'Tap to flap — every tap pushes the bird UP a little; gravity pulls it down between taps.',
      'Nothing moves until your first tap, so take your time.',
      'Keep tapping in short bursts to hover, and line the bird up with the gap in each pipe.',
    ],
    win: 'Pass {target} pipes.',
    lose: 'Touch a pipe, the ground, or the ceiling.',
    controls: {
      desktop: 'Click or press Space to flap',
      mobile: 'Tap anywhere on the board to flap',
    },
    tip: 'Small frequent taps beat big rescues — aim slightly below the gap center.',
  },
  'dino-sprint': {
    name: 'Dino Sprint',
    icon: '🏃',
    goal: 'Endless-runner: your dino runs by itself — your only job is jumping over obstacles.',
    steps: [
      'Tap to jump. The run starts on your first jump.',
      'Watch the obstacles sliding in from the right.',
      'Time each jump so the arc carries you over the obstacle — you can only jump while on the ground.',
    ],
    win: 'Clear {target} obstacles.',
    lose: 'Run into an obstacle.',
    controls: {
      desktop: 'Click or press Space to jump',
      mobile: 'Tap anywhere on the board to jump',
    },
    tip: 'Jump a beat later than feels natural — the arc is longer than it looks.',
  },
  'perfect-stack': {
    name: 'Perfect Stack',
    icon: '🔄',
    goal: 'Tower-stacking: a block slides side to side — drop it exactly on top of the previous one.',
    steps: [
      'Watch the block slide back and forth above the tower.',
      'Tap to lock it in place the moment it lines up with the block below.',
      'Any part that overhangs gets sliced off — the next block starts that much smaller.',
    ],
    win: 'Stack {target} blocks.',
    lose: 'Miss the tower completely (or shrink the block to nothing).',
    controls: {
      desktop: 'Click or press Space to lock the block',
      mobile: 'Tap anywhere on the board to lock the block',
    },
    tip: 'It speeds up as you go — bank perfect drops early while it’s slow.',
  },
  'reaction-test': {
    name: 'Reaction Test',
    icon: '⏱️',
    goal: 'Pure reflexes: tap the instant the screen tells you GO — over several rounds.',
    steps: [
      'Wait while the screen shows the "wait" state. Don’t tap yet!',
      'The moment the GO signal flashes, tap as fast as you can.',
      'Repeat for every round — your AVERAGE reaction time is what counts.',
    ],
    win: 'Beat the target average reaction time across all rounds.',
    lose: 'Tap too early (false start) or react too slowly on average.',
    controls: {
      desktop: 'Click or press Space on the GO signal',
      mobile: 'Tap the board on the GO signal',
    },
    tip: 'Relax your hand and watch the screen — anticipating hurts more than it helps.',
  },
  'block-merge': {
    name: 'Block Merge',
    icon: '🧩',
    goal: '2048-style: slide ALL tiles at once and merge equal numbers into bigger ones.',
    steps: [
      'Swipe (or press an arrow key) — every tile on the board slides that way as far as it can.',
      'Two tiles with the SAME number that collide merge into one tile of double the value (2+2=4, 4+4=8…).',
      'Every move spawns one new small tile, and you have a limited number of moves — make each one merge something.',
    ],
    win: 'Build a single {target} tile before the moves run out.',
    lose: 'Run out of moves, or fill the board with no merges left.',
    controls: {
      desktop: 'Arrow keys to slide',
      mobile: 'Swipe on the board in any direction',
    },
    tip: 'Pick a corner, keep your biggest tile there, and mostly alternate two directions.',
  },
  'simon-pro': {
    name: 'Simon Pro',
    icon: '🧠',
    goal: 'Memory: watch buttons flash in order, then repeat the exact order back.',
    steps: [
      'During WATCH, the buttons light up one by one — memorize the order.',
      'When it says YOUR TURN, tap the buttons in that exact order.',
      'Each round replays the whole sequence with ONE new step added to the end.',
    ],
    win: 'Correctly repeat a {target}-step sequence.',
    lose: 'Tap one wrong button.',
    controls: {
      desktop: 'Click the buttons, or press their number keys (1–6)',
      mobile: 'Tap the buttons in order',
    },
    tip: 'Chant the numbers in your head as they flash — rhythm memory beats color memory.',
  },
  'aim-master': {
    name: 'Aim Master',
    icon: '🎯',
    goal: 'Target practice: hit the shrinking targets before they vanish.',
    steps: [
      'Targets pop up at random spots and immediately start shrinking.',
      'Tap each one before it disappears — dead-center hits score more.',
      'Keep scanning the whole board; several can be alive at once.',
    ],
    win: 'Score {target} points before the timer ends.',
    lose: 'Time runs out below the target score.',
    controls: {
      desktop: 'Click the targets',
      mobile: 'Tap the targets',
    },
    tip: 'Hit targets while they’re still big — early hits are worth the most.',
  },
  'sliding-puzzle': {
    name: 'Sliding Puzzle',
    icon: '🧊',
    goal: 'The classic 15-puzzle: slide tiles into the empty slot until the numbers are in order.',
    steps: [
      'Only tiles NEXT TO the empty slot can move — tap one and it slides into the gap.',
      'Shuffle tiles around until they read 1, 2, 3… left-to-right, top-to-bottom.',
      'The empty slot must end up in the bottom-right corner.',
    ],
    win: 'Restore the full order within the move limit ("Par" is a benchmark; the move limit is the real deadline).',
    lose: 'Use up all the moves before solving it.',
    controls: {
      desktop: 'Click a tile next to the empty slot (or arrow keys)',
      mobile: 'Tap a tile next to the empty slot',
    },
    tip: 'Solve the top row first, then the left column — then repeat on the smaller square that remains.',
  },
  'helix-drop': {
    name: 'Helix Drop',
    icon: '🌀',
    goal: 'A ball sits on a spinning tower — rotate the floor’s gap under it so it falls to the next level.',
    steps: [
      'The ball never moves sideways — YOU rotate the tower under it.',
      'Hold left or right to spin the platform. When its gap comes under the ball, the ball drops through — that’s a point.',
      'The RED zone next to the gap is deadly: rotate the direction that brings the GAP first, never the red.',
    ],
    win: 'Drop through {target} platforms.',
    lose: 'Let the red zone slide (or the ball land) under the ball.',
    controls: {
      desktop: 'Hold ← / → arrow keys to rotate',
      mobile: 'Touch and HOLD the left or right half of the board',
    },
    tip: 'Before each drop, look at which side of the gap is red — approach from the clean side.',
  },
  minefield: {
    name: 'Minefield',
    icon: '💣',
    goal: 'Minesweeper: reveal all the safe tiles, never a mine.',
    steps: [
      'Tap any tile to reveal it.',
      'A revealed number tells you how many mines touch that tile (diagonals count).',
      'Use the numbers to deduce which neighbors are safe, and keep revealing.',
    ],
    win: 'Reveal every safe tile.',
    lose: 'Reveal a mine.',
    controls: {
      desktop: 'Click a tile to reveal it',
      mobile: 'Tap a tile to reveal it',
    },
    tip: 'A "0" clears its whole neighborhood — start wide, then work the edges of the numbers.',
  },
};

/** Fills the live target number into a guide's win line. */
export function winText(guide: GameGuide, target: number | null | undefined): string {
  if (target == null || target === 0) return guide.win.replace('{target}', '…');
  return guide.win.replace('{target}', String(target));
}
