---
name: comparative-evaluation
description: Plan and run reproducible A/B or A/B/C benchmark comparisons of code, services, functions, tool descriptions, or configurations in an isolated environment, preserving quantitative evidence and private topology boundaries.
---

# Comparative evaluation

Use the repository's [comparative evaluation guide](../../../docs/dev/COMPARATIVE-EVALUATION.md) as the public SOP and `tools/experiments/experiment.py` as the executor, relative to the repository root. This applies to quality and correctness metrics as well as performance.

Select the benchmark and measurement unit from the actual question. Fix the compared artifact identities, inputs, evaluator/runtime versions, metrics, guardrails, schedule and budgets before collecting measurements. Use output equivalence only when the benchmark requires it. Do not treat the offline description coverage demo as an Agent evaluation or an implementation of an upstream research benchmark.

Resolve the private environment via `--profile`, `EXPERIMENT_PROFILE`, or the plan's `environment`, in that order. Read the selected `operations` document with `preview`; use `doctor` before execution. For a fork without private configuration, `init` produces an offline local demo plus an operations manual. Remote templates require the contributor's own completed topology. Never infer a maintainer host, copy a private topology into tracked files, or treat `ready=true` as authorization.

Preserve frozen inputs and append-only attempts. Resume valid measurements without repeating them; explicit retries retain failed attempts and obey registered limits. Changes to the method or runtime need a new linked experiment. Inspect complete results, failures and guardrails before drawing a conclusion; report the scope and uncertainty supported by the data.

Use the allowlisted export for sharing, inspect its public identifiers, and keep raw logs and full archives private. Archive and verify evidence before owned cleanup. Follow the repository's normal PR and review workflow when promoting a change; this skill grants no additional execution, spending or merge authority.
