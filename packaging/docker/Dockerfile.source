# M1B source-build development image. Published multi-arch packaging is M2C/M3.
FROM ubuntu:24.04 AS builder
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl build-essential && rm -rf /var/lib/apt/lists/*
ENV CARGO_HOME=/opt/cargo RUSTUP_HOME=/opt/rustup
ENV PATH=/opt/cargo/bin:$PATH
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain none --profile minimal
WORKDIR /build
COPY Cargo.toml Cargo.lock rust-toolchain.toml build.rs ./
COPY README.md LICENSE NOTICE ./
COPY contracts/data-declarations.json contracts/data-declarations.json
COPY src/ src/
COPY native/ native/
COPY vendor/ vendor/
RUN cargo build --locked --release --bin prts-mcp-ghcr

FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /build/target/release/prts-mcp-ghcr /app/bin/prts-mcp-ghcr
COPY LICENSE NOTICE /app/
COPY vendor/quickjs-regexp/NOTICES.txt /app/THIRD-PARTY-NOTICES.txt
ENV PRTS_MCP_ROOT=/app
RUN mkdir -p /app/data /data/gamedata /data/gamedata-levels /data/storyjson /data/images
ENTRYPOINT ["/app/bin/prts-mcp-ghcr"]
