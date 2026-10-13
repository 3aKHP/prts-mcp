# PRTS-MCP Roadmap

Public stable remains 2.8.1. The next development target is 3.0.0-dev.0: migrate to one native Rust implementation, retaining the frozen TS/v2.8.1 product contract. [中文](ROADMAP.zh-CN.md).

## 3.0 migration

| Phase | Work |
| --- | --- |
| M0 | Freeze scope, entry defaults, root layout, LTS and distribution decisions. Complete. |
| M1A | Preserve lts/2.8 and isolate maintenance publishers from stable latest. Complete. |
| M1B | Import Rust history, establish root Cargo tree, remove old source directories, repair minimum CI/scripts/docs. Completed, PR #228 merged. |
| M2A/B/C | Five-platform native build/run evidence, shared npm payload and both entry packages, dual-architecture Docker. |
| M3 | Candidate artifacts, single-version checks and isolated release automation. |
| M4 | Real-client E2E with actual candidate artifacts, old volumes, upgrade and rollback, Windows and/or WSL. |
| M5 | RC closure, stable 3.0, latest switches and development back-merge. |

M2A is in progress; native artifact baselines and exact evidence are maintained in [NATIVE-PLATFORMS.md](docs/dev/NATIVE-PLATFORMS.md).

Detailed decisions, acceptance criteria and scope: [migration plan](docs/dev/plans/3.x-rust-migration.md). M1B is not a public release or a five-platform support claim. Full real-machine E2E is specifically scheduled for M4, not a general workflow gate.

## After 3.0

Management CLI, new tools/data domains, recruitment lookup, image/PNG work, caching/storage evaluation, data recovery and AKDP coordination are deferred until migration completes. Other still-useful candidates from the [previous roadmap archive](docs/dev/legacy/2.x/ROADMAP.md) remain a backlog, with no 2.9 or 3.0 delivery promise. Reprioritize one topic at a time after M5.

Prepare independent Cargo source packaging during M1–M2; publish on crates.io as a separate post-M5 channel task, without waiting for 3.1 or expanding into an SDK.

## Maintenance policies

lts/2.8 and lts/1.7 both end 2027-07-02, accept maintenance fixes only and cannot advance stable latest. Historic release versions/tags remain immutable. Cross-version protocol support and compatibility obligations remain in [VERSIONING](docs/dev/VERSIONING.md); LTS rules in [LTS](docs/dev/LTS.md). Applicable old-line fixes are individually ported to Rust, never whole-branch merged.
