# STAGE 0 — Legal & Validation

**Duration:** 3–6 weeks
**Gate:** Written legal opinion + validated demand (2,000+ waitlist signups)
**Budget:** $15k–$40k (legal), $500–$2k (demand validation)

---

## Why this comes first

The entire business hinges on one classification: **"$1 = tournament entry" (skill contest)** vs **"$1 = lottery" (gambling)**. If this classification fails, nothing else matters — you cannot launch, you cannot raise money, and you could face criminal liability.

**The key vulnerability:** the random wheel that picks which game you play. A lawyer needs to opine on whether chance in *game selection* poisons the "pure skill" classification. Mitigation options:
- Let users *see* the game before paying (reveal, then pay)
- Let users pick a category (e.g., "precision games") instead of a specific game
- Show the wheel result *before* payment is final (so the user can choose not to play)

---

## Step 0.1 — Jurisdiction Analysis

### Target Market Assessment Matrix

For each target jurisdiction, fill out this table:

| Factor | Questions | Notes |
|--------|-----------|-------|
| **Skill vs Chance Law** | Does this jurisdiction have a skill-gaming carve-out? What tests do courts use? | US: "dominant factor" test varies by state. UK: Gambling Act 2005 s.3 — "game of chance" includes mixed games. |
| **Paid Entry** | Is a $1 entry fee treated differently from free-to-play? | Some jurisdictions allow skill contests with entry fees under a threshold. |
| **Prize Pool** | Does the fact that 80% of fees fund a prize pool change classification? | If the platform takes a cut (rake), it can look like a gambling operation. |
| **Random Element** | Does the wheel (random game selection) turn it into a game of chance? | **This is your biggest legal risk.** Some jurisdictions hold that any material chance element = gambling. |
| **Crypto Payments** | Are USDC/SOL payments treated as "money" or "money's worth"? | Crypto adds AML/KYC complexity. |
| **Geo-blocking** | Can you technically block residents of restricted jurisdictions? | Required in most regulated frameworks. |

### Recommended Starting Markets

| Market | Skill-Gaming Friendly? | Crypto-Friendly? | Complexity |
|--------|----------------------|------------------|------------|
| **US (states with carve-outs)** | Yes (CA, NY, TX, FL — but check each) | Mixed | High (state-by-state) |
| **UK** | Strict but possible with proper structure | Yes (FCA-regulated) | Medium |
| **Canada** | Yes (skill contests legal if no consideration/prize combo issues) | Yes | Low-Medium |
| **Estonia** | Yes (e-residency, crypto-friendly) | Very friendly | Low |
| **Dubai (VARA/ADGM)** | Yes (emerging gaming framework) | Very friendly | Low-Medium |

**Action:** Start with 3 target markets. Prioritize markets where both skill-gaming AND crypto have clear regulatory paths.

---

## Step 0.2 — Engage a Gaming/Crypto Lawyer

### Where to Find Them

- **Global firms**: Perkins Coie (crypto/gaming practice), Fenwick & West
- **Solana-native**: Former Solana Foundation legal team members (ask in SuperTeam)
- **Specialist gaming/crypto**: Anderson Kill (US), Mishcon de Reya (UK)
- **Fractional GC**: Many ex-gaming-company GCs consult part-time. Budget $800–$1,500/hr for top tier.

### Legal Brief Template

When you reach out, send this brief so they can quote accurately:

```
TO: [Firm Name]
FROM: [Your Name]
DATE: [Date]
RE: Legal opinion engagement — Gamee (Web3 skill-gaming jackpot platform)

PRODUCT DESCRIPTION:
- User pays $1 in USDC on Solana.
- 80% enters a transparent on-chain jackpot pool.
- A VRF oracle (Switchboard) randomly selects one of 40-100 skill-based arcade games.
- User plays the game. If their score meets the target, they win the jackpot.
- Target difficulty is calibrated so wins happen at a controlled rate.
- Outcome is verified by deterministic server-side replay of every input.
- Platform takes no cut from the prize — 80% is 100% distributed, 10% treasury funds operations/advertising, 5% referrals, 5% ops.

LEGAL QUESTIONS:
1. Does this constitute gambling, a game of skill, or a lawful contest in [JURISDICTION]?
2. Does the random game selection (wheel) change the classification?
3. Is custody of the USDC jackpot pool subject to money-transmitter licensing?
4. What KYC/AML obligations apply?
5. What geo-blocking is required?
6. What corporate structure minimizes regulatory risk?

DELIVERABLE EXPECTED:
Written legal opinion addressing questions 1-6 above. Budget range requested: $10k-$30k.

TIMELINE:
Target engagement start: [DATE]. Opinion needed by: [DATE + 4 weeks].
```

### Budget Planning

| Service | Low End | High End | Notes |
|---------|---------|----------|-------|
| Written legal opinion | $10,000 | $30,000 | Depends on number of jurisdictions |
| Corporate setup | $5,000 | $15,000 | Incorporation + crypto-specific docs |
| Ongoing retainer (monthly) | $3,000 | $8,000 | Compliance monitoring |
| **Stage 0 legal total** | **$15,000** | **$45,000** | Get quotes before committing |

---

## Step 0.3 — Corporate Structure

### Recommended Structure

```
[Parent HoldCo — Cayman/BVI/Virgin Islands]
        │
        ├── [OpCo — Estonia/Dubai/Singapore]
        │     ├── Platform operations
        │     ├── Game IP ownership
        │     ├── Developer hiring
        │     └── User agreements
        │
        └── [Treasury Co — Jurisdiction of OpCo or separate]
              ├── Jackpot vault smart contract owner
              ├── Treasury wallet (multisig)
              ├── Verifier authority key management
              └── Prize payout execution
```

