use crate::errors::GameeError;
use crate::state::*;
use anchor_lang::prelude::*;

/// Commit a spin: record the VRF result for a ticket, mark it consumed,
/// and create a GameSession PDA.
///
/// The VRF result determines which game is selected (via weighted wheel).
/// This instruction is called by the backend after a VRF request completes.
#[derive(Accounts)]
#[instruction(game_id: String, vrf_result: u128)]
pub struct CommitSpin<'info> {
    /// The buyer/user who owns the ticket. Pays rent for the session PDA.
    #[account(mut)]
    pub player: Signer<'info>,

    /// The verifier authority — co-signs to attest that game_id and vrf_result
    /// genuinely came from the VRF oracle (the player cannot pick their game).
    /// Must be a member of `verifier_set` (checked in the handler). Spins are
    /// low-risk (no funds move), so 1-of-N membership is enough — quorum is
    /// reserved for settle_session's money movement.
    pub verifier: Signer<'info>,

    /// Platform config singleton.
    #[account(
        seeds = [b"platform_config"],
        bump,
    )]
    pub platform_config: Account<'info, PlatformConfig>,

    /// Threshold verifier set — supplies valid verifier membership.
    #[account(
        seeds = [b"verifier_set"],
        bump,
    )]
    pub verifier_set: Account<'info, VerifierSet>,

    /// The ticket to be consumed — must not already be consumed.
    #[account(
        mut,
        seeds = [b"ticket", player.key().as_ref(), ticket.nonce.to_le_bytes().as_ref()],
        bump,
        constraint = !ticket.consumed @ GameeError::TicketAlreadyConsumed,
    )]
    pub ticket: Account<'info, Ticket>,

    /// The game config for the selected game (determined by VRF).
    /// PDA seeds include the game_id string, ensuring the VRF-selected game is valid.
    #[account(
        seeds = [b"game_config", game_id.as_bytes()],
        bump,
    )]
    pub game_config: Account<'info, GameConfig>,

    /// The game session PDA to create (seeded by ticket pubkey).
    #[account(
        init,
        seeds = [b"game_session", ticket.key().as_ref()],
        bump,
        payer = player,
        space = 8 + GameSession::INIT_SPACE,
    )]
    pub game_session: Account<'info, GameSession>,

    /// System program (for rent exemption).
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<CommitSpin>,
    game_id: String,
    vrf_result: u128,
    seed: String,
) -> Result<()> {
    // Verifier must be a member of the threshold verifier set.
    require!(
        ctx.accounts
            .verifier_set
            .verifiers
            .contains(&ctx.accounts.verifier.key()),
        GameeError::VerifierNotInSet
    );

    let clock = Clock::get()?;

    // Capture keys up front to avoid overlapping borrows of ctx.accounts.
    let game_session_key = ctx.accounts.game_session.key();
    let player_key = ctx.accounts.player.key();

    // Validate the game is currently enabled
    require!(ctx.accounts.game_config.enabled, GameeError::GameNotEnabled);

    // Mark the ticket as consumed and link it to the new session
    let ticket = &mut ctx.accounts.ticket;
    ticket.consumed = true;
    ticket.game_session = Some(game_session_key);
    let ticket_key = ticket.key();

    // Initialize the game session
    let game_session = &mut ctx.accounts.game_session;
    game_session.ticket = ticket_key;
    game_session.player = player_key;
    game_session.game_id = game_id;
    game_session.vrf_result = vrf_result;
    game_session.seed = seed;
    game_session.created_at = clock.unix_timestamp;
    game_session.settled = false;
    game_session.result = "pending".to_string();
    game_session.final_score = 0;
    game_session.target_score = 0;
    game_session.settled_by = None;

    Ok(())
}
