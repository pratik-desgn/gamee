/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/gamee.json`.
 */
export type Gamee = {
  "address": "9ZjYdP5QQB6SHbQWRocLDtuxga519Z4ZQsVct1ESkJYa",
  "metadata": {
    "name": "gamee",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "GAMEE — On-chain ticket, spin, and jackpot program"
  },
  "instructions": [
    {
      "name": "addGame",
      "docs": [
        "Register a new game with its wheel weight and difficulty params."
      ],
      "discriminator": [
        251,
        247,
        12,
        85,
        217,
        241,
        122,
        59
      ],
      "accounts": [
        {
          "name": "admin",
          "docs": [
            "The admin authority — must match PlatformConfig.admin."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "platformConfig",
          "docs": [
            "Platform config (singleton PDA)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  116,
                  102,
                  111,
                  114,
                  109,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "gameConfig",
          "docs": [
            "The game config PDA to create."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  97,
                  109,
                  101,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              },
              {
                "kind": "arg",
                "path": "gameId"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "docs": [
            "System program."
          ],
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "gameId",
          "type": "string"
        },
        {
          "name": "name",
          "type": "string"
        },
        {
          "name": "category",
          "type": "string"
        },
        {
          "name": "wheelWeight",
          "type": "u64"
        },
        {
          "name": "baseDifficulty",
          "type": "u8"
        }
      ]
    },
    {
      "name": "buyTicket",
      "docs": [
        "Buy a ticket with USDC. Applies 80/10/5/5 split across:",
        "- 80% jackpot vault",
        "- 10% platform/treasury wallet",
        "-  5% referral wallet",
        "-  5% dev/operations wallet",
        "",
        "Mints a Ticket PDA seeded by [buyer, nonce]."
      ],
      "discriminator": [
        11,
        24,
        17,
        193,
        168,
        116,
        164,
        169
      ],
      "accounts": [
        {
          "name": "buyer",
          "docs": [
            "The buyer/user purchasing the ticket. Pays USDC."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "buyerUsdcAccount",
          "docs": [
            "The buyer's USDC token account (ATA), from which USDC is deducted."
          ],
          "writable": true
        },
        {
          "name": "usdcMint",
          "docs": [
            "The USDC mint — must match the mint registered in PlatformConfig."
          ]
        },
        {
          "name": "platformUsdcAccount",
          "docs": [
            "Platform/treasury USDC wallet — receives 10%."
          ],
          "writable": true
        },
        {
          "name": "referralUsdcAccount",
          "docs": [
            "Referral USDC wallet — receives 5%."
          ],
          "writable": true
        },
        {
          "name": "jackpotUsdcAccount",
          "docs": [
            "Jackpot vault USDC account — receives 80%. Tier-agnostic by design:",
            "this can be any tier's vault token account, not just \"small\". Safety",
            "doesn't come from a fixed address here — it comes from the",
            "`jackpot_vault` constraint below, which requires the passed-in",
            "vault PDA to be a real, already-admin-initialized `JackpotVault`",
            "(its own `seeds` are derived from its own stored `tier` field, so a",
            "forged or uninitialized account can't deserialize/pass) AND that its",
            "on-chain-recorded `vault_token_account` equals this account's key.",
            "A caller can therefore route the 80% cut to any of the four",
            "admin-created tier vaults, but never to an arbitrary token account."
          ],
          "writable": true
        },
        {
          "name": "jackpotVault",
          "docs": [
            "The jackpot vault PDA — its stats are updated with this purchase."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  106,
                  97,
                  99,
                  107,
                  112,
                  111,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "jackpot_vault.tier",
                "account": "jackpotVault"
              }
            ]
          }
        },
        {
          "name": "devUsdcAccount",
          "docs": [
            "Dev/operations USDC account — receives 5%."
          ],
          "writable": true
        },
        {
          "name": "ticket",
          "docs": [
            "The Ticket PDA to be created."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  105,
                  99,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "buyer"
              },
              {
                "kind": "arg",
                "path": "nonce"
              }
            ]
          }
        },
        {
          "name": "platformConfig",
          "docs": [
            "Platform config (singleton PDA)."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  116,
                  102,
                  111,
                  114,
                  109,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "docs": [
            "Token program."
          ],
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "docs": [
            "System program (for rent)."
          ],
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "nonce",
          "type": "u64"
        },
        {
          "name": "totalAmount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "commitSpin",
      "docs": [
        "Commit a spin after VRF result is obtained.",
        "Records the VRF result, marks the ticket consumed, and creates a GameSession PDA."
      ],
      "discriminator": [
        98,
        186,
        55,
        119,
        251,
        18,
        246,
        55
      ],
      "accounts": [
        {
          "name": "player",
          "docs": [
            "The buyer/user who owns the ticket. Pays rent for the session PDA."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "verifier",
          "docs": [
            "The verifier authority — co-signs to attest that game_id and vrf_result",
            "genuinely came from the VRF oracle (the player cannot pick their game).",
            "Must be a member of `verifier_set` (checked in the handler). Spins are",
            "low-risk (no funds move), so 1-of-N membership is enough — quorum is",
            "reserved for settle_session's money movement."
          ],
          "signer": true
        },
        {
          "name": "platformConfig",
          "docs": [
            "Platform config singleton."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  116,
                  102,
                  111,
                  114,
                  109,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "verifierSet",
          "docs": [
            "Threshold verifier set — supplies valid verifier membership."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  101,
                  114,
                  105,
                  102,
                  105,
                  101,
                  114,
                  95,
                  115,
                  101,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "ticket",
          "docs": [
            "The ticket to be consumed — must not already be consumed."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  105,
                  99,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "player"
              },
              {
                "kind": "account",
                "path": "ticket.nonce",
                "account": "ticket"
              }
            ]
          }
        },
        {
          "name": "gameConfig",
          "docs": [
            "The game config for the selected game (determined by VRF).",
            "PDA seeds include the game_id string, ensuring the VRF-selected game is valid."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  97,
                  109,
                  101,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              },
              {
                "kind": "arg",
                "path": "gameId"
              }
            ]
          }
        },
        {
          "name": "gameSession",
          "docs": [
            "The game session PDA to create (seeded by ticket pubkey)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  97,
                  109,
                  101,
                  95,
                  115,
                  101,
                  115,
                  115,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "ticket"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "docs": [
            "System program (for rent exemption)."
          ],
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "gameId",
          "type": "string"
        },
        {
          "name": "vrfResult",
          "type": "u128"
        },
        {
          "name": "seed",
          "type": "string"
        }
      ]
    },
    {
      "name": "initVerifierSet",
      "docs": [
        "Initialize the threshold verifier set singleton. Called once, after",
        "initialize_platform and before the first commit_spin/settle_session."
      ],
      "discriminator": [
        30,
        43,
        62,
        51,
        10,
        14,
        217,
        215
      ],
      "accounts": [
        {
          "name": "admin",
          "docs": [
            "The admin authority — must match PlatformConfig.admin."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "platformConfig",
          "docs": [
            "Platform config (singleton PDA)."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  116,
                  102,
                  111,
                  114,
                  109,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "verifierSet",
          "docs": [
            "The verifier set PDA to create."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  101,
                  114,
                  105,
                  102,
                  105,
                  101,
                  114,
                  95,
                  115,
                  101,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "docs": [
            "System program."
          ],
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "verifiers",
          "type": {
            "vec": "pubkey"
          }
        },
        {
          "name": "threshold",
          "type": "u8"
        }
      ]
    },
    {
      "name": "initializeJackpot",
      "docs": [
        "Initialize a jackpot vault PDA for a tier (\"small\", \"medium\", \"mega\", \"legend\")."
      ],
      "discriminator": [
        203,
        117,
        104,
        67,
        62,
        238,
        90,
        170
      ],
      "accounts": [
        {
          "name": "admin",
          "docs": [
            "The admin authority — must match PlatformConfig.admin."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "platformConfig",
          "docs": [
            "Platform config (singleton PDA)."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  116,
                  102,
                  111,
                  114,
                  109,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "jackpotVault",
          "docs": [
            "The jackpot vault PDA to create."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  106,
                  97,
                  99,
                  107,
                  112,
                  111,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "tier"
              }
            ]
          }
        },
        {
          "name": "vaultTokenAccount",
          "docs": [
            "The USDC token account owned by the jackpot vault PDA."
          ]
        },
        {
          "name": "systemProgram",
          "docs": [
            "System program."
          ],
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "tier",
          "type": "string"
        }
      ]
    },
    {
      "name": "initializePlatform",
      "docs": [
        "Initialize the platform config singleton. Called once at deployment."
      ],
      "discriminator": [
        119,
        201,
        101,
        45,
        75,
        122,
        89,
        3
      ],
      "accounts": [
        {
          "name": "admin",
          "docs": [
            "The initial admin authority."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "platformConfig",
          "docs": [
            "The platform config PDA to create."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  116,
                  102,
                  111,
                  114,
                  109,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "usdcMint",
          "docs": [
            "The USDC mint address."
          ]
        },
        {
          "name": "systemProgram",
          "docs": [
            "System program."
          ],
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "verifier",
          "type": "pubkey"
        },
        {
          "name": "platformWallet",
          "type": "pubkey"
        },
        {
          "name": "devWallet",
          "type": "pubkey"
        },
        {
          "name": "referralWallet",
          "type": "pubkey"
        },
        {
          "name": "ticketPrice",
          "type": "u64"
        },
        {
          "name": "jackpotVaultTokenAccount",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "pauseContract",
      "docs": [
        "Toggle pause state for the entire platform."
      ],
      "discriminator": [
        210,
        36,
        5,
        85,
        177,
        65,
        35,
        89
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true
        },
        {
          "name": "platformConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  116,
                  102,
                  111,
                  114,
                  109,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "paused",
          "type": "bool"
        }
      ]
    },
    {
      "name": "setAuthority",
      "docs": [
        "Transfer admin authority to a new pubkey."
      ],
      "discriminator": [
        133,
        250,
        37,
        21,
        110,
        163,
        26,
        121
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true
        },
        {
          "name": "platformConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  116,
                  102,
                  111,
                  114,
                  109,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "newAdmin",
          "docs": [
            "The new admin pubkey."
          ]
        }
      ],
      "args": []
    },
    {
      "name": "setVerifier",
      "docs": [
        "Set the verifier authority pubkey."
      ],
      "discriminator": [
        186,
        247,
        191,
        131,
        148,
        158,
        213,
        63
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true
        },
        {
          "name": "platformConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  116,
                  102,
                  111,
                  114,
                  109,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "newVerifier",
          "docs": [
            "The new verifier pubkey."
          ]
        }
      ],
      "args": []
    },
    {
      "name": "settleSession",
      "docs": [
        "Settle a game session after replay verification.",
        "The verifier authority signs off on final_score and target_score.",
        "If won, pays out 95% of jackpot vault to winner, 5% seeds next jackpot."
      ],
      "discriminator": [
        156,
        20,
        180,
        117,
        117,
        85,
        225,
        128
      ],
      "accounts": [
        {
          "name": "verifier",
          "docs": [
            "Fee-payer / primary co-signer. Must be a member of `verifier_set` —",
            "membership and quorum are both checked in the handler (together with",
            "any additional co-signers passed via remaining_accounts)."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "player",
          "docs": [
            "The player (used for PDA seed derivation)."
          ]
        },
        {
          "name": "ticket",
          "docs": [
            "The ticket associated with this session."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  105,
                  99,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "player"
              },
              {
                "kind": "account",
                "path": "ticket.nonce",
                "account": "ticket"
              }
            ]
          }
        },
        {
          "name": "gameSession",
          "docs": [
            "The game session to settle — must not already be settled, and must belong to player."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  97,
                  109,
                  101,
                  95,
                  115,
                  101,
                  115,
                  115,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "ticket"
              }
            ]
          }
        },
        {
          "name": "platformConfig",
          "docs": [
            "Platform config singleton."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  116,
                  102,
                  111,
                  114,
                  109,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "verifierSet",
          "docs": [
            "Threshold verifier set — membership + quorum are checked in the handler."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  101,
                  114,
                  105,
                  102,
                  105,
                  101,
                  114,
                  95,
                  115,
                  101,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "jackpotVault",
          "docs": [
            "Jackpot vault PDA — if won, payout is deducted from here."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  106,
                  97,
                  99,
                  107,
                  112,
                  111,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "jackpot_vault.tier",
                "account": "jackpotVault"
              }
            ]
          }
        },
        {
          "name": "jackpotUsdcAccount",
          "docs": [
            "The jackpot vault's USDC token account — must be the vault's registered account."
          ],
          "writable": true
        },
        {
          "name": "winnerUsdcAccount",
          "docs": [
            "The winner's USDC token account (receives 95% of payout) — must be owned by the player."
          ],
          "writable": true
        },
        {
          "name": "nextJackpotUsdcAccount",
          "docs": [
            "The next jackpot vault's USDC token account (receives 5% to seed next round)."
          ],
          "writable": true
        },
        {
          "name": "nextJackpotVault",
          "docs": [
            "The next jackpot vault PDA — ties `next_jackpot_usdc_account` to a",
            "real, admin-initialized tier vault (same pattern as buy_ticket's",
            "tier-agnostic `jackpot_vault` check: this can be any tier's vault, but",
            "its `seeds` are derived from its own stored `tier` field, so a forged",
            "or uninitialized account can't deserialize/pass, AND its",
            "on-chain-recorded `vault_token_account` must equal",
            "`next_jackpot_usdc_account`'s key). Closes the previously-unconstrained",
            "reseed-destination hole where a compromised verifier could redirect",
            "the 5% reseed to an arbitrary token account."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  106,
                  97,
                  99,
                  107,
                  112,
                  111,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "next_jackpot_vault.tier",
                "account": "jackpotVault"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "docs": [
            "Token program."
          ],
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "docs": [
            "System program."
          ],
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "finalScore",
          "type": "u64"
        },
        {
          "name": "targetScore",
          "type": "u64"
        }
      ]
    },
    {
      "name": "updateVerifierSet",
      "docs": [
        "Replace the verifier set's member list and threshold (admin only)."
      ],
      "discriminator": [
        78,
        165,
        2,
        119,
        245,
        171,
        177,
        222
      ],
      "accounts": [
        {
          "name": "admin",
          "docs": [
            "The admin authority — must match PlatformConfig.admin."
          ],
          "signer": true
        },
        {
          "name": "platformConfig",
          "docs": [
            "Platform config (singleton PDA)."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  116,
                  102,
                  111,
                  114,
                  109,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "verifierSet",
          "docs": [
            "The verifier set PDA to update."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  101,
                  114,
                  105,
                  102,
                  105,
                  101,
                  114,
                  95,
                  115,
                  101,
                  116
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "verifiers",
          "type": {
            "vec": "pubkey"
          }
        },
        {
          "name": "threshold",
          "type": "u8"
        }
      ]
    },
    {
      "name": "updateWeight",
      "docs": [
        "Update the wheel weight for an existing game."
      ],
      "discriminator": [
        215,
        79,
        245,
        34,
        103,
        152,
        76,
        206
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true
        },
        {
          "name": "platformConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  116,
                  102,
                  111,
                  114,
                  109,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "gameConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  97,
                  109,
                  101,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              },
              {
                "kind": "arg",
                "path": "gameId"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "gameId",
          "type": "string"
        },
        {
          "name": "newWeight",
          "type": "u64"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "gameConfig",
      "discriminator": [
        45,
        146,
        146,
        33,
        170,
        69,
        96,
        133
      ]
    },
    {
      "name": "gameSession",
      "discriminator": [
        150,
        116,
        20,
        197,
        205,
        121,
        220,
        240
      ]
    },
    {
      "name": "jackpotVault",
      "discriminator": [
        92,
        180,
        135,
        82,
        50,
        74,
        83,
        167
      ]
    },
    {
      "name": "platformConfig",
      "discriminator": [
        160,
        78,
        128,
        0,
        248,
        83,
        230,
        160
      ]
    },
    {
      "name": "ticket",
      "discriminator": [
        41,
        228,
        24,
        165,
        78,
        90,
        235,
        200
      ]
    },
    {
      "name": "verifierSet",
      "discriminator": [
        227,
        16,
        215,
        74,
        157,
        114,
        239,
        185
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "insufficientFunds",
      "msg": "Insufficient funds to complete the transaction"
    },
    {
      "code": 6001,
      "name": "ticketAlreadyConsumed",
      "msg": "Ticket has already been consumed"
    },
    {
      "code": 6002,
      "name": "unauthorized",
      "msg": "You are not authorized to perform this action"
    },
    {
      "code": 6003,
      "name": "sessionAlreadySettled",
      "msg": "Session has already been settled"
    },
    {
      "code": 6004,
      "name": "invalidVrfResult",
      "msg": "Invalid VRF result provided"
    },
    {
      "code": 6005,
      "name": "gameNotEnabled",
      "msg": "Game is not currently enabled"
    },
    {
      "code": 6006,
      "name": "arithmeticError",
      "msg": "Arithmetic overflow or underflow"
    },
    {
      "code": 6007,
      "name": "invalidFeeRate",
      "msg": "Invalid fee rate configuration"
    },
    {
      "code": 6008,
      "name": "jackpotUnderflow",
      "msg": "Jackpot vault is empty or below minimum"
    },
    {
      "code": 6009,
      "name": "invalidSessionState",
      "msg": "Game session is not in a valid state for this operation"
    },
    {
      "code": 6010,
      "name": "ticketAlreadyExists",
      "msg": "Ticket PDA already exists for this user"
    },
    {
      "code": 6011,
      "name": "platformPaused",
      "msg": "Platform is paused"
    },
    {
      "code": 6012,
      "name": "invalidVerifier",
      "msg": "Invalid verifier signature or authority"
    },
    {
      "code": 6013,
      "name": "invalidTicketPrice",
      "msg": "Payment amount does not match the configured ticket price"
    },
    {
      "code": 6014,
      "name": "invalidMint",
      "msg": "Token mint does not match the configured USDC mint"
    },
    {
      "code": 6015,
      "name": "invalidDestinationAccount",
      "msg": "Destination token account does not match platform configuration"
    },
    {
      "code": 6016,
      "name": "verifierQuorumNotMet",
      "msg": "Not enough distinct verifier-set members co-signed this transaction"
    },
    {
      "code": 6017,
      "name": "verifierNotInSet",
      "msg": "Signer is not a member of the verifier set"
    },
    {
      "code": 6018,
      "name": "invalidVerifierSetConfig",
      "msg": "Invalid verifier set configuration: need 1 <= threshold <= verifiers.len() <= 5, no duplicates"
    }
  ],
  "types": [
    {
      "name": "gameConfig",
      "docs": [
        "Admin-settable game configuration stored on-chain.",
        "",
        "Seeds: [b\"game_config\", game_id.as_bytes()]"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "gameId",
            "docs": [
              "Unique game identifier (slug, e.g. \"wing-rush\")"
            ],
            "type": "string"
          },
          {
            "name": "name",
            "docs": [
              "Display name"
            ],
            "type": "string"
          },
          {
            "name": "category",
            "docs": [
              "Category slug"
            ],
            "type": "string"
          },
          {
            "name": "wheelWeight",
            "docs": [
              "Weight on the prize wheel (higher = more likely to be selected)"
            ],
            "type": "u64"
          },
          {
            "name": "totalWeight",
            "docs": [
              "Total weight of all games (used for normalization)"
            ],
            "type": "u64"
          },
          {
            "name": "baseDifficulty",
            "docs": [
              "Base difficulty (1-10)"
            ],
            "type": "u8"
          },
          {
            "name": "enabled",
            "docs": [
              "Whether this game is currently enabled for play"
            ],
            "type": "bool"
          },
          {
            "name": "createdAt",
            "docs": [
              "Timestamp when this config was created"
            ],
            "type": "i64"
          },
          {
            "name": "lastUpdatedBy",
            "docs": [
              "The admin who last updated this config"
            ],
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "gameSession",
      "docs": [
        "A game session PDA created when a ticket is consumed and a spin is committed.",
        "",
        "Seeds: [b\"game_session\", ticket.key().as_ref()]"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "ticket",
            "docs": [
              "The ticket this session is bound to"
            ],
            "type": "pubkey"
          },
          {
            "name": "player",
            "docs": [
              "The buyer/user who owns the ticket"
            ],
            "type": "pubkey"
          },
          {
            "name": "gameId",
            "docs": [
              "The game_id that was selected by VRF"
            ],
            "type": "string"
          },
          {
            "name": "vrfResult",
            "docs": [
              "The raw VRF result from Switchboard (or simulated)"
            ],
            "type": "u128"
          },
          {
            "name": "seed",
            "docs": [
              "Derived seed from VRF result"
            ],
            "type": "string"
          },
          {
            "name": "createdAt",
            "docs": [
              "Timestamp when the session was created"
            ],
            "type": "i64"
          },
          {
            "name": "settled",
            "docs": [
              "Whether this session has been settled (win/loss determined)"
            ],
            "type": "bool"
          },
          {
            "name": "result",
            "docs": [
              "The result: \"pending\", \"won\", or \"lost\""
            ],
            "type": "string"
          },
          {
            "name": "finalScore",
            "docs": [
              "The score the player achieved (set by verifier)"
            ],
            "type": "u64"
          },
          {
            "name": "targetScore",
            "docs": [
              "Target score needed to win (set by verifier)"
            ],
            "type": "u64"
          },
          {
            "name": "settledBy",
            "docs": [
              "The verifier authority that settled this session"
            ],
            "type": {
              "option": "pubkey"
            }
          }
        ]
      }
    },
    {
      "name": "jackpotVault",
      "docs": [
        "A jackpot vault PDA that holds USDC collected from ticket sales (80% cut).",
        "",
        "Seeds: [b\"jackpot\", tier.as_bytes()]"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "tier",
            "docs": [
              "The tier label: \"small\", \"medium\", \"mega\", \"legend\""
            ],
            "type": "string"
          },
          {
            "name": "vaultTokenAccount",
            "docs": [
              "The token account holding the USDC"
            ],
            "type": "pubkey"
          },
          {
            "name": "totalAmount",
            "docs": [
              "Total amount accumulated (in USDC lamports)"
            ],
            "type": "u64"
          },
          {
            "name": "totalPaidOut",
            "docs": [
              "Amount that has been paid out historically"
            ],
            "type": "u64"
          },
          {
            "name": "totalPlays",
            "docs": [
              "Number of plays against this jackpot"
            ],
            "type": "u64"
          },
          {
            "name": "lastWonAt",
            "docs": [
              "The last time a winner was paid from this vault"
            ],
            "type": "i64"
          },
          {
            "name": "active",
            "docs": [
              "Whether this jackpot is currently active"
            ],
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "platformConfig",
      "docs": [
        "Platform-level configuration: authority keys, fee rates, pause state.",
        "",
        "Singleton PDA: seeds = [b\"platform_config\"]"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "docs": [
              "The admin authority (can add games, update weights, pause)"
            ],
            "type": "pubkey"
          },
          {
            "name": "verifier",
            "docs": [
              "The verifier authority (can settle sessions)"
            ],
            "type": "pubkey"
          },
          {
            "name": "paused",
            "docs": [
              "Whether the contract is paused"
            ],
            "type": "bool"
          },
          {
            "name": "platformFeeBps",
            "docs": [
              "Fee rate for platform/treasury fee (in basis points, 1000 = 10%)"
            ],
            "type": "u16"
          },
          {
            "name": "jackpotFeeBps",
            "docs": [
              "Fee rate for jackpot contribution (in basis points, 8000 = 80%)"
            ],
            "type": "u16"
          },
          {
            "name": "referralFeeBps",
            "docs": [
              "Fee rate for referral rewards (in basis points, 500 = 5%)"
            ],
            "type": "u16"
          },
          {
            "name": "devFeeBps",
            "docs": [
              "Fee rate for dev/operations fund (in basis points, 500 = 5%)"
            ],
            "type": "u16"
          },
          {
            "name": "ticketPrice",
            "docs": [
              "Required ticket price in USDC base units (1_000_000 = 1 USDC)"
            ],
            "type": "u64"
          },
          {
            "name": "usdcMint",
            "docs": [
              "The USDC token mint address"
            ],
            "type": "pubkey"
          },
          {
            "name": "platformWallet",
            "docs": [
              "Platform/treasury fee wallet authority (receives 10% of ticket)"
            ],
            "type": "pubkey"
          },
          {
            "name": "devWallet",
            "docs": [
              "Dev/operations wallet authority (receives 5% of ticket)"
            ],
            "type": "pubkey"
          },
          {
            "name": "referralWallet",
            "docs": [
              "Referral wallet authority (receives 5% of ticket)"
            ],
            "type": "pubkey"
          },
          {
            "name": "jackpotVaultTokenAccount",
            "docs": [
              "The jackpot vault's USDC token account (receives 80% of ticket)"
            ],
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "ticket",
      "docs": [
        "A ticket PDA representing a purchased spin on the GAMEE wheel.",
        "",
        "Seeds: [b\"ticket\", buyer.key().as_ref(), ticket_nonce.as_le_bytes()]"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "buyer",
            "docs": [
              "The buyer / user who purchased this ticket"
            ],
            "type": "pubkey"
          },
          {
            "name": "nonce",
            "docs": [
              "Monotonically increasing nonce per buyer to derive unique PDA"
            ],
            "type": "u64"
          },
          {
            "name": "amountUsdc",
            "docs": [
              "Amount of USDC paid (in 10^6 lamports / USDC decimals)"
            ],
            "type": "u64"
          },
          {
            "name": "purchasedAt",
            "docs": [
              "Timestamp (unix seconds) when the ticket was purchased"
            ],
            "type": "i64"
          },
          {
            "name": "consumed",
            "docs": [
              "Whether the ticket has been consumed (used for a spin)"
            ],
            "type": "bool"
          },
          {
            "name": "gameSession",
            "docs": [
              "When consumed, the game session PDA that was created"
            ],
            "type": {
              "option": "pubkey"
            }
          }
        ]
      }
    },
    {
      "name": "verifierSet",
      "docs": [
        "Threshold-signature verifier set gating money-moving instructions",
        "(`settle_session`) and spin co-signing (`commit_spin`, 1-of-N membership",
        "only — see that instruction's doc comment for why quorum isn't required",
        "there).",
        "",
        "Singleton PDA: seeds = [b\"verifier_set\"]",
        "",
        "Invariants (enforced by `init_verifier_set` / `update_verifier_set`):",
        "1 <= threshold <= verifiers.len() <= 5, and no duplicate pubkeys."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "verifiers",
            "docs": [
              "Member verifier pubkeys (1..=5, no duplicates)."
            ],
            "type": {
              "vec": "pubkey"
            }
          },
          {
            "name": "threshold",
            "docs": [
              "Minimum number of distinct member signatures required to settle a",
              "session."
            ],
            "type": "u8"
          }
        ]
      }
    }
  ]
};
