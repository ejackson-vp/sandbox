// Package profile loads the trusted runtime manifest selected for a session.
//
// The manifest lives on the read-only runtime cache, not in the pod image. The
// guest validates its name, environment keys and command list before any
// customer command is started.
package profile

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

const maxManifestBytes = 64 << 10

var (
	namePattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,31}$`)
	envPattern  = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,127}$`)
)

// BlockedEnv are process-injection variables that a runtime profile must never
// set. LD_LIBRARY_PATH is deliberately allowed; profiles need it for native
// libraries.
var blockedEnv = map[string]struct{}{
	"LD_PRELOAD":   {},
	"LD_AUDIT":     {},
	"GCONV_PATH":   {},
	"MALLOC_TRACE": {},
}

// Manifest is the on-disk profile contract. It is system-defined and digest
// pinned by the controller; the guest only verifies shape and local presence.
type Manifest struct {
	Name     string            `json:"name"`
	Version  string            `json:"version"`
	Env      map[string]string `json:"env"`
	Commands []string          `json:"commands"`
}

// Load reads <root>/<name>/profile.json and validates it.
func Load(root, name string) (Manifest, error) {
	if !namePattern.MatchString(name) {
		return Manifest{}, fmt.Errorf("invalid runtime profile name %q", name)
	}
	cleanRoot := filepath.Clean(root)
	dir := filepath.Join(cleanRoot, name)
	if dir != cleanRoot && !strings.HasPrefix(dir, cleanRoot+string(os.PathSeparator)) {
		return Manifest{}, fmt.Errorf("profile %q escapes runtime root", name)
	}
	file, err := os.Open(filepath.Join(dir, "profile.json"))
	if err != nil {
		return Manifest{}, fmt.Errorf("open profile %q: %w", name, err)
	}
	defer file.Close()

	var manifest Manifest
	decoder := json.NewDecoder(io.LimitReader(file, maxManifestBytes))
	if err := decoder.Decode(&manifest); err != nil {
		return Manifest{}, fmt.Errorf("decode profile %q: %w", name, err)
	}
	if manifest.Name != name {
		return Manifest{}, fmt.Errorf("profile name mismatch: directory %q, manifest %q", name, manifest.Name)
	}
	if manifest.Env == nil {
		manifest.Env = map[string]string{}
	}
	if _, ok := manifest.Env["PATH"]; !ok {
		return Manifest{}, errors.New("runtime profile must set PATH")
	}
	for key, value := range manifest.Env {
		if !envPattern.MatchString(key) {
			return Manifest{}, fmt.Errorf("invalid environment key %q", key)
		}
		if _, blocked := blockedEnv[key]; blocked {
			return Manifest{}, fmt.Errorf("environment key %q is not allowed", key)
		}
		if strings.ContainsRune(value, 0) || len(value) > 8192 {
			return Manifest{}, fmt.Errorf("invalid value for environment key %q", key)
		}
	}
	for i, command := range manifest.Commands {
		if command == "" || strings.ContainsRune(command, 0) {
			return Manifest{}, fmt.Errorf("invalid command entry %d", i)
		}
	}
	return manifest, nil
}
