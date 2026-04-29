// Package events provides NDJSON event emission helpers.
package events

import (
	"sync"
	"time"
)

const dedupWindow = 60 * time.Second

// DedupKey identifies a unique event stream to deduplicate.
type DedupKey struct {
	SrcIp    string
	DestIp   string
	DestPort uint16
	Protocol string
}

type bucket struct {
	windowStart time.Time
	hits        int
}

// Deduplicator tracks 60-second dedup windows, keyed by DedupKey.
// Call ShouldEmit before emitting an event; it returns false when the event
// is within the current window (i.e. it is a duplicate).
type Deduplicator struct {
	mu      sync.Mutex
	buckets map[DedupKey]*bucket
}

// NewDeduplicator creates a new Deduplicator.
func NewDeduplicator() *Deduplicator {
	return &Deduplicator{
		buckets: make(map[DedupKey]*bucket),
	}
}

// ShouldEmit returns (true, 1) for the first event in a window, or
// (false, hits) for duplicates within the same window. The caller should
// emit the event only when ShouldEmit returns true.
// When a window expires, the next call opens a new window and returns true.
func (d *Deduplicator) ShouldEmit(key DedupKey) (emit bool, hits int) {
	d.mu.Lock()
	defer d.mu.Unlock()

	now := time.Now()
	b, ok := d.buckets[key]
	if ok && now.Sub(b.windowStart) < dedupWindow {
		b.hits++
		return false, b.hits
	}

	// New window
	d.buckets[key] = &bucket{windowStart: now, hits: 1}
	return true, 1
}

// Prune removes expired buckets to prevent unbounded growth.
// Call periodically (e.g. every minute).
func (d *Deduplicator) Prune() {
	d.mu.Lock()
	defer d.mu.Unlock()

	now := time.Now()
	for k, b := range d.buckets {
		if now.Sub(b.windowStart) >= dedupWindow {
			delete(d.buckets, k)
		}
	}
}
