use anchor_lang::prelude::*;

/// A jackpot vault PDA that holds USDC collected from ticket sales (80% cut).
///
/// Seeds: [b"jackpot", tier.as_bytes()]
#[account]
#[derive(InitSpace)]
pub struct JackpotVault {
    /// The tier label: "small", "medium", "mega", "legend"
    #[max_len(16)]
    pub tier: String,
    /// The token account holding the USDC
    pub vault_token_account: Pubkey,
    /// Total amount accumulated (in USDC lamports)
    pub total_amount: u64,
    /// Amount that has been paid out historically
    pub total_paid_out: u64,
    /// Number of plays against this jackpot
    pub total_plays: u64,
    /// The last time a winner was paid from this vault
    pub last_won_at: i64,
    /// Whether this jackpot is currently active
    pub active: bool,
}

impl JackpotVault {
    pub const LEN: usize = 8  // discriminator
        + 16 // tier (4 + max 12 chars)
        + 32 // vault_token_account
        + 8  // total_amount
        + 8  // total_paid_out
        + 8  // total_plays
        + 8  // last_won_at
        + 1; // active
}
