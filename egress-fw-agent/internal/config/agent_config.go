// Package config holds configuration types for the egress-fw-agent.
package config

import "os"

// Transport is the agent's primary control-channel mode (ALT-27).
//
//   - "nats" (default): subscribes to mini-infra.egress.fw.rules.apply,
//     publishes events on JetStream EgressFwEvents, writes a 5 s
//     heartbeat into the egress-fw-health KV bucket. No Unix socket.
//   - "unix" (legacy fallback, kept for one release): runs the Unix-socket
//     HTTP admin API at SocketPath. Set MINI_INFRA_FW_AGENT_TRANSPORT=unix
//     to enable on rollback. Removal tracked as a follow-up issue.
type Transport string

const (
	TransportNats Transport = "nats"
	TransportUnix Transport = "unix"
)

// AgentConfig holds runtime configuration for egress-fw-agent.
type AgentConfig struct {
	// Transport selects between NATS (default) and the legacy Unix-socket
	// admin API. Toggled via MINI_INFRA_FW_AGENT_TRANSPORT.
	Transport Transport
	// SocketPath is the Unix-domain socket bound by the admin HTTP API
	// when Transport == "unix". Ignored under Transport == "nats".
	SocketPath string
	// NatsUrl / NatsCreds are injected via the stack template's dynamicEnv
	// (`nats-url` + `nats-creds`). Empty under Transport == "unix".
	NatsUrl   string
	NatsCreds string
	// LogLevel controls verbosity; parsed by the log package.
	LogLevel string
}

// LoadAgentConfig loads AgentConfig from environment variables.
func LoadAgentConfig() AgentConfig {
	transport := Transport(os.Getenv("MINI_INFRA_FW_AGENT_TRANSPORT"))
	if transport == "" {
		transport = TransportNats
	}

	socketPath := os.Getenv("FW_AGENT_SOCKET_PATH")
	if socketPath == "" {
		socketPath = "/var/run/mini-infra/fw.sock"
	}
	return AgentConfig{
		Transport:  transport,
		SocketPath: socketPath,
		NatsUrl:    os.Getenv("NATS_URL"),
		NatsCreds:  os.Getenv("NATS_CREDS"),
		LogLevel:   os.Getenv("LOG_LEVEL"),
	}
}
