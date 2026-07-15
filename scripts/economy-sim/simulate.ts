#!/usr/bin/env node
/**
 * GAMEE — Monte Carlo Economy Simulator
 *
 * Simulates millions of game plays to validate jackpot economics.
 * Runs before mainnet to ensure:
 *   - Jackpot never needs treasury bailouts
 *   - Win frequency is exciting but sustainable
 *   - Treasury accumulates healthily
 *
 * Usage:
 *   npx ts-node scripts/economy-sim/simulate.ts
 *   npx ts-node scripts/economy-sim/simulate.ts --plays 500000 --days 50
 *
 * ─── Multi-tier routing policy ─────────────────────────────────────────────
 * Qualification (backend/internal/jackpot/tiers.go EntryThreshold) is
 * defined purely as "number of prior SMALL-tier wins". If a player abandoned
 * `small` entirely the moment they unlocked `medium`, they could never rack
 * up the 3 (mega) or 10 (legend) small wins needed to climb further — a dead
 * end. So each play is routed to exactly ONE tier chosen by a *weighted*
 * random pick among every tier the player currently qualifies for: `small`
 * always carries weight 2 (so progression never stalls), every other
 * unlocked tier carries weight 1 (still real, growing exposure to the
 * bigger/rarer pools once earned). Both that play's 80% jackpot cut AND its
 * win roll apply to the single chosen tier — see `playOnce()`. Only a win on
 * `small` increments a player's progression counter (tiers.go's threshold is
 * expressed in small wins only, so winning medium/mega/legend doesn't itself
 * unlock anything further) — see `resolveWin()`.
 */

// ─── Configuration ───────────────────────────────────────────────────────────

interface FeeSplit {
  /** % that goes to jackpot pool */
  jackpot: number;
  /** % that goes to platform treasury */
  platform: number;
  /** % that goes to referral pool */
  referral: number;
  /** % that goes to dev/operations */
  dev: number;
}

interface JackpotTier {
  name: string;
  /** Number of small-jackpot wins required to qualify */
  entryThreshold: number;
  /** Probability of winning when playing at this tier */
  winProb: number;
  /** Initial seed amount in USDC lamports */
  seedAmount: number;
  /** Current pool balance */
  balance: number;
  /** Total paid out from this tier */
  totalPaidOut: number;
  /** Number of times this tier was won */
  wins: number;
  /** Number of plays routed into this tier (contributed + rolled here) */
  plays: number;
  /** Times a win was rolled against this tier while its balance was <= 0
   *  (i.e. the tier couldn't pay — a bankruptcy event) */
  bankruptcyEvents: number;
}

interface SimulationConfig {
  /** Price per ticket in USDC lamports (1 USDC = 1_000_000) */
  ticketPrice: number;
  /** Number of plays per day */
  playsPerDay: number;
  /** Number of days to simulate */
  days: number;
  /** Fee split percentages (must sum to 1.0) */
  feeSplit: FeeSplit;
  /** Jackpot payout split: % to winner, % to seed next round */
  payoutSplit: { winner: number; seed: number };
  /** Jackpot tiers */
  tiers: JackpotTier[];
  /** Skill distribution of players: lower = bad, higher = good.
   *  Win prob multiplier per skill level. */
  skillDistribution: { label: string; pct: number; winMultiplier: number }[];
  /** Size of the simulated active-player ID pool. Player IDs are drawn
   *  uniformly from [0, playerPoolSize) on every play (memoryless — this
   *  is NOT total lifetime wallets, it's the concurrently-active cohort
   *  driving volume). Kept intentionally small (relative to total plays)
   *  so that repeat play density is high enough for the same player to
   *  plausibly rack up the 10 small-tier wins `legend` requires — with a
   *  huge, diffuse ID space, no single player would ever play often enough
   *  to reach that threshold and `legend` would never trigger. See
   *  docs/NEXT-STEPS.md multi-tier sim note for the derivation. */
  playerPoolSize: number;
  /** Output JSON instead of human-readable report */
  jsonOutput?: boolean;
}

