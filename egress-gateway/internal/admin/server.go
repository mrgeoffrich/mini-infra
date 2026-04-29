// Package admin implements the egress-gateway admin API.
// Wire contract: matches what EgressGatewayClient (TS) sends.
package admin

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync/atomic"
	"time"

	"github.com/sirupsen/logrus"

	"github.com/mrgeoffrich/mini-infra/egress-gateway/internal/proxy"
	"github.com/mrgeoffrich/mini-infra/egress-gateway/internal/state"
)

// ContainerMapRequest mirrors ContainerMapRequest in egress-gateway-client.ts.
type ContainerMapRequest struct {
	Version int                        `json:"version"`
	Entries []ContainerMapEntry        `json:"entries"`
}

// ContainerMapEntry mirrors ContainerMapEntry in egress-gateway-client.ts.
type ContainerMapEntry struct {
	IP          string `json:"ip"`
	StackID     string `json:"stackId"`
	ServiceName string `json:"serviceName"`
	ContainerID string `json:"containerId,omitempty"`
}

// ContainerMapResponse mirrors ContainerMapResponse in egress-gateway-client.ts.
type ContainerMapResponse struct {
	Version    int  `json:"version"`
	Accepted   bool `json:"accepted"`
	EntryCount int  `json:"entryCount"`
}

// RulesSnapshotResponse mirrors RulesSnapshotResponse in egress-gateway-client.ts.
type RulesSnapshotResponse struct {
	Version    int  `json:"version"`
	Accepted   bool `json:"accepted"`
	RuleCount  int  `json:"ruleCount"`
	StackCount int  `json:"stackCount"`
}

// HealthResponse is the payload for GET /admin/health.
type HealthResponse struct {
	OK             bool              `json:"ok"`
	RulesVersion   int               `json:"rulesVersion"`
	UptimeSeconds  float64           `json:"uptimeSeconds"`
	Listeners      ListenerStatus    `json:"listeners"`
}

// ListenerStatus reports whether each listener is up.
type ListenerStatus struct {
	Proxy bool `json:"proxy"`
	Admin bool `json:"admin"`
}

// Server is the egress-gateway admin HTTP server.
type Server struct {
	aclSwapper    *proxy.ACLSwapper
	containers    *state.ContainerMap
	rulesState    *state.RulesState
	log           *logrus.Logger
	startTime     time.Time
	proxyUp       atomic.Bool
	adminUp       atomic.Bool
}

// New creates a Server wired to the given ACL swapper, container map, and rules state.
func New(
	swapper *proxy.ACLSwapper,
	containers *state.ContainerMap,
	rulesState *state.RulesState,
	log *logrus.Logger,
) *Server {
	return &Server{
		aclSwapper: swapper,
		containers: containers,
		rulesState: rulesState,
		log:        log,
		startTime:  time.Now(),
	}
}

// SetProxyUp marks the proxy listener as up or down.
func (s *Server) SetProxyUp(up bool) {
	s.proxyUp.Store(up)
}

// SetAdminUp marks the admin listener as up or down.
func (s *Server) SetAdminUp(up bool) {
	s.adminUp.Store(up)
}

// Handler returns the HTTP handler for the admin API.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /admin/rules", s.handleRules)
	mux.HandleFunc("POST /admin/container-map", s.handleContainerMap)
	mux.HandleFunc("GET /admin/health", s.handleHealth)
	return mux
}

// handleRules processes POST /admin/rules.
// Compiles the snapshot into a Smokescreen *acl.ACL and atomically swaps.
func (s *Server) handleRules(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 4<<20)) // 4 MB limit
	if err != nil {
		http.Error(w, "read error", http.StatusBadRequest)
		return
	}

	snap, err := proxy.ParseRulesSnapshot(body)
	if err != nil {
		s.log.WithError(err).Warn("admin: invalid rules snapshot")
		http.Error(w, fmt.Sprintf("invalid payload: %v", err), http.StatusBadRequest)
		return
	}

	newACL, err := proxy.CompileACL(s.log, snap)
	if err != nil {
		s.log.WithError(err).Warn("admin: failed to compile ACL")
		http.Error(w, fmt.Sprintf("compile error: %v", err), http.StatusInternalServerError)
		return
	}

	s.aclSwapper.Swap(newACL)

	stackCount := len(snap.StackPolicies)
	// Count total rules across all stacks.
	ruleCount := 0
	for _, sp := range snap.StackPolicies {
		ruleCount += len(sp.Rules)
	}
	s.rulesState.Set(snap.Version, stackCount)

	s.log.WithFields(logrus.Fields{
		"version":    snap.Version,
		"stackCount": stackCount,
		"ruleCount":  ruleCount,
	}).Info("admin: ACL updated")

	resp := RulesSnapshotResponse{
		Version:    snap.Version,
		Accepted:   true,
		RuleCount:  ruleCount,
		StackCount: stackCount,
	}
	writeJSON(w, http.StatusOK, resp)
}

// handleContainerMap processes POST /admin/container-map.
// Replaces the container map with the new snapshot (atomic replace).
func (s *Server) handleContainerMap(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 4<<20))
	if err != nil {
		http.Error(w, "read error", http.StatusBadRequest)
		return
	}

	var req ContainerMapRequest
	if err := json.Unmarshal(body, &req); err != nil {
		s.log.WithError(err).Warn("admin: invalid container-map payload")
		http.Error(w, fmt.Sprintf("invalid payload: %v", err), http.StatusBadRequest)
		return
	}

	snapshot := make(map[string]*state.ContainerAttr, len(req.Entries))
	for _, e := range req.Entries {
		snapshot[e.IP] = &state.ContainerAttr{
			StackID:     e.StackID,
			ServiceName: e.ServiceName,
		}
	}
	s.containers.Replace(snapshot)

	s.log.WithFields(logrus.Fields{
		"version":    req.Version,
		"entryCount": len(req.Entries),
	}).Info("admin: container map updated")

	resp := ContainerMapResponse{
		Version:    req.Version,
		Accepted:   true,
		EntryCount: len(req.Entries),
	}
	writeJSON(w, http.StatusOK, resp)
}

// handleHealth processes GET /admin/health.
func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	resp := HealthResponse{
		OK:            true,
		RulesVersion:  s.rulesState.Version(),
		UptimeSeconds: time.Since(s.startTime).Seconds(),
		Listeners: ListenerStatus{
			Proxy: s.proxyUp.Load(),
			Admin: s.adminUp.Load(),
		},
	}
	writeJSON(w, http.StatusOK, resp)
}

// writeJSON marshals v and writes it as an application/json response.
func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	b, err := json.Marshal(v)
	if err != nil {
		http.Error(w, "marshal error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(b)
}
