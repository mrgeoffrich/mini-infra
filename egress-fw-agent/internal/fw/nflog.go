// Package fw manages host firewall rules for the egress-fw-agent.
// This file implements the NFLOG group 1 subscriber using github.com/florianl/go-nflog/v2
// which is a pure-Go netlink binding (no cgo required).
package fw

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

	nflog "github.com/florianl/go-nflog/v2"
	"github.com/google/gopacket"
	"github.com/google/gopacket/layers"

	"github.com/mrgeoffrich/mini-infra/egress-fw-agent/internal/events"
	"github.com/mrgeoffrich/mini-infra/egress-shared/natsbus"
	"github.com/mrgeoffrich/mini-infra/egress-shared/state"
)

const (
	nflogGroupID    = 1
	nflogPrefixDrop = "mini-infra-egress-drop "
	nflogReasonDrop = "non-allowed-egress"
)

// nonIPv4RateLimit implements a simple once-per-minute rate limiter for the
// non-IPv4 packet log line so it doesn't spam when IPv6 traffic is present.
type nonIPv4RateLimit struct {
	mu      sync.Mutex
	lastLog time.Time
}

func (r *nonIPv4RateLimit) shouldLog() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := time.Now()
	if now.Sub(r.lastLog) >= time.Minute {
		r.lastLog = now
		return true
	}
	return false
}

// NflogReader subscribes to NFLOG group 1 and emits fw_drop events.
//
// ALT-27: events go to JetStream `mini-infra.egress.fw.events` via the
// supplied bus. The legacy stdout NDJSON path has been removed — the
// server's log-attach ingester is replaced by a JetStream durable consumer
// (`EgressFwEvents-server`) that resumes from its last-acked position
// across container restarts. That's the source of the "≤1s loss across
// restart" acceptance criterion.
//
// `bus` is nullable so the legacy Unix-socket transport (kept behind a
// feature flag for one release; see Stage D12) can still run NflogReader
// without a NATS connection. When nil, fw_drop events are dropped on the
// floor with a once-per-minute warn — the legacy stdout path is gone, so
// consumers MUST use NATS.
type NflogReader struct {
	containerMap   *state.ContainerMap
	dedup          *events.Deduplicator
	log            *slog.Logger
	bus            *natsbus.Bus
	nonIPv4Limiter nonIPv4RateLimit
	noBusWarner    nonIPv4RateLimit
}

// NewNflogReader creates a new NflogReader.
func NewNflogReader(cm *state.ContainerMap, log *slog.Logger, bus *natsbus.Bus) *NflogReader {
	return &NflogReader{
		containerMap: cm,
		dedup:        events.NewDeduplicator(),
		log:          log,
		bus:          bus,
	}
}

// Run starts the NFLOG subscription and blocks until ctx is cancelled.
// It also starts a background goroutine to prune the dedup table every minute.
func (r *NflogReader) Run(ctx context.Context) error {
	cfg := nflog.Config{
		Group:    nflogGroupID,
		Copymode: nflog.CopyPacket,
	}

	nf, err := nflog.Open(&cfg)
	if err != nil {
		return fmt.Errorf("nflog.Open: %w", err)
	}
	defer nf.Close()

	// Background dedup pruner.
	go func() {
		t := time.NewTicker(time.Minute)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				r.dedup.Prune()
			}
		}
	}()

	r.log.Info("NFLOG reader started", "group", nflogGroupID)

	errCh := make(chan error, 1)
	fn := func(attrs nflog.Attribute) int {
		r.handlePacket(attrs)
		return 0
	}

	if err := nf.RegisterWithErrorFunc(ctx, fn, func(e error) int {
		r.log.Error("NFLOG error", "err", e)
		errCh <- e
		return 1
	}); err != nil {
		return fmt.Errorf("nflog.Register: %w", err)
	}

	select {
	case <-ctx.Done():
		r.log.Info("NFLOG reader stopped")
		return nil
	case err := <-errCh:
		return err
	}
}

