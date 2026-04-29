// Package state holds in-memory gateway state (Phase 3 will fill this).
package state

import "sync"

// ContainerAttr holds the resolved stack/service identity for a container IP.
type ContainerAttr struct {
	StackID     string
	ServiceName string
}

// ContainerMap is a host-wide, concurrency-safe map from container IP → identity.
// Phase 3 wires it to the POST /admin/container-map endpoint.
// Phase 2 uses it as a read-only stub that always returns nil (unknown container).
type ContainerMap struct {
	mu      sync.RWMutex
	entries map[string]*ContainerAttr // key: IPv4 string
}

// NewContainerMap creates an empty ContainerMap.
func NewContainerMap() *ContainerMap {
	return &ContainerMap{entries: make(map[string]*ContainerAttr)}
}

// Lookup returns the ContainerAttr for the given IP, or nil if unknown.
func (m *ContainerMap) Lookup(ip string) *ContainerAttr {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.entries[ip]
}

// Replace atomically replaces the entire map with a new snapshot.
func (m *ContainerMap) Replace(snapshot map[string]*ContainerAttr) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.entries = snapshot
}
