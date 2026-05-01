// Package main is the entry point for the egress-gateway binary.
//
// Phase 3 (ALT-28) replaced the :8054 admin HTTP listener with NATS:
// rules.apply and container-map.apply arrive as request/reply on per-env
// subjects, decisions are JetStream-published, and a 5 s heartbeat lands
// in a KV bucket. The legacy admin path stays compiled behind
// `EGRESS_GATEWAY_LEGACY_ADMIN=true` for one release so a smoke-test
// regression can fall back to it without rolling the image.
package main

import (
	"context"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/sirupsen/logrus"

	"github.com/mrgeoffrich/mini-infra/egress-gateway/internal/admin"
	"github.com/mrgeoffrich/mini-infra/egress-gateway/internal/config"
	"github.com/mrgeoffrich/mini-infra/egress-gateway/internal/natsbridge"
	"github.com/mrgeoffrich/mini-infra/egress-gateway/internal/proxy"
	rulesstate "github.com/mrgeoffrich/mini-infra/egress-gateway/internal/state"
	"github.com/mrgeoffrich/mini-infra/egress-shared/natsbus"
	"github.com/mrgeoffrich/mini-infra/egress-shared/state"
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

	environmentID := os.Getenv("ENVIRONMENT_ID")
	if environmentID == "" {
		// The stack template injects ENVIRONMENT_ID via {{environment.id}};
		// missing means the operator deployed the gateway outside of the
		// template. We still boot but log loudly — every published decision
		// will land in the JetStream stream with an empty environmentId,
		// which the server-side schema rejects.
		logger.Warn("gateway: ENVIRONMENT_ID not set; decisions will not be attributable on the bus")
	}
	natsURL := os.Getenv("NATS_URL")
	natsCreds := os.Getenv("NATS_CREDS")
	legacyAdmin := os.Getenv("EGRESS_GATEWAY_LEGACY_ADMIN") == "true"

	// Shared state.
	containers := state.NewContainerMap()
	rulesState := rulesstate.NewRulesState()
	aclSwapper := proxy.NewACLSwapper()

	// Track listener health for the heartbeat. atomic.Bool is goroutine-safe
	// and rolls cleanly into json.Marshal via the heartbeat struct.
	var proxyUp atomic.Bool

	// Wire the NATS bridge first if we have a URL — that way the JetStream
	// decision emitter is ready before we install the smokescreen log hook.
	// If NATS connection fails, we either fall back to stdout (legacy mode)
	// or log and exit (production), depending on the feature flag.
	var (
		bus    *natsbus.Bus
		bridge *natsbridge.Bridge
	)
	emitter := proxy.EmitToStdout

	if natsURL != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		// Phase 2's bus emits its lifecycle through slog. The gateway uses
		// logrus everywhere else (smokescreen ties us to it); a tiny JSON
		// slog handler shares stdout with logrus so a single docker-logs
		// stream still carries everything.
		busSlog := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
		client, err := natsbus.Connect(ctx, natsbus.ConnectOptions{
			URL:    natsURL,
			Creds:  natsCreds,
			Name:   "egress-gateway-" + environmentID,
			Logger: busSlog,
		})
		if err != nil {
			if legacyAdmin {
				logger.WithError(err).Warn("gateway: NATS connect failed; legacy admin mode is on, continuing on stdout decisions")
			} else {
				logger.WithError(err).Fatal("gateway: NATS connect failed and legacy admin mode is off — refusing to boot")
			}
		} else {
			bus = client
			b, bErr := natsbridge.New(natsbridge.Options{
				Bus:           client,
				EnvironmentID: environmentID,
				AclSwapper:    aclSwapper,
				Containers:    containers,
				RulesState:    rulesState,
				ProxyUp:       &proxyUp,
				Logger:        logger,
			})
			if bErr != nil {
				logger.WithError(bErr).Fatal("gateway: build natsbridge failed")
			}
			if cErr := b.Connect(); cErr != nil {
				if legacyAdmin {
					logger.WithError(cErr).Warn("gateway: natsbridge connect failed; legacy admin mode is on, continuing on stdout decisions")
				} else {
					logger.WithError(cErr).Fatal("gateway: natsbridge connect failed")
				}
			} else {
				bridge = b
				emitter = b.DecisionEmitter()
			}
		}
	} else if !legacyAdmin {
		logger.Fatal("gateway: NATS_URL not set and EGRESS_GATEWAY_LEGACY_ADMIN is not 'true' — refusing to boot")
	} else {
		logger.Warn("gateway: NATS_URL not set; running in legacy admin / stdout mode")
	}

	// Attach the NDJSON hook with the right emitter (NATS in production,
	// stdout in legacy mode). The hook stamps environmentId on every event.
	logger.AddHook(proxy.NewNDJSONLogHookWithEmitter(environmentID, emitter))

	// Build the full DoH → unknown-IP-deny → Smokescreen handler chain.
	gatewayHandler := proxy.BuildGatewayHandler(containers, aclSwapper, logger, proxy.GatewayOptions{
		DenyRanges: proxy.BuiltinPrivateRanges(),
	})

	// Determine ports.
	proxyPort := cfg.ProxyPort
	if proxyPort == "" {
		proxyPort = "3128"
	}

	// Proxy listener.
	proxyAddr := ":" + proxyPort
	proxySrv := &http.Server{
		Addr:              proxyAddr,
		Handler:           gatewayHandler,
		ReadHeaderTimeout: 30 * time.Second,
	}

	// Optional legacy admin listener (kept compiled behind the env-var flag
	// for one release; a follow-up issue tracks removal).
	var (
		adminSrv     *http.Server
		adminLn      net.Listener
		legacyAdminS *admin.Server
	)
	if legacyAdmin {
		legacyAdminS = admin.New(aclSwapper, containers, rulesState, logger)
		adminPort := envOrDefault("ADMIN_PORT", "8054")
		adminAddr := ":" + adminPort
		adminSrv = &http.Server{
			Addr:              adminAddr,
			Handler:           legacyAdminS.Handler(),
			ReadHeaderTimeout: 15 * time.Second,
		}
		var err error
		adminLn, err = net.Listen("tcp", adminAddr)
		if err != nil {
			logger.WithError(err).Fatal("gateway: failed to bind legacy admin port")
		}
		legacyAdminS.SetAdminUp(true)
		logger.WithField("addr", adminAddr).Warn("gateway: legacy admin listener up — disable EGRESS_GATEWAY_LEGACY_ADMIN once verified")
	}

	// Start proxy listener.
	proxyLn, err := net.Listen("tcp", proxyAddr)
	if err != nil {
		logger.WithError(err).Fatal("gateway: failed to bind proxy port")
	}
	proxyUp.Store(true)
	if legacyAdminS != nil {
		legacyAdminS.SetProxyUp(true)
	}
	logger.WithField("addr", proxyAddr).Info("gateway: proxy listener up")

	// Serve proxy in background.
	go func() {
		if err := proxySrv.Serve(proxyLn); err != nil && err != http.ErrServerClosed {
			logger.WithError(err).Error("gateway: proxy server error")
		}
		proxyUp.Store(false)
		if legacyAdminS != nil {
			legacyAdminS.SetProxyUp(false)
		}
	}()

	if adminSrv != nil && adminLn != nil {
		go func() {
			if err := adminSrv.Serve(adminLn); err != nil && err != http.ErrServerClosed {
				logger.WithError(err).Error("gateway: legacy admin server error")
			}
			if legacyAdminS != nil {
				legacyAdminS.SetAdminUp(false)
			}
		}()
	}

	// Wait for SIGTERM or SIGINT.
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
	sig := <-sigCh
	logger.WithField("signal", sig.String()).Info("gateway: shutting down")

	// Graceful shutdown with 30s deadline. Tear down in reverse boot order:
	// proxy listener first (stop accepting new requests), then bridge
	// (unsubscribe + heartbeat), then bus client (drain).
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	_ = proxySrv.Shutdown(ctx)
	if adminSrv != nil {
		_ = adminSrv.Shutdown(ctx)
	}
	if bridge != nil {
		bridge.Close()
	}
	if bus != nil {
		_ = bus.Close()
	}

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
