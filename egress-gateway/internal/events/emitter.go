// Package events provides NDJSON event emission helpers.
package events

import (
	"encoding/json"
	"os"
	"sync"
	"time"
)

// FwDropEvent represents a firewall drop event emitted to stdout as NDJSON.
type FwDropEvent struct {
	Evt         string  `json:"evt"`           // always "fw_drop"
	Protocol    string  `json:"protocol"`      // "tcp", "udp", "icmp"
	Ts          string  `json:"ts"`            // RFC3339Nano timestamp
	SrcIp       string  `json:"srcIp"`
	DestIp      string  `json:"destIp"`
	DestPort    uint16  `json:"destPort"`
	StackId     *string `json:"stackId"`       // null when unknown
	ServiceName *string `json:"serviceName"`   // null when unknown
	Reason      string  `json:"reason"`        // e.g. "non-allowed-egress"
	MergedHits  int     `json:"mergedHits"`
}

var mu sync.Mutex

// EmitFwDrop writes a single fw_drop event as NDJSON to stdout.
// Writes are serialised via a mutex to prevent interleaved output.
func EmitFwDrop(evt FwDropEvent) error {
	evt.Evt = "fw_drop"
	if evt.Ts == "" {
		evt.Ts = time.Now().UTC().Format(time.RFC3339Nano)
	}
	if evt.MergedHits == 0 {
		evt.MergedHits = 1
	}

	b, err := json.Marshal(evt)
	if err != nil {
		return err
	}
	b = append(b, '\n')

	mu.Lock()
	defer mu.Unlock()
	_, err = os.Stdout.Write(b)
	return err
}
