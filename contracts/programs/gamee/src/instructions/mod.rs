pub mod admin;
pub mod buy_ticket;
pub mod commit_spin;
pub mod settle_session;
pub mod verifier_set;

// Glob re-exports so lib.rs's #[program] fns can name each Accounts struct
// unqualified (e.g. Context<BuyTicket>). Each submodule also defines its own
// `pub fn handler`, so the re-exported names collide — harmless, since
// lib.rs always calls the qualified form (buy_ticket::handler(...), etc.)
// and never the ambiguous unqualified name.
#[allow(ambiguous_glob_reexports)]
pub use admin::*;
#[allow(ambiguous_glob_reexports)]
pub use buy_ticket::*;
#[allow(ambiguous_glob_reexports)]
pub use commit_spin::*;
#[allow(ambiguous_glob_reexports)]
pub use settle_session::*;
#[allow(ambiguous_glob_reexports)]
pub use verifier_set::*;
