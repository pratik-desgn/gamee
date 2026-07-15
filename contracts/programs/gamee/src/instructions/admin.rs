use crate::errors::GameeError;
use crate::state::*;
use anchor_lang::prelude::*;

use anchor_spl::token::Mint;

// Admin instructions for the GAMEE program.
//
// Only the authority stored in PlatformConfig may execute these.

/// Initialize the platform config singleton.
/// Must be called once at deployment.
#[derive(Accounts)]
pub struct InitializePlatform<'info> {
    /// The initial admin authority.
    #[account(mut)]
    pub admin: Signer<'info>,

    /// The platform config PDA to create.
    #[account(
        init,
        seeds = [b"platform_config"],
        bump,
        payer = admin,
        space = 8 + PlatformConfig::INIT_SPACE,
    )]
    pub platform_config: Account<'info, PlatformConfig>,

    /// The USDC mint address.
    pub usdc_mint: Account<'info, Mint>,

    /// System program.
    pub system_program: Program<'info, System>,
}

pub fn initialize_platform_handler(
    ctx: Context<InitializePlatform>,
    verifier: Pubkey,
    platform_wallet: Pubkey,
    dev_wallet: Pubkey,
    referral_wallet: Pubkey,
    ticket_price: u64,
    jackpot_vault_token_account: Pubkey,
) -> Result<()> {
    let config = &mut ctx.accounts.platform_config;

    require!(ticket_price > 0, GameeError::InvalidTicketPrice);

    config.admin = ctx.accounts.admin.key();
    config.verifier = verifier;
    config.paused = false;
    config.jackpot_fee_bps = 8000; // 80% → jackpot
    config.platform_fee_bps = 1000; // 10% → platform/treasury
    config.referral_fee_bps = 500; //  5% → referral rewards
    config.dev_fee_bps = 500; //  5% → dev/operations
    config.ticket_price = ticket_price;
    config.usdc_mint = ctx.accounts.usdc_mint.key();
    config.platform_wallet = platform_wallet;
    config.dev_wallet = dev_wallet;
    config.referral_wallet = referral_wallet;
    config.jackpot_vault_token_account = jackpot_vault_token_account;

    Ok(())
}

/// Initialize a jackpot vault PDA for a tier ("small", "medium", "mega", "legend").
/// Must be called once per tier before any session can be settled against it.
#[derive(Accounts)]
#[instruction(tier: String)]
pub struct InitializeJackpot<'info> {
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

    /// The jackpot vault PDA to create.
    #[account(
        init,
        seeds = [b"jackpot", tier.as_bytes()],
        bump,
        payer = admin,
        space = 8 + JackpotVault::INIT_SPACE,
    )]
    pub jackpot_vault: Account<'info, JackpotVault>,

    /// The USDC token account owned by the jackpot vault PDA.
    #[account(
        token::mint = platform_config.usdc_mint,
        token::authority = jackpot_vault,
    )]
    pub vault_token_account: Account<'info, anchor_spl::token::TokenAccount>,

    /// System program.
    pub system_program: Program<'info, System>,
}

pub fn initialize_jackpot_handler(ctx: Context<InitializeJackpot>, tier: String) -> Result<()> {
    let vault = &mut ctx.accounts.jackpot_vault;

    vault.tier = tier;
    vault.vault_token_account = ctx.accounts.vault_token_account.key();
    vault.total_amount = 0;
    vault.total_paid_out = 0;
    vault.total_plays = 0;
    vault.last_won_at = 0;
    vault.active = true;

    Ok(())
}

/// Add a new game to the wheel.
#[derive(Accounts)]
#[instruction(game_id: String)]
pub struct AddGame<'info> {
    /// The admin authority — must match PlatformConfig.admin.
    #[account(
        mut,
        address = platform_config.admin @ GameeError::Unauthorized,
    )]
    pub admin: Signer<'info>,

    /// Platform config (singleton PDA).
    #[account(
        mut,
        seeds = [b"platform_config"],
        bump,
    )]
    pub platform_config: Account<'info, PlatformConfig>,

    /// The game config PDA to create.
    #[account(
        init,
        seeds = [b"game_config", game_id.as_bytes()],
        bump,
        payer = admin,
        space = 8 + GameConfig::INIT_SPACE,
    )]
    pub game_config: Account<'info, GameConfig>,

    /// System program.
    pub system_program: Program<'info, System>,
}

