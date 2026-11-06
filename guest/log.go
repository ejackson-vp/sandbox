package main

import (
	"encoding/json"
	"fmt"
	"os"
	"time"
)

func logEvent(event string, fields map[string]any) {
	line := map[string]any{
		"ts":      time.Now().UTC().Format(time.RFC3339Nano),
		"level":   "info",
		"service": "guest",
		"event":   event,
	}
	for k, v := range fields {
		line[k] = v
	}
	data, err := json.Marshal(line)
	if err != nil {
		return
	}
	fmt.Fprintln(os.Stderr, string(data))
}
