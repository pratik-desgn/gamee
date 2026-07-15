/**
 * "How to play" copy for each game's card on the homepage. Goal/controls
 * text is written from the actual win conditions and input handling in
 * each game's own index.ts (and mirrors the exact clickMode semantics in
 * lib/gameRegistry.ts / games/playground/main.ts) — not guessed.
 */
export interface GameGuide {
  goal: string;
  controls: string[];
}

export const GAME_GUIDES: Record<string, GameGuide> = {
  'Wing Rush': {
    goal: 'Fly through the gaps between pipes without hitting one or the ground. Reach the target number of pipes passed to win.',
    controls: ['Click, tap, or press Space to flap upward'],
  },
  'Dino Sprint': {
    goal: 'Keep running and jump over every obstacle. Reach the target score before you hit one.',
    controls: ['Click, tap, or press Space to jump'],
  },
  'Perfect Stack': {
    goal: 'A block swings back and forth above your tower. Lock it into place as precisely as possible — sloppy drops shrink the block. Reach the target score before your stack runs out of room.',
    controls: ['Click, tap, or press Space to lock the moving block'],
  },
  'Reaction Test': {
    goal: 'Wait for the "go" signal, then react as fast as you can — averaged over several rounds. Beat the target reaction time to win; jumping the gun costs you.',
    controls: ['Click or press Space the instant the signal appears'],
  },
  'Block Merge': {
    goal: 'A 2048-style puzzle — slide tiles to merge matching numbers. Build a single tile of the target value (512, 1024, or 2048 depending on difficulty) to win.',
    controls: ['Arrow keys to slide all tiles in a direction', 'On touch screens: swipe on the board'],
  },
  'Simon Pro': {
    goal: 'Each button flashes in a sequence during "WATCH" — repeat it back in the exact same order during "YOUR TURN". Each round adds one more step to memorize. Reach the target sequence length to win.',
    controls: ['Press the number shown on each button (1–6), in the order it flashed'],
  },
  'Aim Master': {
    goal: 'Targets pop up briefly across the field — click them before they disappear. Hit enough targets to reach the score threshold and win.',
    controls: ['Click each target as it appears'],
  },
  'Sliding Puzzle': {
    goal: 'Slide numbered tiles around the one empty slot to restore the goal arrangement. Solve it within the move limit — fewer moves is better.',
    controls: ['Arrow keys, or click any tile adjacent to the empty slot'],
  },
  'Helix Drop': {
    goal: 'A ball rests on a rotating tower. Rotate the gap underneath it to let it fall through to the next level — but don’t sweep the red danger zone under it first. Pass enough levels to win.',
    controls: ['Hold Arrow Left / Arrow Right to rotate the tower', 'On touch screens: hold the left or right side of the board'],
  },
  Minefield: {
    goal: 'Click tiles to reveal them. Numbers tell you how many mines are in the adjacent tiles. Reveal every safe tile without hitting a mine to win.',
    controls: ['Click a tile to reveal it'],
  },
};
