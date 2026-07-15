package database

import (
	"context"
	"fmt"
	"log"

	"github.com/redis/go-redis/v9"
)

// NewRedisClient creates and returns a new Redis client.
func NewRedisClient(ctx context.Context, redisURL string, db int) (*redis.Client, error) {
	opts, err := redis.ParseURL(redisURL)
	if err != nil {
		return nil, fmt.Errorf("failed to parse Redis URL: %w", err)
	}

	opts.DB = db

	rdb := redis.NewClient(opts)

	// Verify connectivity.
	if err := rdb.Ping(ctx).Err(); err != nil {
		return nil, fmt.Errorf("failed to ping Redis: %w", err)
	}

	log.Printf("[database] Redis client established (db=%d, addr=%s)", db, opts.Addr)
	return rdb, nil
}
