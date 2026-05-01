// Package natsbus — JetStream + KV helpers.
//
// Phase 2 (egress-fw-agent) needs three JS surfaces from Go:
//
//   - JSPublish — for past-tense events (`rules.applied`) and the NFLOG
//     events stream. JetStream durability is what gives us the
//     "≤1s loss across agent restart" acceptance criterion in ALT-27.
//   - KVPut — for the 5 s health heartbeat into `egress-fw-health`.
//   - KVGet — included for symmetry; the agent doesn't read its own
//     bucket but the gateway (Phase 3) will.
//
// Stream/bucket *creation* lives on the server side (`NatsBus.jetstream.
// ensureStream` / `ensureKv`). The agent assumes its destinations exist.
// If they don't, JSPublish/KVPut surface the SDK's "stream not found"
// error directly so the operator gets a clear "you forgot to bootstrap"
// signal rather than silent data loss.

package natsbus

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/nats-io/nats.go"
)

// JSPublish marshals `payload` to JSON and publishes to a JetStream-backed
// subject. Returns the PubAck on success — callers can ignore or assert on
// the stream/sequence for testing.
//
// Performs a synchronous publish. The agent's NFLOG path is the heaviest
// publisher; if throughput becomes a concern we can swap to async publish
// (`PublishAsync`) and a fan-in PubAck consumer, but Phase 2 doesn't need
// it (NFLOG events are pre-aggregated; mergedHits batches at the source).
func (b *Bus) JSPublish(subject string, payload any) (*nats.PubAck, error) {
	data, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("natsbus: marshal js publish on %s: %w", subject, err)
	}
	ack, err := b.js.Publish(subject, data)
	if err != nil {
		return nil, fmt.Errorf("natsbus: js publish on %s: %w", subject, err)
	}
	return ack, nil
}

// JSPublishWithContext is the context-aware variant. Use it when the caller
// has a deadline (e.g. shutdown is in flight). On timeout the message is
// not published.
func (b *Bus) JSPublishWithContext(ctx context.Context, subject string, payload any) (*nats.PubAck, error) {
	data, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("natsbus: marshal js publish on %s: %w", subject, err)
	}
	ack, err := b.js.PublishMsg(&nats.Msg{Subject: subject, Data: data}, nats.Context(ctx))
	if err != nil {
		return nil, fmt.Errorf("natsbus: js publish on %s: %w", subject, err)
	}
	return ack, nil
}

// kv resolves the SDK KeyValue handle for a bucket, caching it for the
// life of the connection. Bucket *creation* belongs on the server side —
// `nats.KeyValue` here only opens an existing bucket. If the bucket is
// missing the SDK returns `ErrBucketNotFound`, which surfaces directly to
// the caller.
func (b *Bus) kv(bucket string) (nats.KeyValue, error) {
	b.kvMu.RLock()
	if cached, ok := b.kvCache[bucket]; ok {
		b.kvMu.RUnlock()
		return cached, nil
	}
	b.kvMu.RUnlock()

	b.kvMu.Lock()
	defer b.kvMu.Unlock()
	// Double-check under write lock — another goroutine may have raced us.
	if cached, ok := b.kvCache[bucket]; ok {
		return cached, nil
	}
	kv, err := b.js.KeyValue(bucket)
	if err != nil {
		return nil, fmt.Errorf("natsbus: open kv bucket %s: %w", bucket, err)
	}
	b.kvCache[bucket] = kv
	return kv, nil
}

// KVPut writes `value` (JSON-encoded) under `key` in the named bucket.
// Returns the new revision number so callers can detect concurrent writes
// (Phase 2 doesn't currently care, but the gateway might).
func (b *Bus) KVPut(bucket, key string, value any) (uint64, error) {
	kv, err := b.kv(bucket)
	if err != nil {
		return 0, err
	}
	data, err := json.Marshal(value)
	if err != nil {
		return 0, fmt.Errorf("natsbus: marshal kv put %s/%s: %w", bucket, key, err)
	}
	rev, err := kv.Put(key, data)
	if err != nil {
		return 0, fmt.Errorf("natsbus: kv put %s/%s: %w", bucket, key, err)
	}
	return rev, nil
}

// ErrKvKeyNotFound is returned by KVGet when the key is missing or has
// been deleted. Callers should treat it as the "no value yet" case rather
// than a transport error.
var ErrKvKeyNotFound = errors.New("natsbus: kv key not found")

// KVGet reads the latest non-deleted value under `key` and JSON-decodes it
// into `out`. Returns `ErrKvKeyNotFound` if the key is missing or has a
// DEL/PURGE tombstone.
func (b *Bus) KVGet(bucket, key string, out any) (uint64, error) {
	kv, err := b.kv(bucket)
	if err != nil {
		return 0, err
	}
	entry, err := kv.Get(key)
	if err != nil {
		if errors.Is(err, nats.ErrKeyNotFound) {
			return 0, ErrKvKeyNotFound
		}
		return 0, fmt.Errorf("natsbus: kv get %s/%s: %w", bucket, key, err)
	}
	// `Operation` is `KeyValuePut` for live values; anything else is a
	// tombstone (delete / purge) and counts as "not found" to callers.
	if entry.Operation() != nats.KeyValuePut {
		return 0, ErrKvKeyNotFound
	}
	if out != nil {
		if err := json.Unmarshal(entry.Value(), out); err != nil {
			return 0, fmt.Errorf("natsbus: unmarshal kv value %s/%s: %w", bucket, key, err)
		}
	}
	return entry.Revision(), nil
}
