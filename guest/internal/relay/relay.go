package relay

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	neturl "net/url"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/x402s/sandbox/guest/internal/protocol"
)

// StatusError is a refused WebSocket handshake. The relay answers 401 for a
// token it does not recognise, 404 for a session it has no registration for,
// 409 for a duplicate connection and 421 for a request that reached the wrong
// shard. Only 401 is permanent: the session identity cannot become valid again,
// so the supervisor exits instead of retrying until the lease ends. The others
// are transient (the controller re-registers, a stale socket goes away, a
// retry can land on the right replica) and the reconnect loop keeps trying.
type StatusError struct {
	Status int
}

func (e *StatusError) Error() string {
	return fmt.Sprintf("relay refused the connection with HTTP %d", e.Status)
}

// Permanent reports whether retrying the same dial cannot succeed.
func (e *StatusError) Permanent() bool {
	return e.Status == http.StatusUnauthorized
}

// ProtocolVersion is the relay frame protocol this build speaks. Keep it in
// sync with GUEST_PROTOCOL_VERSION in shared/src/protocol/relay.ts.
const ProtocolVersion = 1

// Capabilities are the operation verbs this guest dispatches in
// supervisor.handleRequest. They are advertised on hello so the controller can
// see what a session implements without probing it. Add a verb here when (and
// only when) the supervisor gains a case for it.
var Capabilities = []string{
	protocol.OpExec,
	protocol.OpFilePut,
	protocol.OpFileGet,
	protocol.OpFileList,
	protocol.OpFileStat,
	protocol.OpServiceStart,
	protocol.OpServiceStop,
	protocol.OpServiceList,
	protocol.OpHTTP,
	protocol.OpHTTPOpen,
	protocol.OpHTTPRead,
	protocol.OpHTTPClose,
	protocol.OpWSOpen,
	protocol.OpWSRead,
	protocol.OpWSSend,
	protocol.OpWSClose,
	protocol.OpTransferInit,
	protocol.OpTransferChunk,
	protocol.OpTransferComplete,
	protocol.OpTransferStatus,
	protocol.OpTransferRead,
	protocol.OpTransferCancel,
}

// Frame is the relay's control-plane envelope. Exactly one of the fields is
// meaningful per type:
//
//	inbound:  request {id,envelope,deadlineMs,epoch} | cancel {id} | shutdown {reason} | claim {claim}
type Frame struct {
	Type       string `json:"type"`
	ID         string `json:"id"`
	Envelope   string `json:"envelope"`
	DeadlineMs int64  `json:"deadlineMs"`
	// Epoch is the controller's execution-epoch fence on a request. Frames from
	// a generation older than the guest's high-water mark are rejected.
	Epoch  int64  `json:"epoch"`
	Reason string `json:"reason"`
	Claim  *Claim `json:"claim,omitempty"`
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
	Runtime           string `json:"runtime,omitempty"`
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

// DialOnce connects once. A non-101 handshake is a *StatusError, so a caller can
// tell a permanent authentication rejection from a relay that is still starting
// or a session the controller has not re-registered yet.
func DialOnce(ctx context.Context, rawURL string) (*Client, error) {
	conn, resp, err := dialValidated(ctx, rawURL)
	if err != nil {
		if resp != nil && resp.StatusCode != http.StatusSwitchingProtocols {
			return nil, &StatusError{Status: resp.StatusCode}
		}
		return nil, err
	}
	conn.SetReadLimit(24 * 1024 * 1024)
	return &Client{conn: conn}, nil
}

// dialValidated checks the endpoint before opening a socket. The value comes
// from the signed claim/bootstrap, never from a customer operation, but pinning
// the scheme and requiring a host keeps the network target a relay URL even if
// a future caller passes something else. CodeQL flags the websocket sink as
// request forgery; the lgtm annotation records why this is not a user-controlled
// destination.
func dialValidated(ctx context.Context, rawURL string) (*websocket.Conn, *http.Response, error) {
	parsed, err := neturl.Parse(rawURL)
	if err != nil {
		return nil, nil, fmt.Errorf("relay url: %w", err)
	}
	if (parsed.Scheme != "ws" && parsed.Scheme != "wss") || parsed.Host == "" {
		return nil, nil, fmt.Errorf("relay url must be ws or wss with a host")
	}
	// lgtm[go/request-forgery]
	return websocket.Dial(ctx, parsed.String(), &websocket.DialOptions{
		CompressionMode: websocket.CompressionDisabled,
	})
}

// Dial connects with bounded retries (the relay may still be starting). It is
// used for the first connection only; a reconnect after link loss has its own
// backoff loop in the supervisor because it must stop at the lease deadline.
func Dial(ctx context.Context, url string, maxWait time.Duration) (*Client, error) {
	deadline := time.Now().Add(maxWait)
	var lastErr error
	backoff := 250 * time.Millisecond
	for time.Now().Before(deadline) {
		dialCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		client, err := DialOnce(dialCtx, url)
		cancel()
		if err == nil {
			return client, nil
		}
		var statusErr *StatusError
		if errors.As(err, &statusErr) && statusErr.Permanent() {
			return nil, err
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

// helloFrame is the handshake payload. Version and capabilities are optional on
// the wire (a guest built before them omits them), so sending them is additive:
// an older relay ignores the extra fields.
func helloFrame(evidence map[string]any) map[string]any {
	return map[string]any{
		"type":            "hello",
		"protocolVersion": ProtocolVersion,
		"capabilities":    Capabilities,
		"evidence":        evidence,
	}
}

func (c *Client) SendHello(ctx context.Context, evidence map[string]any) error {
	return c.send(ctx, helloFrame(evidence))
}

func (c *Client) SendResponse(ctx context.Context, id, envelope string) error {
	return c.send(ctx, map[string]any{"type": "response", "id": id, "envelope": envelope})
}

func (c *Client) SendError(ctx context.Context, id, code, message string) error {
	return c.send(ctx, map[string]any{"type": "error", "id": id, "code": code, "message": message})
}

// SendStatus reports this guest's execution slot to the relay. The controller
// reads it back through the relay state endpoint to decide whether a fenced
// operation from a previous controller generation has finished.
func (c *Client) SendStatus(ctx context.Context, activeRequestID string, epoch int64) error {
	return c.send(ctx, map[string]any{
		"type":            "status",
		"activeRequestId": activeRequestID,
		"epoch":           epoch,
	})
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
