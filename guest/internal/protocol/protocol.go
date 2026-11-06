// Package protocol mirrors shared/src/protocol.ts for the guest runtime.
// Keep the JSON field names in sync; the envelope is signed/encrypted, so a
// mismatch fails closed (binding validation rejects it).
package protocol

type Request struct {
	V           int               `json:"v"`
	SessionID   string            `json:"sessionId"`
	ClientNonce string            `json:"clientNonce"`
	RequestID   string            `json:"requestId"`
	Op          string            `json:"op"`
	Command     []string          `json:"command"`
	Env         map[string]string `json:"env"`
	Cwd         string            `json:"cwd"`
	Stdin       string            `json:"stdin"`
	TimeoutMs   int64             `json:"timeoutMs"`
	Path        string            `json:"path"`
	DataBase64  string            `json:"dataBase64"`
	Archive     bool              `json:"archive"`
	Mode        int               `json:"mode"`
	Recursive   bool              `json:"recursive"`

	// service.start / service.stop
	Name string `json:"name"`
	Port int    `json:"port"`
	// http.request
	Method     string            `json:"method"`
	Headers    map[string]string `json:"headers"`
	BodyBase64 string            `json:"bodyBase64"`
	StreamID   string            `json:"streamId"`
}

type OpError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type FileEntry struct {
	Path    string `json:"path"`
	Size    int64  `json:"size"`
	Mode    uint32 `json:"mode"`
	IsDir   bool   `json:"isDir"`
	MtimeMs int64  `json:"mtimeMs"`
}

type Truncated struct {
	Stdout bool `json:"stdout"`
	Stderr bool `json:"stderr"`
}

// Result is a superset of every response shape. Unused fields are omitted.
type Result struct {
	V           int      `json:"v"`
	SessionID   string   `json:"sessionId"`
	ClientNonce string   `json:"clientNonce"`
	RequestID   string   `json:"requestId"`
	Op          string   `json:"op"`
	OK          bool     `json:"ok"`
	Error       *OpError `json:"error,omitempty"`

	ExitCode   int       `json:"exitCode"`
	Stdout     string    `json:"stdout"`
	Stderr     string    `json:"stderr"`
	TimedOut   bool      `json:"timedOut"`
	Cancelled  bool      `json:"cancelled"`
	DurationMs int64     `json:"durationMs"`
	Truncated  Truncated `json:"truncated"`

	Path         string      `json:"path"`
	DataBase64   string      `json:"dataBase64"`
	Size         int64       `json:"size"`
	BytesWritten int64       `json:"bytesWritten"`
	FilesWritten int         `json:"filesWritten"`
	Archive      bool        `json:"archive"`
	Entries      []FileEntry `json:"entries"`
	TotalBytes   int64       `json:"totalBytes"`
	Entry        *FileEntry  `json:"entry"`

	// service.* / http.request
	Service       *ServiceInfo      `json:"service,omitempty"`
	Services      []ServiceInfo     `json:"services,omitempty"`
	Status        int               `json:"status,omitempty"`
	Headers       map[string]string `json:"headers,omitempty"`
	BodyBase64    string            `json:"bodyBase64,omitempty"`
	BodyTruncated bool              `json:"truncated,omitempty"`
	StreamID      string            `json:"streamId,omitempty"`
	ChunkBase64   string            `json:"chunkBase64,omitempty"`
	Pending       bool              `json:"pending,omitempty"`
	Done          bool              `json:"done,omitempty"`
}

type ServiceInfo struct {
	Name      string `json:"name"`
	Port      int    `json:"port"`
	PID       int    `json:"pid"`
	State     string `json:"state"`
	StartedAt int64  `json:"startedAt"`
	ExitCode  int    `json:"exitCode,omitempty"`
	Stdout    string `json:"stdout,omitempty"`
	Stderr    string `json:"stderr,omitempty"`
}

const (
	OpExec     = "exec"
	OpFilePut  = "file.put"
	OpFileGet  = "file.get"
	OpFileList = "file.list"
	OpFileStat = "file.stat"

	OpServiceStart = "service.start"
	OpServiceStop  = "service.stop"
	OpServiceList  = "service.list"
	OpHTTP         = "http.request"
	OpHTTPOpen     = "http.stream.open"
	OpHTTPRead     = "http.stream.read"
	OpHTTPClose    = "http.stream.close"
)

func ErrorResult(req *Request, code, message string) *Result {
	return &Result{
		V:           2,
		SessionID:   req.SessionID,
		ClientNonce: req.ClientNonce,
		RequestID:   req.RequestID,
		Op:          req.Op,
		OK:          false,
		Error:       &OpError{Code: code, Message: message},
	}
}
