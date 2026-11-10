// Package canonical implements the deterministic JSON encoding used for
// attestation signatures. It must byte-for-byte match the TypeScript
// `canonicalJson` implementation: sorted object keys (UTF-16 code unit order,
// as JS compares them), no whitespace, no HTML escaping, UTF-8 strings, and
// ECMAScript number formatting.
package canonical

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strconv"
)

// Marshal returns the canonical JSON encoding of v.
func Marshal(v any) ([]byte, error) {
	var buf bytes.Buffer
	if err := write(&buf, v); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func write(buf *bytes.Buffer, v any) error {
	switch t := v.(type) {
	case nil:
		buf.WriteString("null")
		return nil
	case bool:
		if t {
			buf.WriteString("true")
		} else {
			buf.WriteString("false")
		}
		return nil
	case string:
		b, err := marshalString(t)
		if err != nil {
			return err
		}
		buf.Write(b)
		return nil
	case int:
		buf.WriteString(strconv.FormatInt(int64(t), 10))
		return nil
	case int32:
		buf.WriteString(strconv.FormatInt(int64(t), 10))
		return nil
	case int64:
		buf.WriteString(strconv.FormatInt(t, 10))
		return nil
	case uint64:
		buf.WriteString(strconv.FormatUint(t, 10))
		return nil
	case float64:
		// Always the ECMAScript form: the old integer fast path printed the
		// wrong digits outside int64 and %g disagreed with JSON.stringify on
		// both exponent thresholds.
		buf.WriteString(formatNumber(t))
		return nil
	case []any:
		buf.WriteByte('[')
		for i, item := range t {
			if i > 0 {
				buf.WriteByte(',')
			}
			if err := write(buf, item); err != nil {
				return err
			}
		}
		buf.WriteByte(']')
		return nil
	case []string:
		buf.WriteByte('[')
		for i, item := range t {
			if i > 0 {
				buf.WriteByte(',')
			}
			if err := write(buf, item); err != nil {
				return err
			}
		}
		buf.WriteByte(']')
		return nil
	case map[string]any:
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		sortKeys(keys)
		buf.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				buf.WriteByte(',')
			}
			kb, err := marshalString(k)
			if err != nil {
				return err
			}
			buf.Write(kb)
			buf.WriteByte(':')
			if err := write(buf, t[k]); err != nil {
				return err
			}
		}
		buf.WriteByte('}')
		return nil
	case map[string]string:
		m := make(map[string]any, len(t))
		for k, v2 := range t {
			m[k] = v2
		}
		return write(buf, m)
	default:
		return fmt.Errorf("canonical: unsupported type %T", v)
	}
}

func marshalString(s string) ([]byte, error) {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(s); err != nil {
		return nil, err
	}
	out := b.Bytes()
	// json.Encoder appends a newline.
	if len(out) > 0 && out[len(out)-1] == '\n' {
		out = out[:len(out)-1]
	}
	// Match JS JSON.stringify, which does not escape U+2028/U+2029.
	out = bytes.ReplaceAll(out, []byte(`\u2028`), []byte("\u2028"))
	out = bytes.ReplaceAll(out, []byte(`\u2029`), []byte("\u2029"))
	return out, nil
}
