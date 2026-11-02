# Management CLI

[简体中文](cli.md)

`prtsctl` manages configuration, diagnoses local installations, inspects data and runs a single synchronization cycle. These commands are part of the developing 3.2.2 release; use the installed version's `--help` to check availability.

## Getting started

```bash
prtsctl config init
prtsctl config show --sources
prtsctl config validate
prtsctl doctor
prtsctl data sync
prtsctl data verify
prtsctl serve
```

Running `prtsctl` without arguments displays help. `serve` runs the server in the current process and defaults to HTTP across distribution channels. Use `prtsctl serve --transport stdio` for an MCP client subprocess. It does not daemonize: clients, Docker or system service managers own the process lifecycle.

Existing `prts-mcp`, `prts-mcp-ts*` and Docker entry points keep their no-argument behavior. They gain `--help`, `--version` and explicit `--config <path>` support, but do not automatically read the user configuration file. Native/npm main entries default to HTTP; PyPI/Docker server entries default to stdio; TS compatibility entries keep their fixed transports.

Native archives include `bin/prtsctl`. The main npm package, PyPI wheel and default Cargo installation provide it too. To install only the management binary from Cargo, use `cargo install prts-mcp --locked --bin prtsctl`. For Docker, use `docker run --rm --entrypoint /app/bin/prtsctl <image> --help`. Mount the same data volume and supply the corresponding environment when inspecting a deployment.

## Commands

| Command | Behavior |
| --- | --- |
| `config show [--sources]` | Show effective values, origins and explanations for this invocation |
| `config validate` | Validate file and resolved configuration; legacy environment parsing and fallbacks remain supported |
| `config init [--force] [--dry-run]` | Generate a commented template; replacing an existing file requires `--force` |
| `config set <key> <value> [--dry-run]` | Edit a field in an existing file |
| `config unset <key> [--dry-run]` | Remove a field; an absent field succeeds |
| `doctor [--network]` | Inspect local configuration, paths, source ownership and observable permission conditions |
| `data status` | Inspect local candidates, activation generations and fallback paths |
| `data verify` | Fully check SQLite, JSON/story ZIP and enabled local artwork |
| `data sync [--target game\|images\|all] [--wait-timeout <seconds>]` | Run once, without periodic polling |
| `serve [--transport http\|stdio] [--host <address>] [--port <number>]` | Run the MCP server in this process |
| `completion <bash\|zsh\|powershell>` | Generate a completion script for explicit user installation |

Management commands share `--config <path>` and `--output text|json` (`-o`), before or after subcommands. Names are case-sensitive, long options cannot be abbreviated, and both `--name value` and `--name=value` work. `--` ends option parsing.

Help, version and completion bypass business configuration. Read-only commands do not initialize a server, download assets or initialize data directories. `doctor --network` adds GitHub source and PRTS Wiki probes, with a five-second limit for each and no asset downloads. Permission checks do not create test files; uncertain access is reported as `unknown`.

`data status` uses `present_unverified` for readable metadata that has not passed a full integrity check. Its `available_backend` describes a local observation, not a running server's `/debug/metrics`. `data verify` may read large datasets and compute digests; failed checks return nonzero. SQLite inspection writes no admission cache. Have the writer close and checkpoint databases with nonempty WAL/journal files before inspecting them.

`data sync` defaults to game data. Explicit `images` or `all` requires `IMAGES_ENABLED=true` and `LOCAL_IMAGE=true`, and may download gigabytes. Custom read-only data is never overwritten. The shared lock-wait budget defaults to 30 seconds and accepts `0..86400`; zero means try immediately and fail on contention. Download time does not consume that budget. Network failure remains a failed synchronization even when cached data is usable. Ctrl+C or SIGTERM cancels new network work while allowing an active publication critical section to finish safely.

## Configuration

Precedence is **explicit arguments > environment > TOML file > defaults**. `--config` selects one file instead of layering it over the default file. A missing default file is allowed; a missing explicitly selected file is an error.

