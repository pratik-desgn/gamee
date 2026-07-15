use anchor_lang::error_code;

#[error_code]
pub enum GameeError {
    #[msg("Insufficient funds to complete the transaction")]
    InsufficientFunds,

    #[msg("Ticket has already been consumed")]
    TicketAlreadyConsumed,

    #[msg("You are not authorized to perform this action")]
    Unauthorized,

    #[msg("Session has already been settled")]
    SessionAlreadySettled,

    #[msg("Invalid VRF result provided")]
    InvalidVRFResult,

    #[msg("Game is not currently enabled")]
    GameNotEnabled,

    #[msg("Arithmetic overflow or underflow")]
    ArithmeticError,

    #[msg("Invalid fee rate configuration")]
    InvalidFeeRate,

    #[msg("Jackpot vault is empty or below minimum")]
    JackpotUnderflow,

    #[msg("Game session is not in a valid state for this operation")]
    InvalidSessionState,

    #[msg("Ticket PDA already exists for this user")]
    TicketAlreadyExists,

    #[msg("Platform is paused")]
    PlatformPaused,

    #[msg("Invalid verifier signature or authority")]
    InvalidVerifier,

    #[msg("Payment amount does not match the configured ticket price")]
    InvalidTicketPrice,

    #[msg("Token mint does not match the configured USDC mint")]
    InvalidMint,

    #[msg("Destination token account does not match platform configuration")]
    InvalidDestinationAccount,

    #[msg("Not enough distinct verifier-set members co-signed this transaction")]
    VerifierQuorumNotMet,

    #[msg("Signer is not a member of the verifier set")]
    VerifierNotInSet,

    #[msg("Invalid verifier set configuration: need 1 <= threshold <= verifiers.len() <= 5, no duplicates")]
    InvalidVerifierSetConfig,
}
