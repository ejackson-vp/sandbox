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
}

const (
	OpExec     = "exec"
	OpFilePut  = "file.put"
	OpFileGet  = "file.get"
	OpFileList = "file.list"
	OpFileStat = "file.stat"
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
