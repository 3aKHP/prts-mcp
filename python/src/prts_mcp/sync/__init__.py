"""GitHub Release data-sync tier.

The only layer permitted to issue HTTP. Holds the full sync state machine:
transport (HTTP / mirror cascade), release discovery, release-archive
activation, the release state machine, and the GameData-pair state machine.
``data/sync`` is now a pure re-export barrel.
"""