// handlePacket processes a single NFLOG-captured packet.
func (r *NflogReader) handlePacket(attrs nflog.Attribute) {
	// Only handle packets with our specific prefix.
	prefix := ""
	if attrs.Prefix != nil {
		prefix = *attrs.Prefix
	}
	if prefix != nflogPrefixDrop {
		return
	}

	payload := []byte{}
	if attrs.Payload != nil {
		payload = *attrs.Payload
	}
	if len(payload) == 0 {
		return
	}

	// Decode IP header.
	srcIP, dstIP, dstPort, proto, err := decodeL3L4(payload)
	if err != nil {
		// Log non-IPv4 packets at Info (once per minute) so operators can see
		// that IPv6 traffic is hitting the rule without spamming the log.
		// IPv6 is documented out-of-scope for this implementation.
		version := uint8(0)
		if len(payload) > 0 {
			version = payload[0] >> 4
		}
		if version != 4 && r.nonIPv4Limiter.shouldLog() {
			r.log.Info("NFLOG: non-IPv4 packet silently dropped (IPv6 out of scope)",
				"srcAddrFamily", fmt.Sprintf("ip_version=%d", version),
				"err", err,
			)
		} else {
			r.log.Debug("Failed to decode packet", "err", err)
		}
		return
	}

	// Look up container identity.
	var stackID *string
	var serviceName *string
	if attr := r.containerMap.Lookup(srcIP); attr != nil {
		s := attr.StackID
		sn := attr.ServiceName
		stackID = &s
		serviceName = &sn
	}

	key := events.DedupKey{
		SrcIp:    srcIP,
		DestIp:   dstIP,
		DestPort: dstPort,
		Protocol: proto,
	}

	emit, hits := r.dedup.ShouldEmit(key)
	if !emit {
		return
	}

	if r.bus == nil {
		// Legacy transport mode (no NATS). Warn rate-limited so the
		// operator notices but the log isn't flooded.
		if r.noBusWarner.shouldLog() {
			r.log.Warn("NFLOG event dropped — bus not configured (legacy transport mode)")
		}
		return
	}

	evt := natsbus.EgressFwEvent{
		OccurredAtMs: time.Now().UnixMilli(),
		Protocol:     proto,
		SrcIp:        srcIP,
		DestIp:       dstIP,
		Reason:       nflogReasonDrop,
		MergedHits:   uint32(hits),
	}
	if dstPort != 0 {
		port := dstPort
		evt.DestPort = &port
	}
	if stackID != nil {
		evt.StackId = *stackID
	}
	if serviceName != nil {
		evt.ServiceName = *serviceName
	}
	if _, err := r.bus.JSPublish(natsbus.SubjectEgressFwEvents, evt); err != nil {
		// JS publish can fail during a NATS reconnect window. The bus
		// SDK buffers up to its ReconnectBufSize; beyond that we drop
		// rather than block the NFLOG read loop. Log warn rate-limited.
		if r.noBusWarner.shouldLog() {
			r.log.Warn("NFLOG event JS publish failed", "err", err.Error())
		}
	}
}

// decodeL3L4 extracts (srcIP, dstIP, dstPort, protocol) from a raw IPv4 packet.
func decodeL3L4(payload []byte) (srcIP, dstIP string, dstPort uint16, proto string, err error) {
	if len(payload) < 20 {
		return "", "", 0, "", fmt.Errorf("packet too short (%d bytes)", len(payload))
	}

	// First nibble of the first byte is the IP version.
	version := payload[0] >> 4
	if version != 4 {
		return "", "", 0, "", fmt.Errorf("not IPv4 (version=%d)", version)
	}

	packet := gopacket.NewPacket(payload, layers.LayerTypeIPv4, gopacket.Default)

	ipLayer := packet.Layer(layers.LayerTypeIPv4)
	if ipLayer == nil {
		return "", "", 0, "", fmt.Errorf("no IPv4 layer decoded")
	}
	ip := ipLayer.(*layers.IPv4)
	srcIP = ip.SrcIP.String()
	dstIP = ip.DstIP.String()

	switch ip.Protocol {
	case layers.IPProtocolTCP:
		proto = "tcp"
		if tcpLayer := packet.Layer(layers.LayerTypeTCP); tcpLayer != nil {
			tcp := tcpLayer.(*layers.TCP)
			dstPort = uint16(tcp.DstPort)
		}
	case layers.IPProtocolUDP:
		proto = "udp"
		if udpLayer := packet.Layer(layers.LayerTypeUDP); udpLayer != nil {
			udp := udpLayer.(*layers.UDP)
			dstPort = uint16(udp.DstPort)
		}
	case layers.IPProtocolICMPv4:
		proto = "icmp"
	default:
		proto = fmt.Sprintf("proto%d", ip.Protocol)
	}

	return srcIP, dstIP, dstPort, proto, nil
}

