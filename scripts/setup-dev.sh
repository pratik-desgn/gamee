#!/bin/bash
# GAMEE Development Setup Script
# Run: source scripts/setup-dev.sh

set -e

echo "=== GAMEE Development Setup ==="
echo ""

# Check prerequisites
check_cmd() {
    if ! command -v "$1" &> /dev/null; then
        echo "❌ $1 is not installed. Please install it first."
        exit 1
    fi
    echo "✅ $1 found: $(command -v $1)"
}

echo "Checking prerequisites..."
check_cmd node
check_cmd npm
check_cmd cargo
check_cmd rustc
check_cmd go
check_cmd docker
check_cmd docker-compose

# Node version
NODE_VER=$(node -v)
echo "   Node: $NODE_VER"

# Rust version
RUST_VER=$(rustc --version)
echo "   Rust: $RUST_VER"

# Go version
GO_VER=$(go version)
echo "   Go: $GO_VER"

echo ""
echo "=== Setting up environment ==="

# Copy .env.example if it doesn't exist
if [ ! -f .env ]; then
    cp .env.example .env 2>/dev/null || cat > .env << 'EOF'
DB_PASSWORD=gamee_dev_pass
JWT_SECRET=dev-jwt-secret-change-in-production
SOLANA_RPC_URL=https://api.devnet.solana.com
GOOGLE_APPLICATION_CREDENTIALS=
NEXT_PUBLIC_API_URL=http://localhost:8080
MODE=development
EOF
    echo "✅ Created .env file with development defaults"
else
    echo "✅ .env already exists"
fi

# Create secrets directory
mkdir -p secrets
if [ ! -f secrets/verifier-keypair.json ]; then
    echo '{"keypair": [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32]}' > secrets/verifier-keypair.json
    echo "⚠️ Created dummy verifier key. Replace with a real key for production."
fi

echo ""
echo "=== Installing dependencies ==="

# Game SDK
echo "Installing game SDK dependencies..."
cd games
npm install
cd ..

# Backend
echo "Installing Go dependencies..."
cd backend
go mod download
cd ..

echo ""
echo "=== Starting development environment ==="
echo "Run the following commands in separate terminals:"
echo ""
echo "  Terminal 1: docker-compose up postgres redis"
echo "  Terminal 2: cd backend && go run ./cmd/server"
echo "  Terminal 3: cd games && npm run dev"
echo "  Terminal 4: cd frontend && npm run dev"
echo ""
echo "Or run everything with: docker-compose up"
echo ""
echo "=== Setup complete! ==="
