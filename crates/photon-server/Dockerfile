# Build context is the repository root: this is a Cargo workspace build.
#   docker build -f crates/photon-server/Dockerfile .
FROM rust:1-bookworm AS builder
ARG PHOTON_SERVER_BIN=photon-server

WORKDIR /app

COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY examples/rust-sync-server ./examples/rust-sync-server

RUN cargo build --release --locked --bin ${PHOTON_SERVER_BIN} \
  && cp /app/target/release/${PHOTON_SERVER_BIN} /usr/local/bin/photon-server

FROM debian:bookworm-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /usr/local/bin/photon-server /usr/local/bin/photon-server

ENV PORT=8080
ENV DATABASE_URL=sqlite:/tmp/photon.db?mode=rwc

EXPOSE 8080

CMD ["photon-server"]
