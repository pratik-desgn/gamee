#!/bin/bash
# GAMEE Database Initialization Script
# Run against a fresh PostgreSQL instance to create all tables.

set -e

# Create extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─── Users ───
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    country VARCHAR(5),
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    last_active TIMESTAMPTZ,
    CONSTRAINT valid_status CHECK (status IN ('active', 'suspended', 'banned'))
);

-- ─── Wallets ───
CREATE TABLE IF NOT EXISTS wallets (
    address VARCHAR(44) PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id),
    first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    is_banned BOOLEAN NOT NULL DEFAULT FALSE,
    ban_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_wallets_user_id ON wallets(user_id);

-- ─── Tickets ───
CREATE TABLE IF NOT EXISTS tickets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_address VARCHAR(44) NOT NULL REFERENCES wallets(address),
    tx_signature VARCHAR(88) NOT NULL UNIQUE,
    purchased_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    consumed_at TIMESTAMPTZ,
    status VARCHAR(20) NOT NULL DEFAULT 'unused',
    on_chain_ticket_pda VARCHAR(44),
    amount_usdc BIGINT NOT NULL DEFAULT 1000000,
    tier VARCHAR(20) NOT NULL DEFAULT 'small',
    CONSTRAINT valid_ticket_status CHECK (status IN ('unused', 'consumed', 'expired')),
    CONSTRAINT valid_ticket_tier CHECK (tier IN ('small', 'medium', 'mega', 'legend'))
);
CREATE INDEX idx_tickets_wallet ON tickets(wallet_address);
CREATE INDEX idx_tickets_status ON tickets(status);

