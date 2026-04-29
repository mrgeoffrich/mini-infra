//go:build !unix

// Package fw manages host firewall rules for the egress-fw-agent.
// This file is a no-op stub for non-Unix platforms. The agent only
// runs on Linux in production; this stub exists for Windows CI builds.
package fw

// setUmask is a no-op on non-Unix platforms.
func setUmask(_ int) int { return 0 }

// restoreUmask is a no-op on non-Unix platforms.
func restoreUmask(_ int) {}