Automatic user file locations for `prtsctl`:

- Linux/macOS: `$XDG_CONFIG_HOME/prts-mcp/config.toml`, or `~/.config/prts-mcp/config.toml` when unset.
- Windows: `%APPDATA%\prts-mcp\config.toml`, falling back to `AppData\Roaming` under the user profile.

There is no working-directory search or automatic `.env` loading. Relative file paths resolve against the configuration file's directory. Relative environment and argument paths retain their current-directory meaning.

```toml
schema_version = 1

[runtime]
PRTS_TRANSPORT = "http"
HOST = "127.0.0.1"
PORT = 3000
PRTS_AUTO_SYNC_INTERVAL_SECONDS = 3600
LOCAL_IMAGE = false
```

`[runtime]` uses the business variable names from the [environment reference](environment-variables.md). The generated template documents every supported field. OS directory discovery, container layout and internal launcher settings are not editable file fields. Proxies and custom CA settings remain environment inputs; their origins appear in `config show -o json`.

Use TOML booleans, integer ports and synchronization seconds, and finite numbers for session milliseconds. Paths must be nonempty strings. Unknown fields, invalid enums and conflicting configuration are rejected. Leave unused template fields commented: explicit `PRTS_DATA_BACKEND = "sqlite"` disables automatic JSON fallback, and `GAMEDATA_PATH` disables corresponding JSON synchronization.

```bash
prtsctl --config ./server.toml config init
prtsctl --config ./server.toml config set PORT 3100
prtsctl --config ./server.toml config set runtime.HOST 127.0.0.1
prtsctl --config ./server.toml config unset PORT
prts-mcp --config ./server.toml
```

Edits preserve unrelated content and comments, serialize writers with a lock, and atomically replace the file. `--dry-run` writes neither files nor locks. Output indicates when an environment variable overrides the edited field. Editing symlink targets is rejected; name the actual file explicitly. Prefer environment variables for long-lived tokens: `config set` rejects token fields, and sensitive manual-file/environment values are redacted in output. Editing a file affects the next process that reads it.

## Scripts and shells

Text is the human-readable default. `-o json` emits one complete JSON document, with logs and errors on stderr. It is independent of the MCP tool setting `PRTS_OUTPUT_CHANNEL`; `serve` rejects `--output`.

Reports use stable English keys and native JSON number/boolean types. Collections remain arrays. Consumers should ignore additional fields and object key order; `schema_version` identifies the report structure. Existing field types and meanings follow the compatibility policy. Each `config show` field has `key`, `value`, `input`, `source` and `explanation`; sources are `argument`, `environment`, `file` or `default`.

```powershell
$raw = prtsctl config show -o json
if ($LASTEXITCODE -ne 0) { throw 'Configuration inspection failed' }
$config = $raw | ConvertFrom-Json
$config.fields | Where-Object { $_.source -eq 'environment' }
```

```bash
prtsctl config show -o json | jq '.fields[] | select(.source == "environment")'
```

Use `.\prtsctl.exe` for a native executable in the current Windows directory, or `./prtsctl` in Bash. Quote paths containing spaces. PowerShell `$env:NAME` and Bash `NAME=value command` are shell syntax; the CLI does not reinterpret them. Shell or pipe detection never changes output format.

For completion, write `prtsctl completion bash > prtsctl.bash` and run `source ./prtsctl.bash` in Bash. PowerShell users can save `prtsctl completion powershell` as a script and explicitly load it. The program never changes shell profiles automatically.

| Exit code | Meaning |
| --- | --- |
| `0` | Success; observations may still include warnings or unknown permissions |
| `1` | Operation or check failed |
| `2` | Invalid arguments or configuration |
| `3` | Synchronization lock-wait timeout |
| `130` / `143` | One-shot synchronization cancelled by Ctrl+C / SIGTERM where supported |

These codes apply to new management commands. Existing server entries retain their exit behavior. Background instance management, hot reload and data deletion are outside this CLI release.
