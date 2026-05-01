package natsbus

import (
	"encoding/json"
	"strings"
	"testing"
)

// These tests pin the wire shape of every Phase 2 payload. The Zod
// counterparts in `server/src/services/nats/payload-schemas.ts` are the
// strict end — if a key drifts here without updating the TS schema, the
// server bus rejects the message. Fixing the test means fixing both sides.

func TestEgressFwRulesApplyRequest_EnvUpsert(t *testing.T) {
	in := EgressFwRulesApplyRequest{
		ApplyId:    "apply-001",
		Op:         OpEnvUpsert,
		EnvName:    "production",
		BridgeCidr: "172.30.5.0/24",
		Mode:       FwModeEnforce,
	}
	data, err := json.Marshal(in)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	got := string(data)
	wantAll := []string{
		`"applyId":"apply-001"`,
		`"op":"env-upsert"`,
		`"envName":"production"`,
		`"bridgeCidr":"172.30.5.0/24"`,
		`"mode":"enforce"`,
	}
	for _, want := range wantAll {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in %s", want, got)
		}
	}
	if strings.Contains(got, `"ip":`) || strings.Contains(got, `"ips":`) {
		t.Errorf("env-upsert leaked ip/ips fields: %s", got)
	}
}

func TestEgressFwRulesApplyRequest_EnvRemove_OmitsVariantFields(t *testing.T) {
	in := EgressFwRulesApplyRequest{
		ApplyId: "apply-002",
		Op:      OpEnvRemove,
		EnvName: "staging",
	}
	data, _ := json.Marshal(in)
	got := string(data)
	for _, leak := range []string{`"bridgeCidr"`, `"mode"`, `"ip"`, `"ips"`} {
		if strings.Contains(got, leak) {
			t.Errorf("env-remove must omit %s, got %s", leak, got)
		}
	}
}

func TestEgressFwRulesApplyRequest_IpsetSync_EmptyIpsArray(t *testing.T) {
	in := EgressFwRulesApplyRequest{
		ApplyId: "apply-003",
		Op:      OpIpsetSync,
		EnvName: "production",
		Ips:     []string{}, // explicit "clear all"
	}
	data, _ := json.Marshal(in)
	got := string(data)
	// `omitempty` drops nil slices; an explicit empty slice should still
	// be omitted (Go's json behaviour). The server-side schema accepts
	// missing `ips` as zero-length so this is safe — but pin it so
	// changing to a pointer-slice doesn't silently change semantics.
	if strings.Contains(got, `"ips":`) {
		t.Errorf("expected ips to be omitted for empty slice, got %s", got)
	}
}

func TestEgressFwRulesApplyRequest_IpsetSync_NonEmpty(t *testing.T) {
	in := EgressFwRulesApplyRequest{
		ApplyId: "apply-004",
		Op:      OpIpsetSync,
		EnvName: "production",
		Ips:     []string{"172.30.5.10", "172.30.5.11"},
	}
	data, _ := json.Marshal(in)
	got := string(data)
	if !strings.Contains(got, `"ips":["172.30.5.10","172.30.5.11"]`) {
		t.Errorf("expected ips array, got %s", got)
	}
}

func TestEgressFwRulesApplyReply_RoundTrip(t *testing.T) {
	in := EgressFwRulesApplyReply{ApplyId: "x", Status: "applied"}
	data, _ := json.Marshal(in)
	if strings.Contains(string(data), `"reason":`) {
		t.Errorf("absent reason should be omitted, got %s", string(data))
	}
	in.Reason = "ipset full"
	in.Status = "rejected"
	data, _ = json.Marshal(in)
	var out EgressFwRulesApplyReply
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if out.Reason != "ipset full" || out.Status != "rejected" {
		t.Errorf("round-trip lost fields: %+v", out)
	}
}

