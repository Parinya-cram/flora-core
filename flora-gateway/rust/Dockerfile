# One image carries every Rust gateway binary; compose picks one with `command`.
FROM rust:1-slim-bookworm AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential cmake pkg-config zlib1g-dev libudev-dev libcurl4-openssl-dev libssl-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked \
    && mkdir -p /out \
    && for bin in serial-controller feeder-controller webhook-controller socket-controller collector server publisher stream-hub; do \
         cp target/release/$bin /out/; \
       done

FROM debian:bookworm-slim
# socat is only used by the serial demo bridge (virtual COM port <-> TCP).
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl socat libudev1 libcurl4 libssl3 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/ /usr/local/bin/
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["docker-entrypoint.sh"]
