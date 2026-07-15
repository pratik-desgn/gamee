use anchor_lang::prelude::*;

/// Platform-level configuration: authority keys, fee rates, pause state.
///
/// Singleton PDA: seeds = [b"platform_config"]
#[account]
#[derive(InitSpace)]
pub struct PlatformConfig {
    /// The admin authority (can add games, update weights, pause)
    pub admin: Pubkey,
    /// The verifier authority (can settle sessions)
    pub verifier: Pubkey,
    /// Whether the contract is paused
    pub paused: bool,
    /// Fee rate for platform/treasury fee (in basis points, 1000 = 10%)
    pub platform_fee_bps: u16,
    /// Fee rate for jackpot contribution (in basis points, 8000 = 80%)
    pub jackpot_fee_bps: u16,
    /// Fee rate for referral rewards (in basis points, 500 = 5%)
    pub referral_fee_bps: u16,
    /// Fee rate for dev/operations fund (in basis points, 500 = 5%)
    pub dev_fee_bps: u16,
    /// Required ticket price in USDC base units (1_000_000 = 1 USDC)
    pub ticket_price: u64,
    /// The USDC token mint address
    pub usdc_mint: Pubkey,
    /// Platform/treasury fee wallet authority (receives 10% of ticket)
    pub platform_wallet: Pubkey,
    /// Dev/operations wallet authority (receives 5% of ticket)
    pub dev_wallet: Pubkey,
    /// Referral wallet authority (receives 5% of ticket)
    pub referral_wallet: Pubkey,
    /// The jackpot vault's USDC token account (receives 80% of ticket)
    pub jackpot_vault_token_account: Pubkey,
}
