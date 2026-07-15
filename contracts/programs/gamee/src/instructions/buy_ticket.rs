use crate::errors::GameeError;
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer as SplTransfer};

/// Buy a ticket: user pays the configured ticket price (1 USDC), split 80/10/5/5.
///
/// Split breakdown:
///   - 80% → jackpot vault
///   - 10% → platform/treasury wallet
///   -  5% → referral wallet
///   -  5% → dev/operations wallet
///
/// A Ticket PDA is minted (seeded by buyer + nonce).
/// Every destination account is validated against PlatformConfig so the
/// buyer cannot redirect any portion of the payment.
#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct BuyTicket<'info> {
    /// The buyer/user purchasing the ticket. Pays USDC.
    #[account(mut)]
    pub buyer: Signer<'info>,

    /// The buyer's USDC token account (ATA), from which USDC is deducted.
    #[account(
        mut,
        token::mint = usdc_mint,
        token::authority = buyer,
    )]
    pub buyer_usdc_account: Box<Account<'info, TokenAccount>>,

    /// The USDC mint — must match the mint registered in PlatformConfig.
    #[account(address = platform_config.usdc_mint @ GameeError::InvalidMint)]
    pub usdc_mint: Box<Account<'info, Mint>>,

    /// Platform/treasury USDC wallet — receives 10%.
    #[account(
        mut,
        token::mint = usdc_mint,
        constraint = platform_usdc_account.owner == platform_config.platform_wallet
            @ GameeError::InvalidDestinationAccount,
    )]
    pub platform_usdc_account: Box<Account<'info, TokenAccount>>,

    /// Referral USDC wallet — receives 5%.
    #[account(
        mut,
        token::mint = usdc_mint,
        constraint = referral_usdc_account.owner == platform_config.referral_wallet
            @ GameeError::InvalidDestinationAccount,
    )]
    pub referral_usdc_account: Box<Account<'info, TokenAccount>>,

    /// Jackpot vault USDC account — receives 80%. Tier-agnostic by design:
    /// this can be any tier's vault token account, not just "small". Safety
    /// doesn't come from a fixed address here — it comes from the
    /// `jackpot_vault` constraint below, which requires the passed-in
    /// vault PDA to be a real, already-admin-initialized `JackpotVault`
    /// (its own `seeds` are derived from its own stored `tier` field, so a
    /// forged or uninitialized account can't deserialize/pass) AND that its
    /// on-chain-recorded `vault_token_account` equals this account's key.
    /// A caller can therefore route the 80% cut to any of the four
    /// admin-created tier vaults, but never to an arbitrary token account.
    #[account(
        mut,
        token::mint = usdc_mint,
    )]
    pub jackpot_usdc_account: Box<Account<'info, TokenAccount>>,

    /// The jackpot vault PDA — its stats are updated with this purchase.
    #[account(
        mut,
        seeds = [b"jackpot", jackpot_vault.tier.as_bytes()],
        bump,
        constraint = jackpot_vault.vault_token_account == jackpot_usdc_account.key()
            @ GameeError::InvalidDestinationAccount,
    )]
    pub jackpot_vault: Box<Account<'info, JackpotVault>>,

    /// Dev/operations USDC account — receives 5%.
    #[account(
        mut,
        token::mint = usdc_mint,
        constraint = dev_usdc_account.owner == platform_config.dev_wallet
            @ GameeError::InvalidDestinationAccount,
    )]
    pub dev_usdc_account: Account<'info, TokenAccount>,

    /// The Ticket PDA to be created.
    #[account(
        init,
        seeds = [b"ticket", buyer.key().as_ref(), nonce.to_le_bytes().as_ref()],
        bump,
        payer = buyer,
        space = 8 + Ticket::INIT_SPACE,
    )]
    pub ticket: Account<'info, Ticket>,

    /// Platform config (singleton PDA).
    #[account(
        seeds = [b"platform_config"],
        bump,
    )]
    pub platform_config: Box<Account<'info, PlatformConfig>>,

    /// Token program.
    pub token_program: Program<'info, Token>,

    /// System program (for rent).
    pub system_program: Program<'info, System>,
}

