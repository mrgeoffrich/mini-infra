// Package main is the entry point for the egress-gateway binary.
// Phase 3: Smokescreen-based HTTP/HTTPS forward proxy with admin API.
package main

import (
	"context"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/sirupsen/logrus"
	smokescreen "github.com/stripe/smokescreen/pkg/smokescreen"

	"github.com/mrgeoffrich/mini-infra/egress-gateway/internal/admin"
	"github.com/mrgeoffrich/mini-infra/egress-gateway/internal/config"
	"github.com/mrgeoffrich/mini-infra/egress-gateway/internal/proxy"
	"github.com/mrgeoffrich/mini-infra/egress-gateway/internal/state"
)

func main() {
	cfg := config.LoadGatewayConfig()

	// Logrus logger — Smokescreen uses logrus, so we share the instance.
	logger := logrus.New()
	logger.SetFormatter(&logrus.JSONFormatter{})
	if cfg.LogLevel != "" {
		lvl, err := logrus.ParseLevel(cfg.LogLevel)
		if err == nil {
			logger.SetLevel(lvl)
		}
	}
	// Attach NDJSON hook so CANONICAL-PROXY-DECISION entries are re-emitted
	// to stdout in our EgressEvent shape for the log ingester.
	logger.AddHook(proxy.NewNDJSONLogHook())

	// Shared state.
	containers := state.NewContainerMap()
	rulesState := state.NewRulesState()
	aclSwapper := proxy.NewACLSwapper()

	// Admin server (manages health flags for proxy + admin listeners).
	adminSrv := admin.New(aclSwapper, containers, rulesState, logger)

	// Build Smokescreen config.
	// IMPORTANT: We call BuildProxy (not StartWithConfig) so we own our own
	// signal handling and can run proxy + admin as separate listeners.
	sk := smokescreen.NewConfig()
	sk.RoleFromRequest = proxy.RoleFromRequest(containers)
	sk.EgressACL = aclSwapper
	sk.DenyRanges = proxy.BuiltinPrivateRanges()
	sk.ConnectTimeout = 10 * time.Second
	sk.Log = logger
	// Security posture: only known managed containers (those present in the
	// container map) may use the proxy. Unmapped source IPs must be denied
	// deterministically. Setting AllowMissingRole=false makes this explicit —
	// Smokescreen's default is already false, but we document it here so the
	// intent is clear and a future config change can't accidentally allow it.
	sk.AllowMissingRole = false

	// Build the proxy handler.
	proxyHandler := smokescreen.BuildProxy(sk)

	// Wrap with a fast-fail check for unknown source IPs before handing off to
	// Smokescreen. When RoleFromRequest returns MissingRoleError, Smokescreen
	// logs an error and then returns an HTTP 503, but the timing is not
	// guaranteed for all code paths. This pre-handler ensures unknown IPs
	// receive a deterministic HTTP 403 JSON response within the request
	// read-header timeout, never silently timing out.
	authenticatedHandler := proxy.UnknownIPDenyHandler(proxyHandler, containers)

	// Wrap with DoH gate — runs before Smokescreen ACL.
	gatewayHandler := proxy.DoHGate(authenticatedHandler)

	// Determine ports.
	proxyPort := cfg.ProxyPort
	if proxyPort == "" {
		proxyPort = "3128"
	}
	adminPort := envOrDefault("ADMIN_PORT", "8054")

	// Proxy listener.
	proxyAddr := ":" + proxyPort
	proxySrv := &http.Server{
		Addr:              proxyAddr,
		Handler:           gatewayHandler,
		ReadHeaderTimeout: 30 * time.Second,
	}

	// Admin listener.
	adminAddr := ":" + adminPort
	adminHTTPSrv := &http.Server{
		Addr:              adminAddr,
		Handler:           adminSrv.Handler(),
		ReadHeaderTimeout: 15 * time.Second,
	}

	// Start proxy listener.
	proxyLn, err := net.Listen("tcp", proxyAddr)
	if err != nil {
		logger.WithError(err).Fatal("gateway: failed to bind proxy port")
	}
	adminSrv.SetProxyUp(true)
	logger.WithField("addr", proxyAddr).Info("gateway: proxy listener up")

	// Start admin listener.
	adminLn, err := net.Listen("tcp", adminAddr)
	if err != nil {
		logger.WithError(err).Fatal("gateway: failed to bind admin port")
	}
	adminSrv.SetAdminUp(true)
	logger.WithField("addr", adminAddr).Info("gateway: admin listener up")

	// Serve proxy in background.
	go func() {
		if err := proxySrv.Serve(proxyLn); err != nil && err != http.ErrServerClosed {
			logger.WithError(err).Error("gateway: proxy server error")
		}
		adminSrv.SetProxyUp(false)
	}()

	// Serve admin in background.
	go func() {
		if err := adminHTTPSrv.Serve(adminLn); err != nil && err != http.ErrServerClosed {
			logger.WithError(err).Error("gateway: admin server error")
		}
		adminSrv.SetAdminUp(false)
	}()

	// Wait for SIGTERM or SIGINT.
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
	sig := <-sigCh
	logger.WithField("signal", sig.String()).Info("gateway: shutting down")

	// Graceful shutdown with 30s deadline.
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	_ = proxySrv.Shutdown(ctx)
	_ = adminHTTPSrv.Shutdown(ctx)

	logger.Info("gateway: stopped")
}

func envOrDefault(key, def string) string {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	// Validate it's numeric to guard against misconfiguration.
	if _, err := strconv.Atoi(v); err != nil {
		return def
	}
	return v
}
