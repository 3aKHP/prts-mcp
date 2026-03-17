# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-03-18

### Added

- FastMCP server with 4 tools: `search_prts`, `read_prts_page`, `get_operator_archives`, `get_operator_voicelines`
- PRTS MediaWiki API integration with rate limiting and custom User-Agent
- Local ArknightsGameData JSON reader with LRU caching (character_table, handbook_info_table, charword_table)
- Wikitext sanitizer for stripping templates, file links, and HTML tags
- Config module with env var / local_repo.jsonc fallback
- Dockerfile for stdio-based containerized deployment
- Project metadata via pyproject.toml (PEP 621)
