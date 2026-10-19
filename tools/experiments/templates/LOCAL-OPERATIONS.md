# Local experiment operations

This profile runs trusted benchmark code as the current user in a dedicated working directory. It provides separate files and process-group cleanup on POSIX; it does not provide a filesystem or network sandbox. Use a VM or the container driver when the experiment needs those boundaries.

- Keep all writes inside the selected experiment workspace and evidence directory.
- Use only the declared artifacts. The offline examples require no network, elevated privileges, credentials or external services.
- Set trial timeouts, total execution budget, disk reserve and output limits in the profile before running.
- Leave unrelated processes, services, caches and system settings unchanged.
- After interruption, inspect the retained attempts and resume within the recorded retry policy. Changed tooling, inputs or configuration require a new experiment.
- Archive and verify current evidence before cleanup. Cleanup removes the tool-owned working data and preserves local raw evidence and frozen inputs.

These instructions describe this environment; selecting the profile does not grant permission for unrelated operations, paid APIs, publication or merging.
