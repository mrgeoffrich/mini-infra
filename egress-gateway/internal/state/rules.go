// Package state holds in-memory gateway state.
package state

import "sync/atomic"

// RulesState tracks the latest pushed rules snapshot version and stack count
// for health-check reporting.
type RulesState struct {
	version    atomic.Int64
	stackCount atomic.Int64
}

// NewRulesState creates a zero-valued RulesState.
func NewRulesState() *RulesState {
	return &RulesState{}
}

// Set updates the version and stack count atomically.
func (r *RulesState) Set(version int, stackCount int) {
	r.version.Store(int64(version))
	r.stackCount.Store(int64(stackCount))
}

// Version returns the last pushed rules version (0 = never pushed).
func (r *RulesState) Version() int {
	return int(r.version.Load())
}

// StackCount returns the number of stacks in the last snapshot.
func (r *RulesState) StackCount() int {
	return int(r.stackCount.Load())
}