const DEFAULT_CONFIG: SimulationConfig = {
  ticketPrice: 1_000_000, // 1 USDC
  // 80,000/day x 200 days = 16M plays by default. Volume is deliberately
  // higher than a single day's real traffic would be — see playerPoolSize
  // below: reaching `legend` needs a lot of repeat exposure per player, and
  // this is the smallest default volume that makes all 4 tiers trigger
  // reliably (empirically: near-certain legend trigger, see NEXT-STEPS.md).
  playsPerDay: 80_000,
  days: 200,
  feeSplit: { jackpot: 0.80, platform: 0.10, referral: 0.05, dev: 0.05 },
  payoutSplit: { winner: 0.95, seed: 0.05 },
  // winProb is the ONLY knob that sets each tier's average win size: with
  // the weighted-split routing below, contributions still land on a tier
  // every time it's *chosen*, so avgWinUSDC (in the winner's 95% share) is
  // independent of overall traffic volume/routing frequency and simplifies
  // to roughly 0.95 * 0.80 / winProb * meanSkillMultiplier(~1.205 given the
  // skill distribution below), i.e. avgWinUSDC ~= 0.63 / winProb.
  //   small:  0.63/0.000437 ~= 1,443 USDC  (target band: 1,000-2,000 USDC,
  //           matching the platform's documented average-jackpot goal; the
  //           backend difficulty governor in backend/internal/difficulty
  //           enforces the same band live from observed win rates)
  //   medium: 0.63/0.0001   ~= 6,300 USDC
  //   mega:   0.63/0.00005  ~= 12,600 USDC
  //   legend: 0.63/0.00002  ~= 31,500 USDC
  // — a clean, monotonically increasing ladder by tier.
  //
  // seedAmount for medium/mega/legend is no longer 0: since a tier's
  // balance only grows when a play is actually routed to it, a zero-seed
  // tier sits at literal 0 balance until its first contribution — a real
  // (if brief) bankruptcy window if a win is rolled before any contribution
  // has landed. A modest pre-seed proportional to each tier's rarity (as if
  // pre-funded by the platform at launch, same idea as small's existing 10
  // USDC seed) closes that window without materially affecting avgWinUSDC,
  // since the seed carries forward at only 5% per win and is quickly
  // dwarfed by accumulated contributions.
  tiers: [
    { name: 'small',  entryThreshold: 0,  winProb: 0.000437, seedAmount: 10_000_000,    balance: 0, totalPaidOut: 0, wins: 0, plays: 0, bankruptcyEvents: 0 },
    { name: 'medium', entryThreshold: 1,  winProb: 0.0001,   seedAmount: 200_000_000,   balance: 0, totalPaidOut: 0, wins: 0, plays: 0, bankruptcyEvents: 0 },
    { name: 'mega',   entryThreshold: 3,  winProb: 0.00005,  seedAmount: 1_000_000_000, balance: 0, totalPaidOut: 0, wins: 0, plays: 0, bankruptcyEvents: 0 },
    { name: 'legend', entryThreshold: 10, winProb: 0.00002,  seedAmount: 5_000_000_000, balance: 0, totalPaidOut: 0, wins: 0, plays: 0, bankruptcyEvents: 0 },
  ],
  skillDistribution: [
    { label: 'novice',     pct: 0.25, winMultiplier: 0.6 },
    { label: 'average',    pct: 0.40, winMultiplier: 1.0 },
    { label: 'skilled',    pct: 0.25, winMultiplier: 1.5 },
    { label: 'pro',        pct: 0.08, winMultiplier: 2.5 },
    { label: 'legendary',  pct: 0.02, winMultiplier: 4.0 },
  ],
  // Kept intentionally small relative to total plays — see the field
  // comment on SimulationConfig.playerPoolSize for why.
  playerPoolSize: 400,
};

// ─── Seeded PRNG (mulberry32) ──────────────────────────────────────────────

class SeededRng {
  private state: number;
  constructor(seed: number) {
    this.state = seed | 0;
  }
  next(): number {
    this.state ^= this.state << 13;
    this.state ^= this.state >> 17;
    this.state ^= this.state << 5;
    return (this.state >>> 0) / 4294967296;
  }
}

// ─── Results ────────────────────────────────────────────────────────────────

