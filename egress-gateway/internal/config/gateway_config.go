// Package config holds configuration types for the egress-gateway.
package config

import "os"

// GatewayConfig holds runtime configuration for the egress-gateway (Phase 3).
type GatewayConfig struct {
	// ProxyPort is the TCP port the forward proxy listens on.
	ProxyPort string
	// NatsCredsFile is the path to a `.creds` file on a mounted volume,
	// injected as NATS_CREDS_FILE by the stack template's `nats-creds`
	// dynamicEnv (Phase 5, §4.3). Preferred over the inline NATS_CREDS blob
	// when set — the bus re-reads it on every reconnect so a rotated credential
	// is picked up without a container recreate. Empty on older templates.
	NatsCredsFile string
	// AdminSocketPath is the Unix-domain socket for the admin API.
	AdminSocketPath string
	// HealthAddr is the listen address for the out-of-band HTTP `/healthz`
	// endpoint (Phase 3, §4.2). The gateway shares the `nats` docker network
	// with the mini-infra server, which scrapes this on the gateway's
	// container IP. Defaults to ":9751"; override via EGRESS_GATEWAY_HEALTH_ADDR.
	HealthAddr string
	// LogLevel controls verbosity.
	LogLevel string
}

// LoadGatewayConfig loads GatewayConfig from environment variables.
func LoadGatewayConfig() GatewayConfig {
	proxyPort := os.Getenv("PROXY_PORT")
	if proxyPort == "" {
		proxyPort = "3128"
	}
	adminSocket := os.Getenv("GATEWAY_ADMIN_SOCKET")
	if adminSocket == "" {
		adminSocket = "/var/run/mini-infra/gw.sock"
	}
	healthAddr := os.Getenv("EGRESS_GATEWAY_HEALTH_ADDR")
	if healthAddr == "" {
		healthAddr = ":9751"
	}
	return GatewayConfig{
		ProxyPort:       proxyPort,
		NatsCredsFile:   os.Getenv("NATS_CREDS_FILE"),
		AdminSocketPath: adminSocket,
		HealthAddr:      healthAddr,
		LogLevel:        os.Getenv("LOG_LEVEL"),
	}
}
