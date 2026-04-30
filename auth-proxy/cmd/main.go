// Package main is the entry point for the auth-proxy binary. It loads the
// YAML config (with ${ENV_VAR} interpolation for secrets), constructs each
// provider, wires the HTTP server, and serves until interrupted.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/sirupsen/logrus"

	"github.com/mrgeoffrich/mini-infra/auth-proxy/internal/accesslog"
	"github.com/mrgeoffrich/mini-infra/auth-proxy/internal/config"
	"github.com/mrgeoffrich/mini-infra/auth-proxy/internal/providers"
	"github.com/mrgeoffrich/mini-infra/auth-proxy/internal/proxy"
)

const (
	defaultConfigPath = "/etc/auth-proxy/config.yaml"
	configEnvVar      = "AUTH_PROXY_CONFIG"
	shutdownGrace     = 10 * time.Second
)

func main() {
	configPath := flag.String("config", "", "path to config.yaml (default: $AUTH_PROXY_CONFIG or "+defaultConfigPath+")")
	flag.Parse()

	resolved := *configPath
	if resolved == "" {
		resolved = os.Getenv(configEnvVar)
	}
	if resolved == "" {
		resolved = defaultConfigPath
	}

	logger := logrus.New()
	logger.SetFormatter(&logrus.JSONFormatter{
		TimestampFormat: time.RFC3339,
		FieldMap:        logrus.FieldMap{logrus.FieldKeyTime: "ts", logrus.FieldKeyMsg: "msg"},
	})

	if err := run(resolved, logger); err != nil {
		logger.WithError(err).Fatal("auth-proxy stopped")
	}
}

func run(configPath string, logger *logrus.Logger) error {
	cfg, err := config.Load(configPath)
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}

	entries, err := buildProviderEntries(cfg)
	if err != nil {
		return fmt.Errorf("build providers: %w", err)
	}
	if err := proxy.EnsureValid(entries); err != nil {
		return err
	}

	access := accesslog.NewLogger(os.Stdout, logrus.InfoLevel)
	srv := proxy.NewServer(entries, access, logger)

	server := &http.Server{
		Addr:              cfg.Listen,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 30 * time.Second,
		// No body-size limit on purpose: Anthropic & Drive both legitimately
		// receive large multi-MB payloads. Let upstreams enforce.
	}

	// Spin off the listener so we can handle SIGINT/SIGTERM cleanly.
	listenErr := make(chan error, 1)
	go func() {
		logger.WithField("listen", cfg.Listen).Info("auth-proxy listening")
		srv.MarkReady()
		err := server.ListenAndServe()
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			listenErr <- err
		}
		close(listenErr)
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)

	select {
	case sig := <-stop:
		logger.WithField("signal", sig.String()).Info("shutting down")
	case err := <-listenErr:
		if err != nil {
			return fmt.Errorf("listen: %w", err)
		}
		return nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), shutdownGrace)
	defer cancel()
	if err := server.Shutdown(ctx); err != nil {
		return fmt.Errorf("graceful shutdown: %w", err)
	}
	return nil
}

// buildProviderEntries turns the validated config into the proxy.Entry map
// the server consumes — one Entry per provider, with a per-tenant Provider
// constructed once at startup. Subsequent requests just look up the right
// entry by path; no allocation on the hot path.
func buildProviderEntries(cfg *config.Config) (map[string]proxy.Entry, error) {
	entries := make(map[string]proxy.Entry, len(cfg.Providers))
	for pname, p := range cfg.Providers {
		upstream, err := url.Parse(p.Upstream)
		if err != nil {
			return nil, fmt.Errorf("provider %q: parse upstream: %w", pname, err)
		}

		tenants := make(map[string]proxy.Provider, len(p.Tenants))
		for tname, t := range p.Tenants {
			full := pname + "/" + tname
			switch p.Type {
			case config.TypeStaticHeader:
				tenants[tname] = providers.NewStaticHeader(full, t.Headers)
			case config.TypeOAuth2Refresh:
				tenants[tname] = providers.NewOAuth2Refresh(providers.OAuth2Config{
					Name:         full,
					TokenURL:     p.OAuth.TokenURL,
					ClientID:     t.ClientID,
					ClientSecret: t.ClientSecret,
					RefreshToken: t.RefreshToken,
				})
			default:
				return nil, fmt.Errorf("provider %q: unknown type %q", pname, p.Type)
			}
		}
		entries[pname] = proxy.Entry{Upstream: upstream, Tenants: tenants}
	}
	return entries, nil
}
