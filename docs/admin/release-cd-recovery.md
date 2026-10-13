# Release CD recovery

M1B has removed the Python/TS publishing workflows from the Rust development tree. No 3.x public publisher exists until M3; v3.* tags currently do not publish npm, Docker, GitHub Releases or crates.io. Do not retry an old 2.x publisher against a Rust checkout.

2.8 maintenance publishers remain on lts/2.8 with branch/tag/EOL guards, npm lts-2.8, Docker 2 and GitHub make_latest=false. Their recovery procedure lives on the [LTS branch](https://github.com/3aKHP/prts-mcp/blob/lts/2.8/docs/admin/release-cd-recovery.md). 1.7 publishers remain on their own branch.

M3 will document recovery using exact candidate artifacts, checksums, publication ordering, immutable versions and channel isolation. This placeholder deliberately does not claim a working 3.x publication or allow a legacy workflow to advance latest.
