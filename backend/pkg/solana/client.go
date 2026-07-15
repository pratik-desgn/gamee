package solana

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Client wraps Solana JSON-RPC interactions.
type Client struct {
	rpcURL      string
	commitment  string
	httpClient  *http.Client
}

// NewClient creates a new Solana RPC client.
func NewClient(rpcURL, commitment string) *Client {
	return &Client{
		rpcURL:     rpcURL,
		commitment: commitment,
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
			Transport: &http.Transport{
				MaxIdleConns:        20,
				IdleConnTimeout:     30 * time.Second,
				DisableCompression:  false,
			},
		},
	}
}

// RPCRequest represents a JSON-RPC request.
type RPCRequest struct {
	JSONRPC string        `json:"jsonrpc"`
	ID      int           `json:"id"`
	Method  string        `json:"method"`
	Params  []interface{} `json:"params"`
}

// RPCResponse represents a JSON-RPC response.
type RPCResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      int             `json:"id"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *RPCError       `json:"error,omitempty"`
}

// RPCError represents a JSON-RPC error.
type RPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// AccountInfo represents a Solana account.
type AccountInfo struct {
	Lamports   int64  `json:"lamports"`
	Owner      string `json:"owner"`
	Executable bool   `json:"executable"`
	Data       []string `json:"data"`
}

// Transaction represents a Solana transaction.
type Transaction struct {
	Slot        int64  `json:"slot"`
	BlockTime   *int64 `json:"blockTime,omitempty"`
	Meta        *TransactionMeta `json:"meta,omitempty"`
}

// TransactionMeta contains transaction metadata.
type TransactionMeta struct {
	Err            interface{} `json:"err"`
	Fee            int64       `json:"fee"`
	PreBalances    []int64     `json:"preBalances"`
	PostBalances   []int64     `json:"postBalances"`
	LogMessages    []string    `json:"logMessages"`
}

// call sends a JSON-RPC request to the Solana node.
func (c *Client) call(ctx context.Context, method string, params []interface{}) (json.RawMessage, error) {
	req := RPCRequest{
		JSONRPC: "2.0",
		ID:      1,
		Method:  method,
		Params:  params,
	}

	body, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request: %w", err)
	}

	httpReq, err := http.NewRequestWithContext(ctx, "POST", c.rpcURL, strings.NewReader(string(body)))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("RPC call failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %w", err)
	}

	var rpcResp RPCResponse
	if err := json.Unmarshal(respBody, &rpcResp); err != nil {
		return nil, fmt.Errorf("failed to parse response: %w", err)
	}

	if rpcResp.Error != nil {
		return nil, fmt.Errorf("RPC error: code=%d message=%s", rpcResp.Error.Code, rpcResp.Error.Message)
	}

	return rpcResp.Result, nil
}

// GetBalance returns the lamport balance of an account.
func (c *Client) GetBalance(ctx context.Context, address string) (int64, error) {
	result, err := c.call(ctx, "getBalance", []interface{}{
		address,
		map[string]string{"commitment": c.commitment},
	})
	if err != nil {
		return 0, err
	}

	var balanceResp struct {
		Value int64 `json:"value"`
	}
	if err := json.Unmarshal(result, &balanceResp); err != nil {
		return 0, fmt.Errorf("failed to parse balance: %w", err)
	}

	return balanceResp.Value, nil
}

// GetTransaction fetches a transaction by signature.
func (c *Client) GetTransaction(ctx context.Context, signature string) (*Transaction, error) {
	result, err := c.call(ctx, "getTransaction", []interface{}{
		signature,
		map[string]string{"commitment": c.commitment, "encoding": "json"},
	})
	if err != nil {
		return nil, err
	}

	var tx Transaction
	if err := json.Unmarshal(result, &tx); err != nil {
		return nil, fmt.Errorf("failed to parse transaction: %w", err)
	}

	return &tx, nil
}

// GetTokenBalance returns the balance of an SPL token account.
func (c *Client) GetTokenBalance(ctx context.Context, tokenAccount string) (int64, error) {
	result, err := c.call(ctx, "getTokenAccountBalance", []interface{}{
		tokenAccount,
		map[string]string{"commitment": c.commitment},
	})
	if err != nil {
		return 0, err
	}

	var balanceResp struct {
		Value struct {
			Amount   string `json:"amount"`
			Decimals int    `json:"decimals"`
		} `json:"value"`
	}
	if err := json.Unmarshal(result, &balanceResp); err != nil {
		return 0, fmt.Errorf("failed to parse token balance: %w", err)
	}

	// Parse amount as int64 (assumes amount fits in int64).
	var amount int64
	if _, err := fmt.Sscanf(balanceResp.Value.Amount, "%d", &amount); err != nil {
		return 0, fmt.Errorf("failed to parse token amount: %w", err)
	}

	return amount, nil
}

// GetAccountData fetches an account's raw data bytes (base64-decoded).
// Returns (nil, nil) if the account doesn't exist (RPC returns a null value)
// rather than an error, since "account not yet created" is an expected,
// distinguishable state for callers (e.g. an uninitialized jackpot vault).
func (c *Client) GetAccountData(ctx context.Context, address string) ([]byte, error) {
	result, err := c.call(ctx, "getAccountInfo", []interface{}{
		address,
		map[string]string{"commitment": c.commitment, "encoding": "base64"},
	})
	if err != nil {
		return nil, err
	}

	var accResp struct {
		Value *AccountInfo `json:"value"`
	}
	if err := json.Unmarshal(result, &accResp); err != nil {
		return nil, fmt.Errorf("failed to parse account info: %w", err)
	}
	if accResp.Value == nil {
		return nil, nil
	}
	if len(accResp.Value.Data) == 0 {
		return nil, fmt.Errorf("account data missing from response")
	}

	data, err := base64.StdEncoding.DecodeString(accResp.Value.Data[0])
	if err != nil {
		return nil, fmt.Errorf("failed to decode base64 account data: %w", err)
	}
	return data, nil
}

// GetLatestBlockhash returns the latest blockhash.
func (c *Client) GetLatestBlockhash(ctx context.Context) (string, error) {
	result, err := c.call(ctx, "getLatestBlockhash", []interface{}{
		map[string]string{"commitment": c.commitment},
	})
	if err != nil {
		return "", err
	}

	var blockhashResp struct {
		Value struct {
			Blockhash string `json:"blockhash"`
		} `json:"value"`
	}
	if err := json.Unmarshal(result, &blockhashResp); err != nil {
		return "", fmt.Errorf("failed to parse blockhash: %w", err)
	}

	return blockhashResp.Value.Blockhash, nil
}

// SendTransaction submits a fully-signed, serialized transaction and
// returns its signature. skipPreflight controls whether the RPC node
// simulates the transaction before accepting it — useful to disable when
// intentionally testing against an as-yet-undeployed program during
// development, but should stay enabled (false) for real settlement.
func (c *Client) SendTransaction(ctx context.Context, rawTx []byte, skipPreflight bool) (string, error) {
	encoded := base64.StdEncoding.EncodeToString(rawTx)
	result, err := c.call(ctx, "sendTransaction", []interface{}{
		encoded,
		map[string]interface{}{
			"encoding":      "base64",
			"skipPreflight": skipPreflight,
			"preflightCommitment": c.commitment,
		},
	})
	if err != nil {
		return "", err
	}

	var sig string
	if err := json.Unmarshal(result, &sig); err != nil {
		return "", fmt.Errorf("failed to parse transaction signature: %w", err)
	}
	return sig, nil
}

// SignatureStatus reports the confirmation state of a submitted transaction.
type SignatureStatus struct {
	Slot               int64       `json:"slot"`
	Confirmations      *int        `json:"confirmations"`
	Err                interface{} `json:"err"`
	ConfirmationStatus string      `json:"confirmationStatus"`
}

// GetSignatureStatuses looks up the confirmation status of one or more
// transaction signatures. A nil entry in the returned slice means the
// signature is unknown to the node (not yet seen, or too old to track).
func (c *Client) GetSignatureStatuses(ctx context.Context, signatures []string) ([]*SignatureStatus, error) {
	result, err := c.call(ctx, "getSignatureStatuses", []interface{}{
		signatures,
		map[string]bool{"searchTransactionHistory": true},
	})
	if err != nil {
		return nil, err
	}

	var statusResp struct {
		Value []*SignatureStatus `json:"value"`
	}
	if err := json.Unmarshal(result, &statusResp); err != nil {
		return nil, fmt.Errorf("failed to parse signature statuses: %w", err)
	}
	return statusResp.Value, nil
}

// ConfirmTransaction polls getSignatureStatuses until the transaction
// reaches at least the given commitment level, fails on-chain, or the
// context is canceled/times out.
func (c *Client) ConfirmTransaction(ctx context.Context, signature string, pollInterval time.Duration) error {
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()

	for {
		statuses, err := c.GetSignatureStatuses(ctx, []string{signature})
		if err != nil {
			return fmt.Errorf("failed to poll signature status: %w", err)
		}
		if len(statuses) > 0 && statuses[0] != nil {
			st := statuses[0]
			if st.Err != nil {
				return fmt.Errorf("transaction failed on-chain: %v", st.Err)
			}
			if st.ConfirmationStatus == "confirmed" || st.ConfirmationStatus == "finalized" {
				return nil
			}
		}

		select {
		case <-ctx.Done():
			return fmt.Errorf("timed out waiting for confirmation of %s: %w", signature, ctx.Err())
		case <-ticker.C:
		}
	}
}

// SimulateResult is the outcome of simulating a transaction without
// submitting it to the network.
type SimulateResult struct {
	Err      interface{} `json:"err"`
	Logs     []string    `json:"logs"`
	UnitsConsumed *int   `json:"unitsConsumed,omitempty"`
}

// SimulateTransaction asks the RPC node to parse, signature-verify, and
// execute a transaction against current state without committing it. Useful
// for validating that a transaction is well-formed (correct account
// ordering, valid signatures) without needing the fee payer to hold real
// funds — an "insufficient funds" logic error in the result still proves
// the transaction was successfully decoded and signature-verified; a
// deserialization error would fail differently (in the RPC error field,
// not SimulateResult.Err).
func (c *Client) SimulateTransaction(ctx context.Context, rawTx []byte, sigVerify bool) (*SimulateResult, error) {
	encoded := base64.StdEncoding.EncodeToString(rawTx)
	result, err := c.call(ctx, "simulateTransaction", []interface{}{
		encoded,
		map[string]interface{}{
			"encoding":   "base64",
			"sigVerify":  sigVerify,
			"commitment": c.commitment,
		},
	})
	if err != nil {
		return nil, err
	}

	var simResp struct {
		Value SimulateResult `json:"value"`
	}
	if err := json.Unmarshal(result, &simResp); err != nil {
		return nil, fmt.Errorf("failed to parse simulation result: %w", err)
	}
	return &simResp.Value, nil
}

// GetSlot returns the current slot.
func (c *Client) GetSlot(ctx context.Context) (int64, error) {
	result, err := c.call(ctx, "getSlot", []interface{}{
		map[string]string{"commitment": c.commitment},
	})
	if err != nil {
		return 0, err
	}

	var slot int64
	if err := json.Unmarshal(result, &slot); err != nil {
		return 0, fmt.Errorf("failed to parse slot: %w", err)
	}

	return slot, nil
}

// GetSignaturesForAddress returns confirmed signatures for an address.
func (c *Client) GetSignaturesForAddress(ctx context.Context, address string, limit int) ([]map[string]interface{}, error) {
	result, err := c.call(ctx, "getSignaturesForAddress", []interface{}{
		address,
		map[string]int{"limit": limit},
	})
	if err != nil {
		return nil, err
	}

	var sigs []map[string]interface{}
	if err := json.Unmarshal(result, &sigs); err != nil {
		return nil, fmt.Errorf("failed to parse signatures: %w", err)
	}

	return sigs, nil
}

// GetProgramAccounts returns all accounts owned by a program.
func (c *Client) GetProgramAccounts(ctx context.Context, programID string) ([]map[string]interface{}, error) {
	result, err := c.call(ctx, "getProgramAccounts", []interface{}{
		programID,
		map[string]interface{}{
			"commitment": c.commitment,
			"encoding":   "base64",
		},
	})
	if err != nil {
		return nil, err
	}

	var accounts []map[string]interface{}
	if err := json.Unmarshal(result, &accounts); err != nil {
		return nil, fmt.Errorf("failed to parse program accounts: %w", err)
	}

	return accounts, nil
}
