//go:build unix

// Package fw manages host firewall rules for the egress-fw-agent.
// This file provides Unix-specific umask helpers for closing the TOCTOU
// window when binding the Unix socket.
package fw

import "syscall"

// setUmask sets the process umask to mask and returns the previous umask.
func setUmask(mask int) int {
	return syscall.Umask(mask)
}

// restoreUmask restores the process umask to prev.
func restoreUmask(prev int) {
	syscall.Umask(prev)
}
