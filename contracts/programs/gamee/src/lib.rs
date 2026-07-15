// anchor-lang 0.30.1's #[program]/#[derive(Accounts)] macros predate rustc's
// "unexpected cfg value" lint (stabilized ~1.80) and don't declare their
// internal feature-flag cfgs (anchor-debug, no-log-ix-name, no-idl, ...) via
// cargo::rustc-check-cfg, so a sufficiently new rustc flags every use of
// those macros. Known upstream/toolchain mismatch, not a real issue in this
// crate — same root cause as the `time` crate needing similar treatment to
// build anchor-cli itself on a new toolchain.
#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;

declare_id!("9ZjYdP5QQB6SHbQWRocLDtuxga519Z4ZQsVct1ESkJYa");

pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;

#[program]
pub mod gamee {
    use super::*;

    /// Buy a ticket with USDC. Applies 80/10/5/5 split across:
    ///   - 80% jackpot vault
    ///   - 10% platform/treasury wallet
    ///   -  5% referral wallet
    ///   -  5% dev/operations wallet
    ///
    /// Mints a Ticket PDA seeded by [buyer, nonce].
    pub fn buy_ticket(ctx: Context<BuyTicket>, nonce: u64, total_amount: u64) -> Result<()> {
        buy_ticket::handler(ctx, nonce, total_amount)
    }

    /// Commit a spin after VRF result is obtained.
    /// Records the VRF result, marks the ticket consumed, and creates a GameSession PDA.
    pub fn commit_spin(
        ctx: Context<CommitSpin>,
        game_id: String,
        vrf_result: u128,
        seed: String,
    ) -> Result<()> {
        commit_spin::handler(ctx, game_id, vrf_result, seed)
    }

    /// Settle a game session after replay verification.
    /// The verifier authority signs off on final_score and target_score.
    /// If won, pays out 95% of jackpot vault to winner, 5% seeds next jackpot.
    pub fn settle_session(
        ctx: Context<SettleSession>,
        final_score: u64,
        target_score: u64,
    ) -> Result<()> {
        settle_session::handler(ctx, final_score, target_score)
    }

    // ── Admin instructions ──────────────────────────────────────────

    /// Initialize the platform config singleton. Called once at deployment.
    pub fn initialize_platform(
        ctx: Context<InitializePlatform>,
        verifier: Pubkey,
        platform_wallet: Pubkey,
        dev_wallet: Pubkey,
        referral_wallet: Pubkey,
        ticket_price: u64,
        jackpot_vault_token_account: Pubkey,
    ) -> Result<()> {
        admin::initialize_platform_handler(
            ctx,
            verifier,
            platform_wallet,
            dev_wallet,
            referral_wallet,
            ticket_price,
            jackpot_vault_token_account,
        )
    }

    /// Initialize a jackpot vault PDA for a tier ("small", "medium", "mega", "legend").
    pub fn initialize_jackpot(ctx: Context<InitializeJackpot>, tier: String) -> Result<()> {
        admin::initialize_jackpot_handler(ctx, tier)
    }

    /// Register a new game with its wheel weight and difficulty params.
    pub fn add_game(
        ctx: Context<AddGame>,
        game_id: String,
        name: String,
        category: String,
        wheel_weight: u64,
        base_difficulty: u8,
    ) -> Result<()> {
        admin::add_game_handler(ctx, game_id, name, category, wheel_weight, base_difficulty)
    }

    /// Update the wheel weight for an existing game.
    pub fn update_weight(
        ctx: Context<UpdateWeight>,
        game_id: String,
        new_weight: u64,
    ) -> Result<()> {
        admin::update_weight_handler(ctx, game_id, new_weight)
    }

    /// Toggle pause state for the entire platform.
    pub fn pause_contract(ctx: Context<PauseContract>, paused: bool) -> Result<()> {
        admin::pause_handler(ctx, paused)
    }

    /// Transfer admin authority to a new pubkey.
    pub fn set_authority(ctx: Context<SetAuthority>) -> Result<()> {
        admin::set_authority_handler(ctx)
    }

    /// Set the verifier authority pubkey.
    pub fn set_verifier(ctx: Context<SetVerifier>) -> Result<()> {
        admin::set_verifier_handler(ctx)
    }

    // ── Verifier set (threshold multisig) instructions ─────────────

    /// Initialize the threshold verifier set singleton. Called once, after
    /// initialize_platform and before the first commit_spin/settle_session.
    pub fn init_verifier_set(
        ctx: Context<InitVerifierSet>,
        verifiers: Vec<Pubkey>,
        threshold: u8,
    ) -> Result<()> {
        verifier_set::init_verifier_set_handler(ctx, verifiers, threshold)
    }

    /// Replace the verifier set's member list and threshold (admin only).
    pub fn update_verifier_set(
        ctx: Context<UpdateVerifierSet>,
        verifiers: Vec<Pubkey>,
        threshold: u8,
    ) -> Result<()> {
        verifier_set::update_verifier_set_handler(ctx, verifiers, threshold)
    }
}
