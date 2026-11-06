package relay

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// Frame is the relay's control-plane envelope. Exactly one of the fields is
// meaningful per type:
//
//	inbound:  request {id,envelope,deadlineMs} | cancel {id} | shutdown {reason} | claim {claim}
type Frame struct {
	Type       string `json:"type"`
	ID         string `json:"id"`
	Envelope   string `json:"envelope"`
	DeadlineMs int64  `json:"deadlineMs"`
	Reason     string `json:"reason"`
	Claim      *Claim `json:"claim,omitempty"`
}

// Claim is the session identity handed to a warm guest. It is only valid on a
// pooled relay entry; the guest drops that connection and reconnects with
// GuestToken before it sends any session evidence.
type Claim struct {
	SessionID         string `json:"sessionId"`
	RelayURL          string `json:"relayUrl"`
	GuestToken        string `json:"guestToken"`
	ClientPublicKey   string `json:"clientPublicKey"`
	ClientNonce       string `json:"clientNonce"`
	LeaseSeconds      int64  `json:"leaseSeconds"`
	ExecutionMode     string `json:"executionMode"`
	RuntimeClass      string `json:"runtimeClass"`
	ImageDigest       string `json:"imageDigest"`
	ProxyURL          string `json:"proxyUrl"`
	ProxyToken        string `json:"proxyToken"`
	MaxOutputBytes    int    `json:"maxOutputBytes"`
	MaxFileBytes      int64  `json:"maxFileBytes"`
	MaxDiskMiB        int64  `json:"maxDiskMiB"`
	MaxCommandSeconds int    `json:"maxCommandSeconds"`
	MaxProcesses      int    `json:"maxProcesses"`
	Tools             string `json:"tools"`
}

type Client struct {
	conn *websocket.Conn
	mu   sync.Mutex
}

// Dial connects with bounded retries (the relay may still be starting).
func Dial(ctx context.Context, url string, maxWait time.Duration) (*Client, error) {
	deadline := time.Now().Add(maxWait)
	var lastErr error
	backoff := 250 * time.Millisecond
	for time.Now().Before(deadline) {
		dialCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		conn, _, err := websocket.Dial(dialCtx, url, &websocket.DialOptions{
			CompressionMode: websocket.CompressionDisabled,
		})
		cancel()
		if err == nil {
			conn.SetReadLimit(24 * 1024 * 1024)
			return &Client{conn: conn}, nil
		}
		lastErr = err
		select {
		case <-time.After(backoff):
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		if backoff < 4*time.Second {
			backoff *= 2
		}
	}
	return nil, fmt.Errorf("relay connection failed: %w", lastErr)
}

func (c *Client) send(ctx context.Context, v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	writeCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.conn.Write(writeCtx, websocket.MessageText, data)
}

func (c *Client) SendHello(ctx context.Context, evidence map[string]any) error {
	return c.send(ctx, map[string]any{"type": "hello", "evidence": evidence})
}

func (c *Client) SendResponse(ctx context.Context, id, envelope string) error {
	return c.send(ctx, map[string]any{"type": "response", "id": id, "envelope": envelope})
}

func (c *Client) SendError(ctx context.Context, id, code, message string) error {
	return c.send(ctx, map[string]any{"type": "error", "id": id, "code": code, "message": message})
}

// Read returns the next control frame.
func (c *Client) Read(ctx context.Context) (*Frame, error) {
	for {
		typ, data, err := c.conn.Read(ctx)
		if err != nil {
			return nil, err
		}
		if typ != websocket.MessageText {
			continue
		}
		var frame Frame
		if err := json.Unmarshal(data, &frame); err != nil {
			return nil, fmt.Errorf("invalid relay frame: %w", err)
		}
		if frame.Type == "" {
			return nil, fmt.Errorf("relay frame missing type")
		}
		return &frame, nil
	}
}

func (c *Client) Close() {
	_ = c.conn.Close(websocket.StatusNormalClosure, "guest finished")
}