-- Upgrade path for dev DBs created before the column existed (idempotent).
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS tier VARCHAR(20) NOT NULL DEFAULT 'small';
DO $$ BEGIN
    ALTER TABLE tickets ADD CONSTRAINT valid_ticket_tier CHECK (tier IN ('small', 'medium', 'mega', 'legend'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── Games ───
CREATE TABLE IF NOT EXISTS games (
    id VARCHAR(32) PRIMARY KEY,
    name VARCHAR(64) NOT NULL,
    category VARCHAR(32) NOT NULL,
    description TEXT,
    base_difficulty INT NOT NULL DEFAULT 5,
    min_difficulty INT NOT NULL DEFAULT 1,
    max_difficulty INT NOT NULL DEFAULT 10,
    wheel_weight INT NOT NULL DEFAULT 5,
    avg_play_duration INT NOT NULL DEFAULT 60,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    sdk_version VARCHAR(10) NOT NULL DEFAULT '1.0.0',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_games_category ON games(category);

-- ─── Jackpots ───
CREATE TABLE IF NOT EXISTS jackpots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tier VARCHAR(20) NOT NULL,
    vault_address VARCHAR(44) NOT NULL UNIQUE,
    current_amount BIGINT NOT NULL DEFAULT 0,
    seeded_from UUID REFERENCES jackpots(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_won_at TIMESTAMPTZ,
    total_plays BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT valid_tier CHECK (tier IN ('small', 'medium', 'mega', 'legend'))
);

-- ─── Game Sessions ───
CREATE TABLE IF NOT EXISTS game_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id UUID NOT NULL REFERENCES tickets(id),
    user_id UUID NOT NULL REFERENCES users(id),
    game_id VARCHAR(32) NOT NULL REFERENCES games(id),
    vrf_request VARCHAR(88),
    vrf_result BIGINT,
    difficulty_params JSONB,
    seed VARCHAR(64),
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at TIMESTAMPTZ,
    result VARCHAR(20) NOT NULL DEFAULT 'pending',
    target_score INT,
    final_score INT,
    payout_tx VARCHAR(88),
    tier VARCHAR(20) NOT NULL DEFAULT 'small',
    CONSTRAINT valid_result CHECK (result IN ('pending', 'won', 'lost', 'rejected', 'review_hold')),
    CONSTRAINT valid_session_tier CHECK (tier IN ('small', 'medium', 'mega', 'legend'))
);
CREATE INDEX idx_sessions_user ON game_sessions(user_id);
CREATE INDEX idx_sessions_result ON game_sessions(result);
CREATE INDEX idx_sessions_gamet ON game_sessions(game_id);

-- Upgrade path for dev DBs created before the column existed (idempotent).
ALTER TABLE game_sessions ADD COLUMN IF NOT EXISTS tier VARCHAR(20) NOT NULL DEFAULT 'small';
DO $$ BEGIN
    ALTER TABLE game_sessions ADD CONSTRAINT valid_session_tier CHECK (tier IN ('small', 'medium', 'mega', 'legend'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── Payout Reviews ───
-- A winning session whose payout exceeds PayoutReviewService's threshold is
-- held (game_sessions.result = 'review_hold') instead of auto-paid. Staff
-- must approve (session goes back to 'pending' for the settlement worker to
-- pick up normally) or reject (session becomes 'rejected', never paid).
CREATE TABLE IF NOT EXISTS payout_reviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL UNIQUE REFERENCES game_sessions(id),
    wallet_address VARCHAR(44) NOT NULL,
    game_id VARCHAR(32) NOT NULL REFERENCES games(id),
    payout_estimate BIGINT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    reviewed_by VARCHAR(64),
    reviewed_at TIMESTAMPTZ,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT valid_review_status CHECK (status IN ('pending', 'approved', 'rejected'))
);
CREATE INDEX idx_payout_reviews_status ON payout_reviews(status);

-- ─── Replays ───
CREATE TABLE IF NOT EXISTS replays (
    session_id UUID PRIMARY KEY REFERENCES game_sessions(id),
    input_log JSONB NOT NULL,
    client_score INT NOT NULL DEFAULT 0,
    verified_score INT NOT NULL DEFAULT 0,
    -- The sim's own win verdict from the replay (each game's internal rules).
    -- Authoritative for settlement; verified_score is kept for anti-cheat
    -- score-match checks and display only.
    won BOOLEAN NOT NULL DEFAULT FALSE,
    verdict VARCHAR(20) NOT NULL,
    verifier_version VARCHAR(20) NOT NULL,
    verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    duration_ms INT NOT NULL DEFAULT 0,
    -- 'pending' = queued/not yet run; 'match'/'mismatch'/'suspicious' = score comparison;
    -- 'unverified' = sim unavailable; 'timeout' = replay too long; 'rejected' = anti-cheat.
    CONSTRAINT valid_verdict CHECK (verdict IN (
        'pending', 'match', 'mismatch', 'suspicious', 'unverified', 'timeout', 'rejected'
    ))
);

-- Upgrade path for dev DBs created before the column existed (idempotent).
ALTER TABLE replays ADD COLUMN IF NOT EXISTS won BOOLEAN NOT NULL DEFAULT FALSE;

-- ─── Transactions ───
CREATE TABLE IF NOT EXISTS transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_address VARCHAR(44) NOT NULL REFERENCES wallets(address),
    type VARCHAR(20) NOT NULL,
    amount BIGINT NOT NULL,
    tx_signature VARCHAR(88),
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT valid_tx_type CHECK (type IN ('ticket_purchase', 'payout', 'referral', 'refund')),
    CONSTRAINT valid_tx_status CHECK (status IN ('confirmed', 'failed', 'pending'))
);
CREATE INDEX idx_transactions_wallet ON transactions(wallet_address);
CREATE INDEX idx_transactions_type ON transactions(type);

-- ─── Referrals ───
CREATE TABLE IF NOT EXISTS referrals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    referrer_wallet VARCHAR(44) NOT NULL REFERENCES wallets(address),
    referee_wallet VARCHAR(44) NOT NULL UNIQUE REFERENCES wallets(address),
    pct INT NOT NULL DEFAULT 2,
    cap_games INT DEFAULT 100,
    earned_total BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_referrals_referrer ON referrals(referrer_wallet);

-- ─── Achievements ───
CREATE TABLE IF NOT EXISTS achievements (
    id VARCHAR(32) PRIMARY KEY,
    name VARCHAR(64) NOT NULL,
    description TEXT,
    icon_url VARCHAR(256),
    criteria JSONB
);

CREATE TABLE IF NOT EXISTS user_achievements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    achievement_id VARCHAR(32) NOT NULL REFERENCES achievements(id),
    unlocked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, achievement_id)
);
CREATE INDEX idx_user_achievements_user ON user_achievements(user_id);

