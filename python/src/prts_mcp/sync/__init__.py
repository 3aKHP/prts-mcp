"""GitHub Release data-sync tier.

The only layer permitted to issue HTTP. Holds the transport (HTTP / mirror
cascade) and release-discovery leaves extracted from ``data/sync``; the
release/archive/pair state machine still lives in ``data/sync`` until P2.B.
"""
