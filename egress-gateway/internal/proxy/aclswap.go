// Package proxy implements the Smokescreen wrapper for the egress gateway.
package proxy

import (
	"sync/atomic"

	acl "github.com/stripe/smokescreen/pkg/smokescreen/acl/v1"
)

// ACLSwapper implements acl.Decider with hot-swap capability.
// A new *acl.ACL compiled from a policy push replaces the current one via Swap,
// with no locks and no dropped in-flight connections — the atomic pointer swap
// is safe for concurrent readers.
type ACLSwapper struct {
	p atomic.Pointer[acl.ACL]
}

// NewACLSwapper returns an ACLSwapper with a permissive default ACL.
// All decisions return Allow until the first Swap from a real policy push.
func NewACLSwapper() *ACLSwapper {
	s := &ACLSwapper{}
	// Initialise with an empty permissive ACL so the proxy works before the
	// first /admin/rules push.
	s.p.Store(emptyPermissiveACL())
	return s
}

// Decide implements acl.Decider.
func (s *ACLSwapper) Decide(args acl.DecideArgs) (acl.Decision, error) {
	return s.p.Load().Decide(args)
}

// Swap atomically replaces the current ACL with newACL.
// Callers (admin handler) call this after compiling a new policy snapshot.
func (s *ACLSwapper) Swap(newACL *acl.ACL) {
	s.p.Store(newACL)
}

// Current returns the currently active ACL (for testing / health checks).
func (s *ACLSwapper) Current() *acl.ACL {
	return s.p.Load()
}

// emptyPermissiveACL returns an ACL with no rules that allows all traffic
// in report mode — safe default until a real policy is pushed.
func emptyPermissiveACL() *acl.ACL {
	return &acl.ACL{
		Rules: make(map[string]acl.Rule),
		DefaultRule: &acl.Rule{
			Policy: acl.Report,
		},
	}
}
