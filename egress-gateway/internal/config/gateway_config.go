// Package config holds configuration types for the egress-gateway.
package config

import "os"

// GatewayConfig holds runtime configuration for the egress-gateway (Phase 3).
type GatewayConfig struct {
	// ProxyPort is the TCP port the forward proxy listens on.
	ProxyPort string
	// AdminSocketPath is the Unix-domain socket for the admin API.
	AdminSocketPath string
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
	return GatewayConfig{
		ProxyPort:       proxyPort,
		AdminSocketPath: adminSocket,
		LogLevel:        os.Getenv("LOG_LEVEL"),
	}
}