-- ─── Cheat Flags ───
CREATE TABLE IF NOT EXISTS cheat_flags (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_address VARCHAR(44) NOT NULL REFERENCES wallets(address),
    session_id UUID NOT NULL REFERENCES game_sessions(id),
    rule_triggered VARCHAR(64) NOT NULL,
    severity VARCHAR(16) NOT NULL,
    action_taken VARCHAR(64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT valid_severity CHECK (severity IN ('low', 'medium', 'high', 'critical'))
);
CREATE INDEX idx_cheat_flags_wallet ON cheat_flags(wallet_address);
CREATE INDEX idx_cheat_flags_severity ON cheat_flags(severity);

-- ─── Daily Stats ───
CREATE TABLE IF NOT EXISTS daily_stats (
    date DATE PRIMARY KEY,
    plays BIGINT NOT NULL DEFAULT 0,
    unique_players BIGINT NOT NULL DEFAULT 0,
    revenue BIGINT NOT NULL DEFAULT 0,
    jackpot_delta BIGINT NOT NULL DEFAULT 0,
    winners INT NOT NULL DEFAULT 0,
    avg_difficulty FLOAT NOT NULL DEFAULT 0
);

-- ─── Nonces (auth) ───
CREATE TABLE IF NOT EXISTS auth_nonces (
    wallet_address VARCHAR(44) NOT NULL,
    nonce VARCHAR(64) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (wallet_address, nonce)
);
CREATE INDEX idx_nonces_expires ON auth_nonces(expires_at);

-- ─── Seed Data: Launch Games (10 games, wave 1) ───
INSERT INTO games (id, name, category, base_difficulty, min_difficulty, max_difficulty, wheel_weight, avg_play_duration, sdk_version)
VALUES
    -- base_difficulty starts near the hard end on purpose: the average
    -- jackpot payout target is 1,000-2,000 USDC, which needs a per-play win
    -- rate around 1-in-1300 to 1-in-2600 (avg win ~= 0.95 * 0.8 * plays-per-
    -- win * $1). The difficulty governor (backend/internal/difficulty)
    -- adjusts these live within [min,max] from observed verified win rates.
    ('wing-rush',     'Wing Rush',     'precision', 6, 1, 10, 8,  45,  '1.0.0'),
    ('dino-sprint',   'Dino Sprint',   'endless',   6, 1, 8,  7,  60,  '1.0.0'),
    ('block-merge',   'Block Merge',   'puzzle',    7, 2, 10, 5,  120, '1.0.0'),
    ('simon-pro',     'Simon Pro',     'memory',    7, 2, 9,  4,  90,  '1.0.0'),
    ('aim-master',    'Aim Master',    'reflex',    7, 1, 9,  4,  45,  '1.0.0'),
    ('perfect-stack', 'Perfect Stack', 'precision', 6, 1, 8,  7,  45,  '1.0.0'),
    ('reaction-test', 'Reaction Test', 'reflex',    6, 1, 7,  6,  30,  '1.0.0'),
    ('helix-drop',    'Helix Drop',    'precision', 8, 3, 10, 3,  75,  '1.0.0'),
    ('minefield',     'Minefield',     'luck-skill',8, 4, 10, 2,  90,  '1.0.0'),
    ('sliding-puzzle','Sliding Puzzle','puzzle',    7, 2, 9,  4,  90,  '1.0.0')
ON CONFLICT (id) DO NOTHING;

-- ─── Seed Jackpots ───
INSERT INTO jackpots (tier, vault_address, current_amount)
VALUES
    ('small',  'SmallVault11111111111111111111111111111',  50000000),
    ('medium', 'MediumVault1111111111111111111111111111',  0),
    ('mega',   'MegaVault111111111111111111111111111111',  0),
    ('legend', 'LegendVault1111111111111111111111111111',  0)
ON CONFLICT (vault_address) DO NOTHING;

-- ─── Seed Achievements ───
INSERT INTO achievements (id, name, description, criteria)
VALUES
    ('first-game',     'First Steps',      'Play your first game',             '{"type":"games_played","count":1}'),
    ('century',        'Century Club',     'Play 100 games',                   '{"type":"games_played","count":100}'),
    ('five-hundred',   'Dedicated',        'Play 500 games',                   '{"type":"games_played","count":500}'),
    ('first-win',      'First Victory',    'Win your first jackpot',           '{"type":"wins","count":1}'),
    ('win-streak-3',   'On Fire',          'Win 3 games in a row',             '{"type":"win_streak","count":3}'),
    ('close-call',     'So Close!',        'Lose by 1 point or less',          '{"type":"close_calls","count":1}'),
    ('perfect-score',  'Perfectionist',    'Achieve a perfect score',          '{"type":"perfect_scores","count":1}'),
    ('wing-rush-pro',  'Wing Rush Pro',    'Score 300+ in Wing Rush',          '{"type":"game_score","game":"wing-rush","score":300}'),
    ('referral-king',  'Referral King',    'Refer 10 friends',                 '{"type":"referrals","count":10}'),
    ('legend-status',  'Legend Status',    'Win the Legend jackpot',           '{"type":"jackpot_tier","tier":"legend"}')
ON CONFLICT (id) DO NOTHING;

-- ─── Materialized View: Leaderboard (All-Time) ───
CREATE MATERIALIZED VIEW IF NOT EXISTS leaderboard_alltime AS
SELECT
    u.id AS user_id,
    w.address AS wallet,
    COUNT(gs.id) AS games_played,
    COUNT(CASE WHEN gs.result = 'won' THEN 1 END) AS wins,
    COALESCE(SUM(CASE WHEN gs.result = 'won' THEN 1 ELSE 0 END), 0) AS total_score,
    ROUND(COUNT(CASE WHEN gs.result = 'won' THEN 1 END)::NUMERIC / NULLIF(COUNT(gs.id), 0) * 100, 2) AS win_rate
FROM users u
JOIN wallets w ON w.user_id = u.id
LEFT JOIN game_sessions gs ON gs.user_id = u.id
GROUP BY u.id, w.address
ORDER BY total_score DESC;

CREATE UNIQUE INDEX IF NOT EXISTS idx_leaderboard_alltime_user ON leaderboard_alltime(user_id);

-- ─── Materialized View: Leaderboard (Daily) ───
CREATE MATERIALIZED VIEW IF NOT EXISTS leaderboard_daily AS
SELECT
    u.id AS user_id,
    w.address AS wallet,
    COUNT(gs.id) AS games_played,
    COUNT(CASE WHEN gs.result = 'won' THEN 1 END) AS wins,
    COALESCE(SUM(CASE WHEN gs.result = 'won' THEN 1 ELSE 0 END), 0) AS total_score,
    ROUND(COUNT(CASE WHEN gs.result = 'won' THEN 1 END)::NUMERIC / NULLIF(COUNT(gs.id), 0) * 100, 2) AS win_rate
FROM users u
JOIN wallets w ON w.user_id = u.id
LEFT JOIN game_sessions gs ON gs.user_id = u.id
    AND gs.started_at >= CURRENT_DATE
GROUP BY u.id, w.address
ORDER BY total_score DESC;

CREATE UNIQUE INDEX IF NOT EXISTS idx_leaderboard_daily_user ON leaderboard_daily(user_id);

-- ─── Materialized View: Leaderboard (Weekly) ───
CREATE MATERIALIZED VIEW IF NOT EXISTS leaderboard_weekly AS
SELECT
    u.id AS user_id,
    w.address AS wallet,
    COUNT(gs.id) AS games_played,
    COUNT(CASE WHEN gs.result = 'won' THEN 1 END) AS wins,
    COALESCE(SUM(CASE WHEN gs.result = 'won' THEN 1 ELSE 0 END), 0) AS total_score,
    ROUND(COUNT(CASE WHEN gs.result = 'won' THEN 1 END)::NUMERIC / NULLIF(COUNT(gs.id), 0) * 100, 2) AS win_rate
FROM users u
JOIN wallets w ON w.user_id = u.id
LEFT JOIN game_sessions gs ON gs.user_id = u.id
    AND gs.started_at >= DATE_TRUNC('week', CURRENT_DATE)
GROUP BY u.id, w.address
ORDER BY total_score DESC;

CREATE UNIQUE INDEX IF NOT EXISTS idx_leaderboard_weekly_user ON leaderboard_weekly(user_id);

-- ─── Materialized View: Leaderboard (Monthly) ───
CREATE MATERIALIZED VIEW IF NOT EXISTS leaderboard_monthly AS
SELECT
    u.id AS user_id,
    w.address AS wallet,
    COUNT(gs.id) AS games_played,
    COUNT(CASE WHEN gs.result = 'won' THEN 1 END) AS wins,
    COALESCE(SUM(CASE WHEN gs.result = 'won' THEN 1 ELSE 0 END), 0) AS total_score,
    ROUND(COUNT(CASE WHEN gs.result = 'won' THEN 1 END)::NUMERIC / NULLIF(COUNT(gs.id), 0) * 100, 2) AS win_rate
FROM users u
JOIN wallets w ON w.user_id = u.id
LEFT JOIN game_sessions gs ON gs.user_id = u.id
    AND gs.started_at >= DATE_TRUNC('month', CURRENT_DATE)
GROUP BY u.id, w.address
ORDER BY total_score DESC;

CREATE UNIQUE INDEX IF NOT EXISTS idx_leaderboard_monthly_user ON leaderboard_monthly(user_id);

-- ─── Materialized View: Leaderboard (By Country) ───
-- A single view with a `country` column, filtered with a bound WHERE clause
-- at query time, instead of one materialized view per country. This avoids
-- ever interpolating a country code into a SQL identifier.
CREATE MATERIALIZED VIEW IF NOT EXISTS leaderboard_country AS
SELECT
    u.id AS user_id,
    w.address AS wallet,
    u.country AS country,
    COUNT(gs.id) AS games_played,
    COUNT(CASE WHEN gs.result = 'won' THEN 1 END) AS wins,
    COALESCE(SUM(CASE WHEN gs.result = 'won' THEN 1 ELSE 0 END), 0) AS total_score,
    ROUND(COUNT(CASE WHEN gs.result = 'won' THEN 1 END)::NUMERIC / NULLIF(COUNT(gs.id), 0) * 100, 2) AS win_rate
FROM users u
JOIN wallets w ON w.user_id = u.id
LEFT JOIN game_sessions gs ON gs.user_id = u.id
WHERE u.country IS NOT NULL
GROUP BY u.id, w.address, u.country
ORDER BY total_score DESC;

CREATE INDEX IF NOT EXISTS idx_leaderboard_country_country ON leaderboard_country(country);
CREATE UNIQUE INDEX IF NOT EXISTS idx_leaderboard_country_user ON leaderboard_country(user_id);

-- ─── Function: Refresh Leaderboards ───
CREATE OR REPLACE FUNCTION refresh_leaderboards()
RETURNS void AS $$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY leaderboard_alltime;
    REFRESH MATERIALIZED VIEW CONCURRENTLY leaderboard_daily;
    REFRESH MATERIALIZED VIEW CONCURRENTLY leaderboard_weekly;
    REFRESH MATERIALIZED VIEW CONCURRENTLY leaderboard_monthly;
    REFRESH MATERIALIZED VIEW CONCURRENTLY leaderboard_country;
END;
$$ LANGUAGE plpgsql;
