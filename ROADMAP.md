# PRTS-MCP Roadmap

Public stable remains 2.8.1. The next development target is 3.0.0-dev.0: migrate to one native Rust implementation, retaining the frozen TS/v2.8.1 product contract. [中文](ROADMAP.zh-CN.md).

## 3.0 migration

| Phase | Work |
| --- | --- |
| M0 | Freeze scope, entry defaults, root layout, LTS and distribution decisions. Complete. |
| M1A | Preserve lts/2.8 and isolate maintenance publishers from stable latest. Complete. |
| M1B | Import Rust history, establish root Cargo tree, remove old source directories, repair minimum CI/scripts/docs. Completed, PR #228 merged. |
| M2A/B/C | Five-platform native build/run evidence, shared npm payload and both entry packages, dual-architecture Docker. Complete. |
| M3 | Candidate artifacts, single-version checks and isolated release automation. Complete with public alpha.3. |
| M4 | Real-client E2E with actual candidate artifacts, old volumes, upgrade and rollback, Windows and/or WSL. |
| M5 | RC closure, stable 3.0, latest switches and development back-merge. |

M2A PR #229 is merged; baselines and exact evidence are maintained in [NATIVE-PLATFORMS.md](docs/dev/NATIVE-PLATFORMS.md). Data-source cleanup PR #230 is merged. M2B npm entries/shared native packages and validated fallback data pass all five native runners; see [npm distribution](docs/dev/NPM-DISTRIBUTION.md) and [acceptance evidence](docs/dev/reports/3.0-m2b-npm-distribution.md). M2C Docker/old-volume packaging passes native x64/ARM64 scoped runtime verification; see [Docker distribution](docs/dev/DOCKER-DISTRIBUTION.md) and [acceptance evidence](docs/dev/reports/3.0-m2c-docker-distribution.md).

M3 is complete with [public 3.0.0-alpha.3](https://github.com/3aKHP/prts-mcp/releases/tag/v3.0.0-alpha.3), all nine fresh OIDC publishes/provenance, dual-native GHCR and scoped public installation. [Acceptance and limits](docs/dev/reports/3.0-m3-candidate-release.md). M4 and data distribution/runtime acceptance are closed within the maintainer-approved scope; [the report](docs/dev/reports/3.0-m4-e2e.md) preserves unverified items and the local remediation of two execution incidents. Documentation restoration will be led by the maintainer before M5; neither that work nor M5 has started.

Two additional pre-3.0 release gates are required: a dedicated documentation pass restoring and updating still-applicable 2.x coverage, and a reviewed data/ source/distribution/runtime strategy with validation. They follow M2A without interrupting it and must close before stable release; data decisions that affect npm/Docker/candidate artifacts must land before those artifacts are accepted.

Detailed decisions, acceptance criteria and scope: [migration plan](docs/dev/plans/3.x-rust-migration.md). M1B is not a public release or a five-platform support claim. Full real-machine E2E is specifically scheduled for M4, not a general workflow gate.

## After 3.0

Management CLI, new tools/data domains, recruitment lookup, image/PNG work, caching/storage evaluation, data recovery and AKDP coordination are deferred until migration completes. Other still-useful candidates from the [previous roadmap archive](docs/dev/legacy/2.x/ROADMAP.md) remain a backlog, with no 2.9 or 3.0 delivery promise. Reprioritize one topic at a time after M5.

Prepare independent Cargo source packaging during M1–M2; publish on crates.io as a separate post-M5 channel task, without waiting for 3.1 or expanding into an SDK.

## Maintenance policies

lts/2.8 and lts/1.7 both end 2027-07-02, accept maintenance fixes only and cannot advance stable latest. Historic release versions/tags remain immutable. Cross-version protocol support and compatibility obligations remain in [VERSIONING](docs/dev/VERSIONING.md); LTS rules in [LTS](docs/dev/LTS.md). Applicable old-line fixes are individually ported to Rust, never whole-branch merged.
