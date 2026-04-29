// Package log provides a structured JSON logger wrapping slog.
package log

import (
	"log/slog"
	"os"
	"strings"
)

// New returns a *slog.Logger configured for structured JSON output.
// Level is sourced from the LOG_LEVEL environment variable; defaults to "info".
func New() *slog.Logger {
	level := parseLevel(os.Getenv("LOG_LEVEL"))
	return slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: level}))
}

func parseLevel(s string) slog.Level {
	switch strings.ToLower(s) {
	case "debug":
		return slog.LevelDebug
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}
