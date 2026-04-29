// Package config holds configuration types for the egress-fw-agent.
package config

import "os"

// AgentConfig holds runtime configuration for egress-fw-agent.
type AgentConfig struct {
	// SocketPath is the Unix-domain socket bound by the admin HTTP API.
	SocketPath string
	// LogLevel controls verbosity; parsed by the log package.
	LogLevel string
}

// LoadAgentConfig loads AgentConfig from environment variables.
func LoadAgentConfig() AgentConfig {
	socketPath := os.Getenv("FW_AGENT_SOCKET_PATH")
	if socketPath == "" {
		socketPath = "/var/run/mini-infra/fw.sock"
	}
	return AgentConfig{
		SocketPath: socketPath,
		LogLevel:   os.Getenv("LOG_LEVEL"),
	}
}