interface SimulationResult {
  config: SimulationConfig;
  totalPlays: number;
  totalDays: number;
  totalRevenue: number;
  jackpotContributions: number;
  treasuryContributions: number;
  referralContributions: number;
  devContributions: number;
  totalPayouts: number;
  netTreasury: number;
  tierResults: {
    name: string;
    plays: number;
    wins: number;
    avgWinAmount: number;
    totalPaidOut: number;
    finalBalance: number;
    winRatePerPlay: string; // e.g. "1 in 5,432"
    avgPlaysBetweenWins: number;
    bankruptcyEvents: number;
  }[];
  bankruptcyEvents: number;
  bankruptcyProb: string; // e.g. "0.01%"
  dailyStats: {
    day: number;
    plays: number;
    revenue: number;
    jackpotPool: number;
    wins: number;
  }[];
  summary: string[];
}

// ─── Simulator ──────────────────────────────────────────────────────────────

class EconomySimulator {
  private config: SimulationConfig;
  private rng: SeededRng;
  private tiers: JackpotTier[];
  private treasury: number = 0;
  private totalWins: number = 0;
  private totalRevenue: number = 0;
  private totalPayouts: number = 0;
  private bankruptcyEvents: number = 0;
  private playerWinCounters: Map<number, number> = new Map(); // playerId -> small wins
  private dailyStats: SimulationResult['dailyStats'] = [];

  constructor(config: Partial<SimulationConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.config.tiers = DEFAULT_CONFIG.tiers.map((t, i) => ({
      ...t,
      ...(config.tiers?.[i] || {}),
      balance: (config.tiers?.[i]?.seedAmount ?? t.seedAmount),
    }));
    this.rng = new SeededRng(Date.now());
    this.tiers = this.config.tiers.map((t) => ({ ...t }));
  }

  /** Run the full simulation. */
  run(): SimulationResult {
    const totalPlays = this.config.playsPerDay * this.config.days;

    for (let day = 0; day < this.config.days; day++) {
      let dayWins = 0;
      for (let p = 0; p < this.config.playsPerDay; p++) {
        const playerId = Math.floor(this.rng.next() * this.config.playerPoolSize);
        if (this.playOnce(playerId)) dayWins++;
      }
      // jackpotPool = combined liquidity across all 4 tiers (a single-tier
      // reading would understate treasury health now that plays spread
      // across tiers).
      const combinedPool = this.tiers.reduce((sum, t) => sum + t.balance, 0);
      this.dailyStats.push({
        day: day + 1,
        plays: this.config.playsPerDay,
        revenue: this.config.playsPerDay * this.config.ticketPrice,
        jackpotPool: combinedPool,
        wins: dayWins,
      });
    }

    return this.buildResults(totalPlays);
  }

  /** Simulate a single play: buy ticket -> route to a tier -> spin -> win/loss.
   *  Returns true iff the play resulted in an actual (paid) jackpot win. */
  private playOnce(playerId: number): boolean {
    const feeSplit = this.config.feeSplit;
    const ticketPrice = this.config.ticketPrice;

    // Fee split. jackpotContrib is routed below to whichever single tier
    // this play lands on; platform/referral/dev cuts are tier-agnostic.
    const jackpotContrib = Math.floor(ticketPrice * feeSplit.jackpot);
    const platformContrib = Math.floor(ticketPrice * feeSplit.platform);

    this.totalRevenue += ticketPrice;
    this.treasury += platformContrib;
    // referral/dev cuts aren't modeled as running balances here — they're
    // computed in aggregate (fixed % of total revenue) in buildResults().

    // Determine player skill
    const skillRoll = this.rng.next();
    let cumulative = 0;
    let winMultiplier = 1.0;
    for (const sd of this.config.skillDistribution) {
      cumulative += sd.pct;
      if (skillRoll <= cumulative) {
        winMultiplier = sd.winMultiplier;
        break;
      }
    }

    // Collect every tier this player currently qualifies for. this.tiers is
    // ascending by entryThreshold (small=0 first), so qualification is a
    // simple prefix: once a threshold isn't met, no higher tier is either.
    const unlocked: JackpotTier[] = [];
    for (let i = 0; i < this.tiers.length; i++) {
      const playerWins = this.playerWinCounters.get(playerId) || 0;
      if (playerWins >= this.config.tiers[i].entryThreshold) {
        unlocked.push(this.tiers[i]);
      } else {
        break;
      }
    }

    // Weighted-split routing policy (see file header comment for why):
    // `small` (this.tiers[0]) carries weight 2, every other unlocked tier
    // carries weight 1.
    let tier: JackpotTier;
    if (unlocked.length === 1) {
      tier = unlocked[0];
    } else {
      const weights = unlocked.map((t) => (t === this.tiers[0] ? 2 : 1));
      const totalWeight = weights.reduce((a, b) => a + b, 0);
      let roll = this.rng.next() * totalWeight;
      let idx = 0;
      for (; idx < unlocked.length; idx++) {
        roll -= weights[idx];
        if (roll < 0) break;
      }
      tier = unlocked[Math.min(idx, unlocked.length - 1)];
    }

    tier.balance += jackpotContrib;
    tier.plays++;

    // Win check: base probability * skill multiplier
    const effectiveWinProb = Math.min(tier.winProb * winMultiplier, 0.5);
    if (this.rng.next() < effectiveWinProb) {
      return this.resolveWin(playerId, tier);
    }
    return false;
  }

