// Package fw manages host firewall rules for the egress-fw-agent.
// This file implements the Unix-socket HTTP admin API.
package fw

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"regexp"
	"runtime"
	"strings"
	"sync"
)

// envNameRE is the allowlist for environment names.
// Must start with [a-z0-9], followed by up to 30 [a-z0-9-] characters.
var envNameRE = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,30}$`)

// shellMetaChars contains characters that must never appear in an env name.
// This is belt-and-suspenders: the regex already excludes them.
var shellMetaChars = []string{";", "|", "&", " ", "`", "$", "\\", "\t", "\n", "\r", ">", "<", "!", "'", "\"", "(", ")", "{", "}", "[", "]", "#", "~", "^", "*", "?"}

// EnvState holds the desired state for a single environment.
type EnvState struct {
	BridgeCIDR string
	Mode       Mode
}

// EnvStore is the in-memory store of desired env states.
type EnvStore struct {
	mu   sync.RWMutex
	envs map[string]EnvState
}

// NewEnvStore creates an empty EnvStore.
func NewEnvStore() *EnvStore {
	return &EnvStore{envs: make(map[string]EnvState)}
}

// Get returns the stored state for an env, or (zero, false) if not found.
func (s *EnvStore) Get(env string) (EnvState, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	st, ok := s.envs[env]
	return st, ok
}

// Set stores the desired state for an env.
func (s *EnvStore) Set(env string, st EnvState) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.envs[env] = st
}

// Delete removes the stored state for an env.
func (s *EnvStore) Delete(env string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.envs, env)
}

// Server is the Unix-socket HTTP admin server.
type Server struct {
	socketPath string
	store      *EnvStore
	log        *slog.Logger
}

// NewServer creates a new admin API Server.
func NewServer(socketPath string, store *EnvStore, log *slog.Logger) *Server {
	return &Server{socketPath: socketPath, store: store, log: log}
}

// Run starts the Unix-socket HTTP server and blocks until ctx is cancelled.
func (s *Server) Run(ctx context.Context) error {
	// Remove stale socket file.
	_ = os.Remove(s.socketPath)

	// Ensure parent directory exists.
	if err := os.MkdirAll(dirOf(s.socketPath), 0o700); err != nil {
		return fmt.Errorf("mkdir %s: %w", dirOf(s.socketPath), err)
	}

	// Set umask to 0077 before Listen so the socket file is created with mode
	// 0600 from the start, closing the TOCTOU window between Listen and Chmod.
	// setUmask / restoreUmask are defined in platform-specific files.
	if runtime.GOOS == "linux" {
		prev := setUmask(0o077)
		ln, err := net.Listen("unix", s.socketPath)
		restoreUmask(prev)
		if err != nil {
			return fmt.Errorf("listen unix %s: %w", s.socketPath, err)
		}
		defer ln.Close()
		// Chmod as defence-in-depth (in case umask was overridden by parent process).
		if err := os.Chmod(s.socketPath, 0o600); err != nil {
			return fmt.Errorf("chmod %s: %w", s.socketPath, err)
		}
		return s.serveHTTP(ctx, ln)
	}

	ln, err := net.Listen("unix", s.socketPath)
	if err != nil {
		return fmt.Errorf("listen unix %s: %w", s.socketPath, err)
	}
	defer ln.Close()

	// Restrict access to root only.
	if err := os.Chmod(s.socketPath, 0o600); err != nil {
		return fmt.Errorf("chmod %s: %w", s.socketPath, err)
	}

	return s.serveHTTP(ctx, ln)
}

// serveHTTP registers the mux and serves on the given listener until ctx is done.
func (s *Server) serveHTTP(ctx context.Context, ln net.Listener) error {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/health", s.handleHealth)
	mux.HandleFunc("POST /v1/env", s.handleApplyEnv)
	mux.HandleFunc("DELETE /v1/env/", s.handleRemoveEnv)
	mux.HandleFunc("POST /v1/ipset/", s.handleIpset)

	srv := &http.Server{Handler: mux}

	go func() {
		<-ctx.Done()
		_ = srv.Close()
	}()

	s.log.Info("Admin API listening", "socket", s.socketPath)
	if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
		return err
	}
	return nil
}

// --- Handlers ---

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

type applyEnvRequest struct {
	Env        string `json:"env"`
	BridgeCidr string `json:"bridgeCidr"`
	Mode       string `json:"mode"`
}

