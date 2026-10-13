# Contributing to PRTS-MCP

The 3.x development line is a native Rust project at repository root. Read [STATUS](STATUS.md), [development environment](docs/dev/ENVIRONMENT.md), [style](docs/dev/STYLE.md), [versioning](docs/dev/VERSIONING.md) and [review workflow](docs/dev/WORKFLOW.md). Python/TS maintenance lives on lts/2.8 and lts/1.7; both end on 2027-07-02.

Create a topic branch from develop and open a PR back to develop. LTS fixes branch from and target the corresponding LTS line. Do not push directly to long-lived branches or merge the old source tree into Rust. Applicable legacy fixes are ported and verified individually.

Build with cargo build --locked (Rust plus C compiler); run ./scripts/check-runtime.sh --full for scoped validation. Frozen comparison sources and data are rebuilt in ignored directories. Explain validation scope and any unverified platform or E2E stages in the PR. Standard changes require independent read-only review and KHPilot review; a human maintainer merges.

3.0 currently focuses on migration only. Management CLI and feature work follow 3.0. Binary/platform/npm/Docker publication is handled by subsequent migration phases; no 3.x public release exists at M1B.