/// Update the wheel weight of an existing game.
#[derive(Accounts)]
#[instruction(game_id: String)]
pub struct UpdateWeight<'info> {
    #[account(
        address = platform_config.admin @ GameeError::Unauthorized,
    )]
    pub admin: Signer<'info>,

    #[account(
        seeds = [b"platform_config"],
        bump,
    )]
    pub platform_config: Account<'info, PlatformConfig>,

    #[account(
        mut,
        seeds = [b"game_config", game_id.as_bytes()],
        bump,
    )]
    pub game_config: Account<'info, GameConfig>,
}

/// Toggle pause state for the entire platform.
#[derive(Accounts)]
pub struct PauseContract<'info> {
    #[account(
        address = platform_config.admin @ GameeError::Unauthorized,
    )]
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [b"platform_config"],
        bump,
    )]
    pub platform_config: Account<'info, PlatformConfig>,
}

/// Transfer admin authority to a new pubkey.
#[derive(Accounts)]
pub struct SetAuthority<'info> {
    #[account(
        address = platform_config.admin @ GameeError::Unauthorized,
    )]
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [b"platform_config"],
        bump,
    )]
    pub platform_config: Account<'info, PlatformConfig>,

    /// The new admin pubkey.
    /// CHECK: Safe — we store it as the new admin.
    pub new_admin: UncheckedAccount<'info>,
}

/// Add a new game to the prize wheel.
pub fn add_game_handler(
    ctx: Context<AddGame>,
    game_id: String,
    name: String,
    category: String,
    wheel_weight: u64,
    base_difficulty: u8,
) -> Result<()> {
    let clock = Clock::get()?;
    let game_config = &mut ctx.accounts.game_config;

    // Validate difficulty range
    require!(
        (1..=10).contains(&base_difficulty),
        GameeError::InvalidFeeRate
    );

    game_config.game_id = game_id;
    game_config.name = name;
    game_config.category = category;
    game_config.wheel_weight = wheel_weight;
    game_config.total_weight = wheel_weight; // Initially, total = this game's weight
    game_config.base_difficulty = base_difficulty;
    game_config.enabled = true;
    game_config.created_at = clock.unix_timestamp;
    game_config.last_updated_by = ctx.accounts.admin.key();

    Ok(())
}

/// Update the wheel weight for an existing game.
pub fn update_weight_handler(
    ctx: Context<UpdateWeight>,
    _game_id: String,
    new_weight: u64,
) -> Result<()> {
    let game_config = &mut ctx.accounts.game_config;
    game_config.wheel_weight = new_weight;
    game_config.last_updated_by = ctx.accounts.admin.key();
    Ok(())
}

/// Pause or unpause the entire platform.
pub fn pause_handler(ctx: Context<PauseContract>, paused: bool) -> Result<()> {
    ctx.accounts.platform_config.paused = paused;
    Ok(())
}

/// Transfer admin authority to a new pubkey.
pub fn set_authority_handler(ctx: Context<SetAuthority>) -> Result<()> {
    ctx.accounts.platform_config.admin = ctx.accounts.new_admin.key();
    Ok(())
}

/// Set the verifier authority.
#[derive(Accounts)]
pub struct SetVerifier<'info> {
    #[account(
        address = platform_config.admin @ GameeError::Unauthorized,
    )]
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [b"platform_config"],
        bump,
    )]
    pub platform_config: Account<'info, PlatformConfig>,

    /// The new verifier pubkey.
    /// CHECK: Safe — we store it as the new verifier.
    pub new_verifier: UncheckedAccount<'info>,
}

pub fn set_verifier_handler(ctx: Context<SetVerifier>) -> Result<()> {
    ctx.accounts.platform_config.verifier = ctx.accounts.new_verifier.key();
    Ok(())
}