func (s *Server) handleApplyEnv(w http.ResponseWriter, r *http.Request) {
	var req applyEnvRequest
	if !decodeBody(w, r, &req) {
		return
	}

	if err := validateEnvName(req.Env); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	mode, err := validateMode(req.Mode)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	_, bridgeCIDR, err := validateBridgeCIDR(req.BridgeCidr)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	cidrStr := bridgeCIDR.String()
	if err := ensureIpset(req.Env); err != nil {
		s.log.Error("ensureIpset failed", "env", req.Env, "err", err)
		writeError(w, http.StatusInternalServerError, "failed to create ipset")
		return
	}

	if err := applyEnvRules(req.Env, cidrStr, mode); err != nil {
		s.log.Error("applyEnvRules failed", "env", req.Env, "err", err)
		writeError(w, http.StatusInternalServerError, "failed to apply iptables rules")
		return
	}

	s.store.Set(req.Env, EnvState{BridgeCIDR: cidrStr, Mode: mode})
	writeJSON(w, http.StatusOK, map[string]string{"status": "applied"})
}

func (s *Server) handleRemoveEnv(w http.ResponseWriter, r *http.Request) {
	// Path: /v1/env/<env>
	env := strings.TrimPrefix(r.URL.Path, "/v1/env/")
	if err := validateEnvName(env); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	if err := removeEnvRules(env); err != nil {
		s.log.Error("removeEnvRules failed", "env", env, "err", err)
		writeError(w, http.StatusInternalServerError, "failed to remove iptables rules")
		return
	}

	if err := destroyIpset(env); err != nil {
		s.log.Error("destroyIpset failed", "env", env, "err", err)
		writeError(w, http.StatusInternalServerError, "failed to destroy ipset")
		return
	}

	s.store.Delete(env)
	writeJSON(w, http.StatusOK, map[string]string{"status": "removed"})
}

type ipAddRequest struct {
	IP string `json:"ip"`
}

type ipSyncRequest struct {
	IPs []string `json:"ips"`
}

func (s *Server) handleIpset(w http.ResponseWriter, r *http.Request) {
	// Path: /v1/ipset/<env>/managed/<action>
	// action: add | del | sync
	path := strings.TrimPrefix(r.URL.Path, "/v1/ipset/")
	parts := strings.SplitN(path, "/", 3)
	if len(parts) < 3 || parts[1] != "managed" {
		writeError(w, http.StatusNotFound, "not found")
		return
	}

	env := parts[0]
	action := parts[2]

	if err := validateEnvName(env); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	envState, ok := s.store.Get(env)
	if !ok {
		writeError(w, http.StatusBadRequest, "env not registered — call POST /v1/env first")
		return
	}

	_, bridgeCIDR, err := net.ParseCIDR(envState.BridgeCIDR)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "invalid stored bridgeCidr")
		return
	}

	switch action {
	case "add":
		if r.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		var req ipAddRequest
		if !decodeBody(w, r, &req) {
			return
		}
		if err := validateManagedIP(req.IP, bridgeCIDR); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		if err := addManagedMember(env, req.IP); err != nil {
			s.log.Error("addManagedMember failed", "env", env, "ip", req.IP, "err", err)
			writeError(w, http.StatusInternalServerError, "failed to add ipset member")
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "added"})

	case "del":
		if r.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		var req ipAddRequest
		if !decodeBody(w, r, &req) {
			return
		}
		if err := validateManagedIP(req.IP, bridgeCIDR); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		if err := delManagedMember(env, req.IP); err != nil {
			s.log.Error("delManagedMember failed", "env", env, "ip", req.IP, "err", err)
			writeError(w, http.StatusInternalServerError, "failed to del ipset member")
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})

	case "sync":
		if r.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		var req ipSyncRequest
		if !decodeBody(w, r, &req) {
			return
		}
		for _, ip := range req.IPs {
			if err := validateManagedIP(ip, bridgeCIDR); err != nil {
				writeError(w, http.StatusBadRequest, fmt.Sprintf("invalid ip %q: %s", ip, err.Error()))
				return
			}
		}
		if err := syncManaged(env, req.IPs); err != nil {
			s.log.Error("syncManaged failed", "env", env, "err", err)
			writeError(w, http.StatusInternalServerError, "failed to sync ipset")
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "synced"})

	default:
		writeError(w, http.StatusNotFound, "unknown ipset action")
	}
}

