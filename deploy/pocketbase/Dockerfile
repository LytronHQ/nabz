# PocketBase, built from the official pinned release binary — not a third-party
# :latest image. Version and (optionally) checksum come in as build args so the
# built image is reproducible and auditable.
#
#   docker build --build-arg PB_VERSION=0.28.4 \
#     [--build-arg PB_SHA256=<sha256 of the linux_amd64 zip>] -t nabz-pocketbase .
#
# PocketBase ships a static (CGO-free) linux binary, so a small alpine runtime is
# enough — we just add ca-certificates (outbound TLS: SMTP, S3/R2 backups), wget
# for the compose healthcheck (busybox wget), and sqlite for the maintenance
# pragmas (#322), which PocketBase exposes no API for.
ARG PB_VERSION=0.28.4

FROM alpine:3.20 AS build
ARG PB_VERSION
# Hetzner/x86 servers are amd64; override for arm builds.
ARG PB_ARCH=amd64
ARG PB_SHA256=""
RUN apk add --no-cache curl unzip
WORKDIR /tmp
RUN set -eux; \
    url="https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}/pocketbase_${PB_VERSION}_linux_${PB_ARCH}.zip"; \
    curl -fsSL -o pb.zip "$url"; \
    if [ -n "$PB_SHA256" ]; then echo "${PB_SHA256}  pb.zip" | sha256sum -c -; fi; \
    unzip -q pb.zip -d /pb; \
    test -x /pb/pocketbase

FROM alpine:3.20
RUN apk add --no-cache ca-certificates wget sqlite
COPY --from=build /pb/pocketbase /usr/local/bin/pocketbase
EXPOSE 8090
VOLUME /pb_data
# Bind all interfaces inside the container; the compose file maps the port. Data
# lives on the mounted volume so it survives image rebuilds/upgrades.
ENTRYPOINT ["/usr/local/bin/pocketbase"]
CMD ["serve", "--http=0.0.0.0:8090", "--dir=/pb_data"]
