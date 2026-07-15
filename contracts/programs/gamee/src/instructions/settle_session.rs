use crate::errors::GameeError;
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer as SplTransfer};

/// Settle a game session after replay verification.
///
/// A threshold of `verifier_set` members must co-sign: `verifier` pays tx
/// fees and always signs; additional members co-sign via
/// `ctx.remaining_accounts`. The handler counts distinct verifier-set
/// members among all signers and requires at least `verifier_set.threshold`.
/// If the player won (final_score >= target_score), this instruction pays out
/// the jackpot: 95% to the winner, 5% seeds the next jackpot (a real,
/// admin-initialized tier vault — see `next_jackpot_vault`).
///
/// Security: only distinct signatures from `verifier_set` members, meeting
/// its threshold, authorize a payout.
#[derive(Accounts)]
pub struct SettleSession<'info> {
    /// Fee-payer / primary co-signer. Must be a member of `verifier_set` —
    /// membership and quorum are both checked in the handler (together with
    /// any additional co-signers passed via remaining_accounts).
    #[account(mut)]
    pub verifier: Signer<'info>,

    /// The player (used for PDA seed derivation).
    /// CHECK: Safe — used only for address comparison and seed derivation.
    pub player: UncheckedAccount<'info>,

    /// The ticket associated with this session.
    #[account(
        mut,
        seeds = [b"ticket", player.key().as_ref(), ticket.nonce.to_le_bytes().as_ref()],
        bump,
    )]
    pub ticket: Account<'info, Ticket>,

    /// The game session to settle — must not already be settled, and must belong to player.
    #[account(
        mut,
        seeds = [b"game_session", ticket.key().as_ref()],
        bump,
        constraint = !game_session.settled @ GameeError::SessionAlreadySettled,
        constraint = game_session.player == player.key() @ GameeError::Unauthorized,
    )]
    pub game_session: Account<'info, GameSession>,

    /// Platform config singleton.
    #[account(
        seeds = [b"platform_config"],
        bump,
    )]
    pub platform_config: Account<'info, PlatformConfig>,

    /// Threshold verifier set — membership + quorum are checked in the handler.
    #[account(
        seeds = [b"verifier_set"],
        bump,
    )]
    pub verifier_set: Account<'info, VerifierSet>,

    /// Jackpot vault PDA — if won, payout is deducted from here.
    #[account(
        mut,
        seeds = [b"jackpot", jackpot_vault.tier.as_bytes()],
        bump,
    )]
    pub jackpot_vault: Account<'info, JackpotVault>,

    /// The jackpot vault's USDC token account — must be the vault's registered account.
    #[account(
        mut,
        address = jackpot_vault.vault_token_account @ GameeError::InvalidDestinationAccount,
    )]
    pub jackpot_usdc_account: Account<'info, TokenAccount>,

    /// The winner's USDC token account (receives 95% of payout) — must be owned by the player.
    #[account(
        mut,
        constraint = winner_usdc_account.owner == game_session.player
            @ GameeError::InvalidDestinationAccount,
    )]
    pub winner_usdc_account: Account<'info, TokenAccount>,

    /// The next jackpot vault's USDC token account (receives 5% to seed next round).
    #[account(mut)]
    pub next_jackpot_usdc_account: Account<'info, TokenAccount>,

    /// The next jackpot vault PDA — ties `next_jackpot_usdc_account` to a
    /// real, admin-initialized tier vault (same pattern as buy_ticket's
    /// tier-agnostic `jackpot_vault` check: this can be any tier's vault, but
    /// its `seeds` are derived from its own stored `tier` field, so a forged
    /// or uninitialized account can't deserialize/pass, AND its
    /// on-chain-recorded `vault_token_account` must equal
    /// `next_jackpot_usdc_account`'s key). Closes the previously-unconstrained
    /// reseed-destination hole where a compromised verifier could redirect
    /// the 5% reseed to an arbitrary token account.
    #[account(
        seeds = [b"jackpot", next_jackpot_vault.tier.as_bytes()],
        bump,
        constraint = next_jackpot_vault.vault_token_account == next_jackpot_usdc_account.key()
            @ GameeError::InvalidDestinationAccount,
    )]
    pub next_jackpot_vault: Account<'info, JackpotVault>,

    /// Token program.
    pub token_program: Program<'info, Token>,

    /// System program.
    pub system_program: Program<'info, System>,
}

