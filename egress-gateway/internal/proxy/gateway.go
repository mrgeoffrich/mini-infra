package proxy

import (
	"net/http"
	"time"

	"github.com/sirupsen/logrus"
	smokescreen "github.com/stripe/smokescreen/pkg/smokescreen"
	"github.com/stripe/smokescreen/pkg/smokescreen/conntrack"

	"github.com/mrgeoffrich/mini-infra/egress-shared/state"
)

// GatewayOptions holds the knobs callers can tune when assembling the gateway
// handler. Production sets DenyRanges to BuiltinPrivateRanges; tests may pass
// nil DenyRanges and an explicit AllowRanges for loopback so they can dial
// httptest upstreams.
type GatewayOptions struct {
	DenyRanges  []smokescreen.RuleRange
	AllowRanges []smokescreen.RuleRange
}

// BuildGatewayHandler assembles the full proxy handler chain used in production:
// DoHGate → UnknownIPDenyHandler → Smokescreen. It also performs the ConnTracker
// initialisation that BuildProxy itself omits (that init lives in
// Smokescreen's StartWithConfig/runServer, which we don't call). Without this
// step, the first CONNECT request panics in smokescreen.dialContext when it
// dereferences a nil ConnTracker.
func BuildGatewayHandler(
	containers *state.ContainerMap,
	aclSwapper *ACLSwapper,
	logger *logrus.Logger,
	opts GatewayOptions,
) http.Handler {
	sk := smokescreen.NewConfig()
	sk.RoleFromRequest = RoleFromRequest(containers)
	sk.EgressACL = aclSwapper
	sk.DenyRanges = opts.DenyRanges
	sk.AllowRanges = opts.AllowRanges
	sk.ConnectTimeout = 10 * time.Second
	sk.Log = logger
	sk.AllowMissingRole = false

	sk.ShuttingDown.Store(false)
	sk.ConnTracker = conntrack.NewTracker(sk.IdleTimeout, sk.MetricsClient, sk.Log, sk.ShuttingDown, nil)

	return DoHGate(UnknownIPDenyHandler(smokescreen.BuildProxy(sk), containers))
}