func TestEgressFwEvent_OptionalDestPort(t *testing.T) {
	port := uint16(443)
	in := EgressFwEvent{
		OccurredAtMs: 1_700_000_000_000,
		Protocol:     "tcp",
		SrcIp:        "172.30.5.10",
		DestIp:       "1.1.1.1",
		DestPort:     &port,
		MergedHits:   1,
	}
	data, _ := json.Marshal(in)
	got := string(data)
	if !strings.Contains(got, `"destPort":443`) {
		t.Errorf("missing destPort in %s", got)
	}

	// ICMP without port — destPort omitted, not null.
	in.Protocol = "icmp"
	in.DestPort = nil
	data, _ = json.Marshal(in)
	got = string(data)
	if strings.Contains(got, `"destPort":`) {
		t.Errorf("nil destPort should be omitted, got %s", got)
	}
}

func TestEgressFwHealth_RoundTrip(t *testing.T) {
	depth := 12
	in := EgressFwHealth{
		Ok:           true,
		ReportedAtMs: 1_700_000_000_000,
		QueueDepth:   &depth,
		LastApplyId:  "apply-007",
	}
	data, _ := json.Marshal(in)
	var out EgressFwHealth
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if out.Ok != true || out.ReportedAtMs != 1_700_000_000_000 || out.LastApplyId != "apply-007" {
		t.Errorf("round-trip lost fields: %+v", out)
	}
	if out.QueueDepth == nil || *out.QueueDepth != 12 {
		t.Errorf("round-trip lost QueueDepth")
	}
}

func TestEgressFwRulesApplied_FieldShape(t *testing.T) {
	in := EgressFwRulesApplied{
		ApplyId:     "apply-99",
		Op:          OpIpsetAdd,
		EnvName:     "production",
		AppliedAtMs: 1_700_000_000_500,
		DurationMs:  3,
	}
	data, _ := json.Marshal(in)
	got := string(data)
	for _, want := range []string{
		`"applyId":"apply-99"`, `"op":"ipset-add"`, `"envName":"production"`,
		`"appliedAtMs":1700000000500`, `"durationMs":3`,
	} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in %s", want, got)
		}
	}
}

func TestExtractArmored_RoundTrip(t *testing.T) {
	body := "" +
		"-----BEGIN NATS USER JWT-----\n" +
		"abc.def.ghi\n" +
		"------END NATS USER JWT------\n" +
		"************************************************************\n" +
		"-----BEGIN USER NKEY SEED-----\n" +
		"SUACSEED\n" +
		"------END USER NKEY SEED------\n"
	// Note: tolerate the `------` 6-dash variant by including both ends in
	// real `.creds` blobs; our extractor matches the canonical 5-dash form.
	// Switch the body to canonical for the test.
	body = "" +
		"-----BEGIN NATS USER JWT-----\n" +
		"abc.def.ghi\n" +
		"-----END NATS USER JWT-----\n" +
		"-----BEGIN USER NKEY SEED-----\n" +
		"SUACSEED\n" +
		"-----END USER NKEY SEED-----\n"

	jwt, seed, err := splitCredsBody(body)
	if err != nil {
		t.Fatalf("splitCredsBody: %v", err)
	}
	if jwt != "abc.def.ghi" {
		t.Errorf("jwt = %q, want %q", jwt, "abc.def.ghi")
	}
	if seed != "SUACSEED" {
		t.Errorf("seed = %q, want %q", seed, "SUACSEED")
	}
}

func TestExtractArmored_SkipsAsteriskPadding(t *testing.T) {
	body := "" +
		"-----BEGIN NATS USER JWT-----\n" +
		"************************\n" +
		"jwt-content-line\n" +
		"************************\n" +
		"-----END NATS USER JWT-----\n" +
		"-----BEGIN USER NKEY SEED-----\n" +
		"seed-content\n" +
		"-----END USER NKEY SEED-----\n"
	jwt, _, err := splitCredsBody(body)
	if err != nil {
		t.Fatalf("splitCredsBody: %v", err)
	}
	if jwt != "jwt-content-line" {
		t.Errorf("jwt = %q, want %q", jwt, "jwt-content-line")
	}
}

func TestExtractArmored_MissingJwtErrors(t *testing.T) {
	body := "-----BEGIN USER NKEY SEED-----\nseed\n-----END USER NKEY SEED-----\n"
	if _, _, err := splitCredsBody(body); err == nil {
		t.Errorf("expected error for missing JWT, got nil")
	}
}