impl<'info> BuyTicket<'info> {
    /// Transfer `amount` USDC from buyer to a destination account.
    fn transfer_usdc(&self, destination: &Account<'info, TokenAccount>, amount: u64) -> Result<()> {
        let cpi_accounts = SplTransfer {
            from: self.buyer_usdc_account.to_account_info(),
            to: destination.to_account_info(),
            authority: self.buyer.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(self.token_program.to_account_info(), cpi_accounts);
        token::transfer(cpi_ctx, amount)
    }
}

pub fn handler(ctx: Context<BuyTicket>, nonce: u64, total_amount: u64) -> Result<()> {
    let config = &ctx.accounts.platform_config;

    // Ensure platform is not paused
    if config.paused {
        return Err(GameeError::PlatformPaused.into());
    }

    // Enforce the configured ticket price — the buyer cannot choose the amount.
    require!(
        total_amount == config.ticket_price,
        GameeError::InvalidTicketPrice
    );

    // Validate the fee rates sum to 100% = 10000 bps
    let total_bps = config
        .platform_fee_bps
        .checked_add(config.jackpot_fee_bps)
        .ok_or(GameeError::ArithmeticError)?
        .checked_add(config.referral_fee_bps)
        .ok_or(GameeError::ArithmeticError)?
        .checked_add(config.dev_fee_bps)
        .ok_or(GameeError::ArithmeticError)?;

    require!(total_bps == 10_000, GameeError::InvalidFeeRate);

    // Calculate splits
    // 80% = jackpot_fee_bps, 10% = platform_fee_bps,
    //  5% = referral_fee_bps, 5% = dev_fee_bps
    let platform_amount = total_amount
        .checked_mul(config.platform_fee_bps as u64)
        .ok_or(GameeError::ArithmeticError)?
        .checked_div(10_000)
        .ok_or(GameeError::ArithmeticError)?;

    let referral_amount = total_amount
        .checked_mul(config.referral_fee_bps as u64)
        .ok_or(GameeError::ArithmeticError)?
        .checked_div(10_000)
        .ok_or(GameeError::ArithmeticError)?;

    let dev_amount = total_amount
        .checked_mul(config.dev_fee_bps as u64)
        .ok_or(GameeError::ArithmeticError)?
        .checked_div(10_000)
        .ok_or(GameeError::ArithmeticError)?;

    // The jackpot receives the remainder so the full ticket price is
    // always distributed (no dust left with the buyer).
    let jackpot_amount = total_amount
        .checked_sub(platform_amount)
        .ok_or(GameeError::ArithmeticError)?
        .checked_sub(referral_amount)
        .ok_or(GameeError::ArithmeticError)?
        .checked_sub(dev_amount)
        .ok_or(GameeError::ArithmeticError)?;

    // Execute transfers
    // 80% to jackpot vault
    ctx.accounts
        .transfer_usdc(&ctx.accounts.jackpot_usdc_account, jackpot_amount)?;

    // 10% to platform/treasury wallet
    ctx.accounts
        .transfer_usdc(&ctx.accounts.platform_usdc_account, platform_amount)?;

    // 5% to referral wallet
    ctx.accounts
        .transfer_usdc(&ctx.accounts.referral_usdc_account, referral_amount)?;

    // 5% to dev/operations wallet
    ctx.accounts
        .transfer_usdc(&ctx.accounts.dev_usdc_account, dev_amount)?;

    // Update jackpot vault stats
    let vault = &mut ctx.accounts.jackpot_vault;
    vault.total_amount = vault
        .total_amount
        .checked_add(jackpot_amount)
        .ok_or(GameeError::ArithmeticError)?;
    vault.total_plays = vault
        .total_plays
        .checked_add(1)
        .ok_or(GameeError::ArithmeticError)?;

    // Initialize ticket PDA
    let ticket = &mut ctx.accounts.ticket;
    ticket.buyer = ctx.accounts.buyer.key();
    ticket.nonce = nonce;
    ticket.amount_usdc = total_amount;
    ticket.purchased_at = Clock::get()?.unix_timestamp;
    ticket.consumed = false;
    ticket.game_session = None;

    Ok(())
}