  /** Resolve a jackpot win: pay out, seed next round, update counters.
   *  Returns true if the tier actually had balance to pay out; false if
   *  the win was rolled against an empty pool (a bankruptcy event). */
  private resolveWin(playerId: number, tier: JackpotTier): boolean {
    const balance = tier.balance;
    if (balance <= 0) {
      tier.bankruptcyEvents++;
      this.bankruptcyEvents++;
      return false;
    }

    const winnerPayout = Math.floor(balance * this.config.payoutSplit.winner);
    const seedAmount = balance - winnerPayout;

    tier.totalPaidOut += winnerPayout;
    tier.wins++;
    this.totalPayouts += winnerPayout;
    this.totalWins++;

    // Seed: pay into the same tier (next round starts from seed)
    tier.balance = seedAmount;

    // Only a `small` win counts toward progression — tiers.go's
    // EntryThreshold is defined purely in terms of prior small-tier wins,
    // so winning medium/mega/legend doesn't itself unlock anything further.
    if (tier === this.tiers[0]) {
      const currentWins = this.playerWinCounters.get(playerId) || 0;
      this.playerWinCounters.set(playerId, currentWins + 1);
    }
    return true;
  }

  /** Build and return the final results. */
  private buildResults(totalPlays: number): SimulationResult {
    const totalContributions = totalPlays * this.config.ticketPrice;
    const jackpotContributions = Math.floor(totalContributions * this.config.feeSplit.jackpot);
    const treasuryContributions = Math.floor(totalContributions * this.config.feeSplit.platform);

    const tierResults = this.tiers.map((t) => {
      const winRate = t.wins > 0 ? t.plays / t.wins : Infinity;
      return {
        name: t.name,
        plays: t.plays,
        wins: t.wins,
        avgWinAmount: t.wins > 0 ? Math.floor(t.totalPaidOut / t.wins) : 0,
        totalPaidOut: t.totalPaidOut,
        finalBalance: t.balance,
        winRatePerPlay: t.wins > 0 ? `1 in ${Math.round(winRate).toLocaleString()}` : 'never won',
        avgPlaysBetweenWins: Math.round(winRate),
        bankruptcyEvents: t.bankruptcyEvents,
      };
    });

    const totalRevenue = this.totalRevenue;
    const totalPayouts = this.totalPayouts;
    const netTreasury = this.treasury;
    const referralContributions = Math.floor(totalContributions * this.config.feeSplit.referral);
    const devContributions = Math.floor(totalContributions * this.config.feeSplit.dev);
    const houseTake = netTreasury + devContributions; // platform (10%) + dev (5%) — referral is a pass-through, not house income
    const finalTierBalances = this.tiers.reduce((sum, t) => sum + t.balance, 0);
    // Conservation check: every dollar of revenue must land in exactly one
    // bucket — payouts, platform treasury, dev ops, referral pool, or still
    // sitting in a tier's balance. Any gap should be sub-lamport flooring
    // dust, not a modeling bug.
    const reconciled = totalPayouts + netTreasury + devContributions + referralContributions + finalTierBalances;
    const reconciliationGap = totalRevenue - reconciled;

    const summary: string[] = [];
    summary.push(`=== GAMEE Economy Simulation Report ===`);
    summary.push(`Plays simulated: ${totalPlays.toLocaleString()} (${this.config.days} days @ ${this.config.playsPerDay.toLocaleString()}/day, player pool ${this.config.playerPoolSize.toLocaleString()})`);
    summary.push(`Ticket price: ${(this.config.ticketPrice / 1_000_000).toFixed(2)} USDC`);
    summary.push(`Total revenue: ${(totalRevenue / 1_000_000).toLocaleString()} USDC`);
    summary.push(`Total payouts: ${(totalPayouts / 1_000_000).toLocaleString()} USDC`);
    summary.push(`Platform treasury (10%): ${(netTreasury / 1_000_000).toLocaleString()} USDC`);
    summary.push(`Dev/ops (5%): ${(devContributions / 1_000_000).toLocaleString()} USDC`);
    summary.push(`House take (platform + dev, 15%): ${(houseTake / 1_000_000).toLocaleString()} USDC (${((houseTake / totalRevenue) * 100).toFixed(1)}% of revenue)`);
    summary.push(`Referral pool (5%, pass-through not house income): ${(referralContributions / 1_000_000).toLocaleString()} USDC`);
    summary.push(`Total wins across all tiers: ${this.totalWins}`);
    summary.push(`Overall win rate: 1 in ${this.totalWins > 0 ? Math.round(totalPlays / this.totalWins).toLocaleString() : 'N/A'} plays`);
    summary.push(`Bankruptcy events (win rolled against an empty pool): ${this.bankruptcyEvents}`);
    summary.push(`Bankruptcy probability: ${((this.bankruptcyEvents / this.config.days) * 100).toFixed(2)}% of days`);
    summary.push(``);
    summary.push(`--- Per-Tier Breakdown ---`);
    for (const t of tierResults) {
      summary.push(
        `${t.name.padEnd(10)} plays ${t.plays.toString().padStart(9).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} | ${t.wins.toString().padStart(5)} wins | avg ${(t.avgWinAmount / 1_000_000).toFixed(2).padStart(10)} USDC | paid ${(t.totalPaidOut / 1_000_000).toFixed(2).padStart(12)} USDC | final pool ${(t.finalBalance / 1_000_000).toFixed(2).padStart(10)} USDC | rate ${t.winRatePerPlay.padEnd(14)} | bankruptcies ${t.bankruptcyEvents}`
      );
    }
    summary.push(``);
    summary.push(`--- Sanity Check (conservation of funds) ---`);
    summary.push(`payouts + treasury + dev + referral + remaining tier balances = ${(reconciled / 1_000_000).toLocaleString()} USDC`);
    summary.push(`total revenue                                                 = ${(totalRevenue / 1_000_000).toLocaleString()} USDC`);
    summary.push(`gap (expect ~0, flooring dust only): ${(reconciliationGap / 1_000_000).toFixed(6)} USDC`);

    return {
      config: this.config,
      totalPlays,
      totalDays: this.config.days,
      totalRevenue,
      jackpotContributions,
      treasuryContributions,
      referralContributions,
      devContributions,
      totalPayouts,
      netTreasury,
      tierResults,
      bankruptcyEvents: this.bankruptcyEvents,
      bankruptcyProb: `${((this.bankruptcyEvents / Math.max(1, this.config.days)) * 100).toFixed(2)}%`,
      dailyStats: this.dailyStats,
      summary,
    };
  }
}

// ─── CLI Entry Point ────────────────────────────────────────────────────────

function parseArgs(): Partial<SimulationConfig> {
  const args = process.argv.slice(2);
  const config: Partial<SimulationConfig> = {};
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--plays':
        config.playsPerDay = parseInt(args[++i], 10);
        break;
      case '--days':
        config.days = parseInt(args[++i], 10);
        break;
      case '--price':
        config.ticketPrice = Math.round(parseFloat(args[++i]) * 1_000_000);
        break;
      case '--seed':
        if (!config.tiers) config.tiers = [];
        config.tiers[0] = { ...DEFAULT_CONFIG.tiers[0], seedAmount: Math.round(parseFloat(args[++i]) * 1_000_000) };
        break;
      case '--json':
        config.jsonOutput = true;
        break;
    }
  }
  return config;
}

function main() {
  const overrides = parseArgs();
  const sim = new EconomySimulator(overrides);
  const result = sim.run();

  const wantJson = process.argv.includes('--json');
  if (wantJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(result.summary.join('\n'));
  }
}

main();