// --- Validation helpers ---

// validateEnvName checks that env matches the allowlist regex and contains
// no shell metacharacters.
func validateEnvName(env string) error {
	if len(env) > 31 {
		return fmt.Errorf("env name too long (max 31 characters)")
	}
	if len(env) == 0 {
		return fmt.Errorf("env name is empty")
	}
	// Check for path traversal sequences first (before regex).
	if strings.Contains(env, "..") || strings.Contains(env, "/") || strings.Contains(env, "%") {
		return fmt.Errorf("env name contains path traversal characters")
	}
	for _, m := range shellMetaChars {
		if strings.Contains(env, m) {
			return fmt.Errorf("env name contains shell metacharacter %q", m)
		}
	}
	if !envNameRE.MatchString(env) {
		return fmt.Errorf("env name %q does not match ^[a-z0-9][a-z0-9-]{0,30}$", env)
	}
	return nil
}

// validateMode checks that the mode string is "observe" or "enforce".
func validateMode(s string) (Mode, error) {
	switch Mode(s) {
	case ModeObserve, ModeEnforce:
		return Mode(s), nil
	}
	return "", fmt.Errorf("mode must be %q or %q, got %q", ModeObserve, ModeEnforce, s)
}

// bannedCIDRs lists ranges that must not be used as bridgeCidr.
// The check: if the candidate network contains the banned network's first IP
// AND is not the candidate itself — or vice versa — it overlaps.
var bannedCIDRs = []string{
	"127.0.0.0/8",    // loopback
	"0.0.0.0/8",      // "this" network
	"169.254.0.0/16",  // link-local
	"224.0.0.0/4",    // multicast
	"240.0.0.0/4",    // reserved
}

// validateBridgeCIDR parses and validates a bridgeCidr argument.
func validateBridgeCIDR(cidr string) (net.IP, *net.IPNet, error) {
	if len(cidr) > 256 {
		return nil, nil, fmt.Errorf("bridgeCidr too long")
	}
	ip, network, err := net.ParseCIDR(cidr)
	if err != nil {
		return nil, nil, fmt.Errorf("bridgeCidr %q is not a valid CIDR: %w", cidr, err)
	}
	// Must be IPv4.
	if ip.To4() == nil {
		return nil, nil, fmt.Errorf("bridgeCidr must be an IPv4 CIDR")
	}
	// Reject the entire internet.
	ones, bits := network.Mask.Size()
	if ones == 0 && bits > 0 {
		return nil, nil, fmt.Errorf("bridgeCidr %q is too broad (must not be 0.0.0.0/0)", cidr)
	}
	// Check overlap with banned ranges.
	for _, banned := range bannedCIDRs {
		_, bannedNet, _ := net.ParseCIDR(banned)
		if bannedNet == nil {
			continue
		}
		// Overlap: candidate contains the banned network's network address OR vice versa.
		if network.Contains(bannedNet.IP) || bannedNet.Contains(network.IP) {
			return nil, nil, fmt.Errorf("bridgeCidr %q overlaps reserved range %s", cidr, banned)
		}
	}
	return ip, network, nil
}

// validateManagedIP checks that ip is a valid IPv4 address within the env's bridgeCidr.
func validateManagedIP(ipStr string, bridgeCIDR *net.IPNet) error {
	if len(ipStr) > 45 {
		return fmt.Errorf("ip too long")
	}
	ip := net.ParseIP(ipStr)
	if ip == nil {
		return fmt.Errorf("ip %q is not a valid IP address", ipStr)
	}
	if ip.To4() == nil {
		return fmt.Errorf("ip %q is not an IPv4 address (IPv6 not supported)", ipStr)
	}
	if !bridgeCIDR.Contains(ip) {
		return fmt.Errorf("ip %q is not within bridgeCidr %s", ipStr, bridgeCIDR)
	}
	return nil
}

// --- JSON helpers ---

func decodeBody(w http.ResponseWriter, r *http.Request, v interface{}) bool {
	// Limit body size to prevent memory exhaustion attacks.
	r.Body = http.MaxBytesReader(w, r.Body, 64*1024) // 64 KB
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("invalid JSON: %s", err.Error()))
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func dirOf(p string) string {
	idx := strings.LastIndex(p, "/")
	if idx < 0 {
		return "."
	}
	return p[:idx]
}
