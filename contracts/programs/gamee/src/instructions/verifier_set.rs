use crate::errors::GameeError;
use crate::state::*;
use anchor_lang::prelude::*;

// Admin instructions for the threshold verifier set. Only the authority
// stored in PlatformConfig may execute these — same gating pattern as
// contracts/programs/gamee/src/instructions/admin.rs.

/// Shared invariant check for both init and update: 1 <= threshold <=
/// verifiers.len() <= 5, and no duplicate pubkeys.
fn validate_verifier_set(verifiers: &[Pubkey], threshold: u8) -> Result<()> {
    require!(!verifiers.is_empty(), GameeError::InvalidVerifierSetConfig);
    require!(verifiers.len() <= 5, GameeError::InvalidVerifierSetConfig);
    require!(threshold >= 1, GameeError::InvalidVerifierSetConfig);
    require!(
        threshold as usize <= verifiers.len(),
        GameeError::InvalidVerifierSetConfig
    );

    for i in 0..verifiers.len() {
        for j in (i + 1)..verifiers.len() {
            require!(
                verifiers[i] != verifiers[j],
                GameeError::InvalidVerifierSetConfig
            );
        }
    }

    Ok(())
}

/// Initialize the verifier set singleton. Must be called once (after
/// initialize_platform, before the first settle_session/commit_spin).
#[derive(Accounts)]
pub struct InitVerifierSet<'info> {
    /// The admin authority — must match PlatformConfig.admin.
    #[account(
        mut,
        address = platform_config.admin @ GameeError::Unauthorized,
    )]
    pub admin: Signer<'info>,

    /// Platform config (singleton PDA).
    #[account(
        seeds = [b"platform_config"],
        bump,
    )]
    pub platform_config: Account<'info, PlatformConfig>,

    /// The verifier set PDA to create.
    #[account(
        init,
        seeds = [b"verifier_set"],
        bump,
        payer = admin,
        space = 8 + VerifierSet::INIT_SPACE,
    )]
    pub verifier_set: Account<'info, VerifierSet>,

    /// System program.
    pub system_program: Program<'info, System>,
}

pub fn init_verifier_set_handler(
    ctx: Context<InitVerifierSet>,
    verifiers: Vec<Pubkey>,
    threshold: u8,
) -> Result<()> {
    validate_verifier_set(&verifiers, threshold)?;

    let verifier_set = &mut ctx.accounts.verifier_set;
    verifier_set.verifiers = verifiers;
    verifier_set.threshold = threshold;

    Ok(())
}

/// Replace the verifier set's member list and threshold.
#[derive(Accounts)]
pub struct UpdateVerifierSet<'info> {
    /// The admin authority — must match PlatformConfig.admin.
    #[account(
        address = platform_config.admin @ GameeError::Unauthorized,
    )]
    pub admin: Signer<'info>,

    /// Platform config (singleton PDA).
    #[account(
        seeds = [b"platform_config"],
        bump,
    )]
    pub platform_config: Account<'info, PlatformConfig>,

    /// The verifier set PDA to update.
    #[account(
        mut,
        seeds = [b"verifier_set"],
        bump,
    )]
    pub verifier_set: Account<'info, VerifierSet>,
}

pub fn update_verifier_set_handler(
    ctx: Context<UpdateVerifierSet>,
    verifiers: Vec<Pubkey>,
    threshold: u8,
) -> Result<()> {
    validate_verifier_set(&verifiers, threshold)?;

    let verifier_set = &mut ctx.accounts.verifier_set;
    verifier_set.verifiers = verifiers;
    verifier_set.threshold = threshold;

    Ok(())
}
