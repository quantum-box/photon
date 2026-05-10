FROM rust:1-bookworm AS builder

WORKDIR /app

COPY Cargo.toml Cargo.lock ./
COPY migrations ./migrations
COPY src ./src

RUN cargo build --release --locked

FROM debian:bookworm-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/target/release/photon-server /usr/local/bin/photon-server

ENV PORT=8080
ENV DATABASE_URL=sqlite:/tmp/photon.db?mode=rwc

EXPOSE 8080

CMD ["photon-server"]
