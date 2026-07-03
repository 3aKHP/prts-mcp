# Security Policy

## Supported Versions

PRTS-MCP maintains security fixes for the latest stable release line and the
1.7 LTS line.

| Version line | Security support |
|--------------|------------------|
| 2.x | Supported once released as the latest stable line. |
| 1.7.x | Supported as the LTS line for security, compatibility, data-sync, and critical fixes. |
| < 1.7 | Not supported. Please upgrade before reporting. |
| `dev` / prerelease builds | Best-effort fixes before release; not a production support line. |

## Reporting a Vulnerability

Please do not report security vulnerabilities through public GitHub issues.

Use one of these private channels:

1. Email `cccp1945@vip.qq.com` with the subject prefix
   `[PRTS-MCP security]`.
2. If GitHub Private Vulnerability Reporting is enabled for this repository,
   you may use GitHub's private reporting flow instead.

Reports in English or Chinese are welcome.

Please include as much of the following as you can:

- Affected package and version (`prts-mcp` Python package, `prts-mcp-ts` npm
  package, Docker image, or source branch).
- Runtime and transport (`Python stdio`, `TypeScript Streamable HTTP`, Docker,
  local install, or another deployment shape).
- A clear reproduction case or proof of concept.
- Expected impact, such as arbitrary file access, unsafe archive extraction,
  secret exposure, denial of service, or remote transport/session issues.
- Relevant logs, configuration, and environment variables with secrets removed.

## Scope

Security reports are most useful when they affect PRTS-MCP itself, including:

- MCP transport handling, session handling, or request parsing.
- Archive download, extraction, cache, or data-sync validation.
- Path traversal or unintended local file access.
- Unsafe parsing of PRTS Wiki, GameData, StoryJson, or packaged fallback data.
- Dependency vulnerabilities that are reachable through normal server use.
- Accidental exposure of tokens, paths, or sensitive configuration in package,
  Docker, CI, or example files.

The following are generally out of scope:

- Incorrect upstream game/wiki/story content.
- Availability of GitHub, PRTS Wiki, mirrors, or other external services.
- MCP client configuration mistakes outside this repository.
- Vulnerabilities that only affect unsupported versions.
- Automated scanning reports without a practical PRTS-MCP impact.

## Coordinated Disclosure

We aim to acknowledge valid reports within 7 days, then coordinate a fix and
release plan based on severity and affected release lines. Security fixes may
be released as patch versions on the latest stable line and, when applicable,
the 1.7 LTS line.

Please give the maintainer reasonable time to investigate and publish a fix
before public disclosure. Credit can be included in release notes or advisories
if you want to be acknowledged.

This project does not currently offer a bug bounty program.