/// Counts distinct `verifier_set` members who signed this transaction:
/// `verifier` (the primary signer) plus any signer accounts passed in
/// `remaining_accounts`. The same pubkey appearing more than once (as
/// `verifier` and again in `remaining_accounts`, or repeated within
/// `remaining_accounts`) counts once — padding the signer list with
/// duplicate signatures cannot satisfy quorum.
fn count_distinct_verifier_signers(
    verifier_set: &VerifierSet,
    verifier: &Signer,
    remaining_accounts: &[AccountInfo],
) -> usize {
    let mut counted: Vec<Pubkey> = Vec::with_capacity(verifier_set.verifiers.len());

    let verifier_key = verifier.key();
    if verifier_set.verifiers.contains(&verifier_key) {
        counted.push(verifier_key);
    }

    for info in remaining_accounts {
        if !info.is_signer {
            continue;
        }
        let key = info.key();
        if verifier_set.verifiers.contains(&key) && !counted.contains(&key) {
            counted.push(key);
        }
    }

    counted.len()
}

pub fn handler(ctx: Context<SettleSession>, final_score: u64, target_score: u64) -> Result<()> {
    // --- Verifier quorum check ---
    // `verifier` must itself be a verifier_set member and, together with any
    // additional signing co-signers in remaining_accounts, meet the
    // configured threshold. Neither a non-member `verifier` nor padding with
    // non-member/duplicate signers can satisfy this.
    let signer_count = count_distinct_verifier_signers(
        &ctx.accounts.verifier_set,
        &ctx.accounts.verifier,
        ctx.remaining_accounts,
    );
    require!(
        signer_count as u8 >= ctx.accounts.verifier_set.threshold,
        GameeError::VerifierQuorumNotMet
    );

    let game_session = &mut ctx.accounts.game_session;
    let clock = Clock::get()?;

    // Mark session as settled
    game_session.settled = true;
    game_session.final_score = final_score;
    game_session.target_score = target_score;
    game_session.settled_by = Some(ctx.accounts.verifier.key());

    // Determine win/loss: player wins if final_score >= target_score
    let won = final_score >= target_score;

    if won {
        game_session.result = "won".to_string();

        // --- Execute jackpot payout: 95/5 split ---
        let vault_balance = ctx.accounts.jackpot_usdc_account.amount;
        require!(vault_balance > 0, GameeError::JackpotUnderflow);

        let winner_payout = vault_balance
            .checked_mul(95)
            .ok_or(GameeError::ArithmeticError)?
            .checked_div(100)
            .ok_or(GameeError::ArithmeticError)?;

        let next_jackpot_seed = vault_balance
            .checked_sub(winner_payout)
            .ok_or(GameeError::ArithmeticError)?;

        // PDA signer seeds for jackpot vault
        let vault_seeds: &[&[u8]] = &[
            b"jackpot",
            ctx.accounts.jackpot_vault.tier.as_bytes(),
            &[ctx.bumps.jackpot_vault],
        ];
        let signer_seeds = &[vault_seeds];

        // Transfer 95% to winner
        let transfer_to_winner = SplTransfer {
            from: ctx.accounts.jackpot_usdc_account.to_account_info(),
            to: ctx.accounts.winner_usdc_account.to_account_info(),
            authority: ctx.accounts.jackpot_vault.to_account_info(),
        };

        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            transfer_to_winner,
            signer_seeds,
        );
        token::transfer(cpi_ctx, winner_payout)?;

        // Transfer 5% to next jackpot vault
        if next_jackpot_seed > 0 {
            let transfer_to_next = SplTransfer {
                from: ctx.accounts.jackpot_usdc_account.to_account_info(),
                to: ctx.accounts.next_jackpot_usdc_account.to_account_info(),
                authority: ctx.accounts.jackpot_vault.to_account_info(),
            };

            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                transfer_to_next,
                signer_seeds,
            );
            token::transfer(cpi_ctx, next_jackpot_seed)?;
        }

        // Update vault metadata — reload the token account so total_amount
        // reflects the true post-payout balance (avoids underflow on first win).
        ctx.accounts.jackpot_usdc_account.reload()?;
        let remaining_balance = ctx.accounts.jackpot_usdc_account.amount;
        let jackpot_vault = &mut ctx.accounts.jackpot_vault;
        jackpot_vault.total_paid_out = jackpot_vault
            .total_paid_out
            .checked_add(winner_payout)
            .ok_or(GameeError::ArithmeticError)?;
        jackpot_vault.total_amount = remaining_balance;
        jackpot_vault.last_won_at = clock.unix_timestamp;
    } else {
        game_session.result = "lost".to_string();
    }

    Ok(())
}
