package relay

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/coder/websocket"
)

// ExecuteMessage is the only command the relay can deliver.
type ExecuteMessage struct {
	Type       string `json:"type"`
	Envelope   string `json:"envelope"`
	DeadlineMs int64  `json:"deadlineMs"`
}

// Client is a guest-initiated relay connection. The sandbox accepts no inbound
// connections; everything here is outbound.
type Client struct {
	conn *websocket.Conn
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
			conn.SetReadLimit(2 * 1024 * 1024)
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

func (c *Client) Send(ctx context.Context, v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	writeCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	return c.conn.Write(writeCtx, websocket.MessageText, data)
}

func (c *Client) SendHello(ctx context.Context, evidence map[string]any) error {
	return c.Send(ctx, map[string]any{"type": "hello", "evidence": evidence})
}

// AwaitExecute blocks until the operator delivers the sealed payload or the
// context expires.
func (c *Client) AwaitExecute(ctx context.Context) (*ExecuteMessage, error) {
	for {
		typ, data, err := c.conn.Read(ctx)
		if err != nil {
			return nil, err
		}
		if typ != websocket.MessageText {
			continue
		}
		var msg ExecuteMessage
		if err := json.Unmarshal(data, &msg); err != nil {
			return nil, fmt.Errorf("invalid relay message: %w", err)
		}
		if msg.Type != "execute" {
			continue
		}
		if msg.Envelope == "" {
			return nil, fmt.Errorf("empty envelope")
		}
		return &msg, nil
	}
}

func (c *Client) SendResult(ctx context.Context, envelope string) error {
	return c.Send(ctx, map[string]any{
		"type":     "result",
		"envelope": envelope,
		"resultId": fmt.Sprintf("%d", time.Now().UnixNano()),
	})
}

func (c *Client) SendError(ctx context.Context, code, message string) error {
	return c.Send(ctx, map[string]any{"type": "error", "code": code, "message": message})
}

func (c *Client) Close() {
	_ = c.conn.Close(websocket.StatusNormalClosure, "guest finished")
}
