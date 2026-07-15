use anchor_lang::prelude::*;

/// Admin-settable game configuration stored on-chain.
///
/// Seeds: [b"game_config", game_id.as_bytes()]
#[account]
#[derive(InitSpace)]
pub struct GameConfig {
    /// Unique game identifier (slug, e.g. "wing-rush")
    #[max_len(32)]
    pub game_id: String,
    /// Display name
    #[max_len(64)]
    pub name: String,
    /// Category slug
    #[max_len(32)]
    pub category: String,
    /// Weight on the prize wheel (higher = more likely to be selected)
    pub wheel_weight: u64,
    /// Total weight of all games (used for normalization)
    pub total_weight: u64,
    /// Base difficulty (1-10)
    pub base_difficulty: u8,
    /// Whether this game is currently enabled for play
    pub enabled: bool,
    /// Timestamp when this config was created
    pub created_at: i64,
    /// The admin who last updated this config
    pub last_updated_by: Pubkey,
}

impl GameConfig {
    pub const LEN: usize = 8  // discriminator
        + 36 // game_id (4 + max 32)
        + 68 // name (4 + max 64)
        + 36 // category (4 + max 32)
        + 8  // wheel_weight
        + 8  // total_weight
        + 1  // base_difficulty
        + 1  // enabled
        + 8  // created_at
        + 32; // last_updated_by
}
