use anchor_lang::prelude::*;

/// A ticket PDA representing a purchased spin on the GAMEE wheel.
///
/// Seeds: [b"ticket", buyer.key().as_ref(), ticket_nonce.as_le_bytes()]
#[account]
#[derive(InitSpace)]
pub struct Ticket {
    /// The buyer / user who purchased this ticket
    pub buyer: Pubkey,
    /// Monotonically increasing nonce per buyer to derive unique PDA
    pub nonce: u64,
    /// Amount of USDC paid (in 10^6 lamports / USDC decimals)
    pub amount_usdc: u64,
    /// Timestamp (unix seconds) when the ticket was purchased
    pub purchased_at: i64,
    /// Whether the ticket has been consumed (used for a spin)
    pub consumed: bool,
    /// When consumed, the game session PDA that was created
    pub game_session: Option<Pubkey>,
}

impl Ticket {
    /// Space for Ticket account
    pub const LEN: usize = 8  // discriminator
        + 32  // buyer
        + 8   // nonce
        + 8   // amount_usdc
        + 8   // purchased_at
        + 1   // consumed (bool)
        + 33; // game_session (Option<Pubkey> = 1 + 32)
}
