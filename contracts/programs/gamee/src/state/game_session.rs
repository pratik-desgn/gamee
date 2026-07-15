use anchor_lang::prelude::*;

/// A game session PDA created when a ticket is consumed and a spin is committed.
///
/// Seeds: [b"game_session", ticket.key().as_ref()]
#[account]
#[derive(InitSpace)]
pub struct GameSession {
    /// The ticket this session is bound to
    pub ticket: Pubkey,
    /// The buyer/user who owns the ticket
    pub player: Pubkey,
    /// The game_id that was selected by VRF
    #[max_len(32)]
    pub game_id: String,
    /// The raw VRF result from Switchboard (or simulated)
    pub vrf_result: u128,
    /// Derived seed from VRF result
    #[max_len(64)]
    pub seed: String,
    /// Timestamp when the session was created
    pub created_at: i64,
    /// Whether this session has been settled (win/loss determined)
    pub settled: bool,
    /// The result: "pending", "won", or "lost"
    #[max_len(16)]
    pub result: String,
    /// The score the player achieved (set by verifier)
    pub final_score: u64,
    /// Target score needed to win (set by verifier)
    pub target_score: u64,
    /// The verifier authority that settled this session
    pub settled_by: Option<Pubkey>,
}

impl GameSession {
    pub const LEN: usize = 8  // discriminator
        + 32 // ticket
        + 32 // player
        + 36 // game_id (4 + max 32)
        + 16 // vrf_result
        + 68 // seed (4 + max 64)
        + 8  // created_at
        + 1  // settled
        + 20 // result (4 + max 16)
        + 8  // final_score
        + 8  // target_score
        + 33; // settled_by (Option<Pubkey>)
}