### Why Two Entities

| Entity | Owns | Risks Shielded |
|--------|------|----------------|
| **OpCo** | Brand, IP, team, frontend, backend | Not liable for prize pool custody |
| **Treasury Co** | Smart contract admin keys, vault | Ring-fences the prize pool from operational creditors |

### Multisig Setup

Use **Squads** (Solana multisig standard):

```
Treasury Co. Multisig (3-of-5):
├── Co-founder 1 — hardware wallet
├── Co-founder 2 — hardware wallet
├── Legal counsel — hardware wallet
├── Backup 1 (time-locked recovery)
└── Backup 2 (time-locked recovery)

Verifier Authority (2-of-3 initially → 3-of-5 at scale):
├── Backend signing service (HSM — AWS KMS / GCP Cloud HSM)
├── Co-founder 1 — hardware wallet
├── Manual review approver (for >$1k payouts)
```

### Banking

- Open a corporate bank account for OpCo (Mercury, Brex, or Wise Business for crypto-friendly banking)
- Treasury Co may not need a bank account if it only holds on-chain USDC
- For fiat on/off ramps: partner with a licensed payment processor (MoonPay, Wyre, Transak) — they handle KYC for fiat->crypto conversion

### Documents to Prepare

1. Incorporation certificates (2 entities)
2. Operating agreement / shareholders agreement
3. Smart contract admin key management policy
4. User terms of service (must include: arbitration clause, jurisdiction, class action waiver, geo-blocking notice)
5. Privacy policy (GDPR-compliant if EU users)
6. KYC/AML policy (if required in target markets)
7. Prize pool rules (transparent on-chain, published and immutable)

---

## Step 0.4 — Demand Validation (Parallel to Legal)

### Goal

Prove demand exists *before* spending 6+ months and $100k+ building.

### Build the Fake-Door Landing Page

See `landing-page/index.html` for the implementation. It includes:

- **Live jackpot counter** — simulated rising number (creates FOMO)
- **Wheel animation** — users can spin to see what game they *would* get (demonstrates the concept)
- **Email/wallet waitlist signup** — captures leads
- **Social proof** — "X players online", "today's plays", recent winner notifications
- **Mobile-responsive design** — works on all devices

### Traffic Plan

| Channel | Budget | Expected Reach | Notes |
|---------|--------|----------------|-------|
| Crypto Twitter/X | $500 | 50k–200k impressions | Target Solana/gaming community accounts |
| Telegram gaming communities | $200 | 10k–50k views | Post in Solana Degens, Play-to-Earn groups |
| Reddit (r/Solana, r/cryptogaming) | Free | 5k–20k views | Organic posts |
| TikTok / YouTube Shorts | $500 | 50k–200k views | Quick demo of wheel spin + game concept |
| Targeted ads (Meta/Twitter) | $500–$1,000 | 100k–500k impressions | Crypto-interested audiences |

### Validation Metrics

| Metric | Target | What It Means |
|--------|--------|---------------|
| Waitlist signups | 2,000+ | Real interest from real people |
| Wallet connections | 500+ | Users willing to connect a wallet (higher intent) |
| Email capture rate | 30%+ of visitors | Strong interest signal |
| Social engagement | 5%+ CTR on ads | Message resonates |
| Refer-a-friend clicks | 5%+ of signups | Viral potential exists |

### Tracking Setup

- **Google Analytics** or **Plausible** (privacy-first) on the landing page
- **UTM parameters** on all ad links to track channel performance
- **PostHog** or **Mixpanel** for event tracking (signup, wallet connect, spin)
- **A/B test** the value proposition: "Win up to $50k playing Flappy Bird" vs "Prove your skill, win the jackpot"

### Exit Criterion Checklist

- [ ] Written legal opinion received and reviewed
- [ ] Entity incorporated (at least OpCo)
- [ ] Geo-block list defined (jurisdictions to block)
- [ ] 2,000+ waitlist signups (or clear evidence demand doesn't exist)
- [ ] 500+ wallet connections
- [ ] Conference call with lawyer confirming the next stage doesn't create new legal risk

> **If nobody cares about the concept page, stop or pivot before spending 6 months building.**

---

## Stage 0 Deliverables Checklist

### Legal Deliverables
- [ ] Legal opinion covering skill vs chance classification
- [ ] Money transmission analysis (custody of jackpot pool)
- [ ] KYC/AML obligations memo
- [ ] Geo-blocking requirements for target markets
- [ ] Crypto-payment-specific regulatory guidance

### Corporate Deliverables
- [ ] OpCo incorporated
- [ ] Treasury Co incorporated (if recommended)
- [ ] Corporate bank account opened
- [ ] Multisig wallets created and tested
- [ ] Terms of service drafted
- [ ] Privacy policy drafted

### Demand Validation Deliverables
- [ ] Fake-door landing page live at public URL
- [ ] Analytics tracking configured
- [ ] Ad campaigns running (or ready to run on greenlight)
- [ ] Waitlist data collected in Airtable / Notion / Google Sheets
- [ ] Weekly traffic/signup report

### Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Skill classification fails in target market | Medium | Critical | Expand scope of lawyer review; pivot to free-to-play + cosmetic monetization |
| No demand (under 500 signups) | Medium | High | Pivot value prop before building; test different messaging |
| Legal costs exceed budget | Medium | Medium | Start with 1-2 jurisdictions; add more after revenue |
| Entity setup takes too long | Low | Medium | Begin with Estonia e-residency (fast); add complex structures later |
| Banking refuses crypto company | Medium | High | Use crypto-native banks (Mercury, Clear Junction, BCB Group) |
