use anchor_lang::prelude::*;

/// Threshold-signature verifier set gating money-moving instructions
/// (`settle_session`) and spin co-signing (`commit_spin`, 1-of-N membership
/// only — see that instruction's doc comment for why quorum isn't required
/// there).
///
/// Singleton PDA: seeds = [b"verifier_set"]
///
/// Invariants (enforced by `init_verifier_set` / `update_verifier_set`):
///   1 <= threshold <= verifiers.len() <= 5, and no duplicate pubkeys.
#[account]
#[derive(InitSpace)]
pub struct VerifierSet {
    /// Member verifier pubkeys (1..=5, no duplicates).
    #[max_len(5)]
    pub verifiers: Vec<Pubkey>,
    /// Minimum number of distinct member signatures required to settle a
    /// session.
    pub threshold: u8,
}
