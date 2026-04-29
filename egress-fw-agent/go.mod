module github.com/mrgeoffrich/mini-infra/egress-fw-agent

go 1.25.0

require (
	github.com/florianl/go-nflog/v2 v2.3.0
	github.com/google/gopacket v1.1.19
	github.com/mrgeoffrich/mini-infra/egress-shared v0.0.0
)

replace github.com/mrgeoffrich/mini-infra/egress-shared => ../egress-shared

require (
	github.com/google/go-cmp v0.7.0 // indirect
	github.com/mdlayher/netlink v1.11.1 // indirect
	github.com/mdlayher/socket v0.6.0 // indirect
	golang.org/x/net v0.53.0 // indirect
	golang.org/x/sync v0.20.0 // indirect
	golang.org/x/sys v0.43.0 // indirect
)
