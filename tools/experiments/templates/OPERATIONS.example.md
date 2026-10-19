# Private environment operations

Complete this document and its environment profile before setting `ready` to `true`. Store the completed files in your own ignored directory or outside the checkout. A fork does not need access to the upstream maintainer's infrastructure.

## Scope and access

Record the environment owner, permitted execution purpose, selected local/SSH/container driver and credential references. Keep credential values out of plans, command arguments and this document.

## Resource and isolation boundaries

Describe the dedicated working root, available disk and memory, CPU allocation, network access and any existing workloads that must remain healthy. Put machine-enforced limits in the profile. State which boundaries are conventions and which the environment actually enforces.

## Preparation and observation

Record how to provision the execution Python, selected container image if applicable, and required benchmark capabilities. The toolkit does not install dependencies, pull images or modify host-wide settings automatically. Describe how to check existing services before and after the experiment.

## Recovery and cleanup

Describe how to inspect retained logs, identify this experiment's owned workspace/container, recover from a lost connection and verify evidence backups. Cleanup must stay within that ownership boundary. Include any site-specific recovery steps for failed staging or unavailable hosts.

## Operational decisions

Record any constraints on long runs, network/API budgets and changes to this environment. Follow the current task's authorization and repository workflow for PRs, merges and publication.
