# Trusted sandbox runtime image.
#
# Contains only:
#   - the Go session supervisor (x402-guest)
#   - a fixed, operator-controlled toolchain: python3 + pip, node + npm, bash,
#     tar, gzip, curl, git, coreutils, findutils, procps
#   - a network probe used exclusively by the security test suite
#
# Customers never supply an image, a command, or a PodSpec.
# Pinned to the patch that carries the stdlib fixes the image scan flagged
# (net/http, crypto/x509, crypto/tls). The module now requires go >= 1.26.
FROM golang:1.27.3-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/x402-guest ./ && \
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/x402-netprobe ./cmd/netprobe

FROM alpine:3.21
RUN apk add --no-cache python3 py3-pip nodejs npm bash tar gzip curl git ca-certificates coreutils findutils procps \
 && addgroup -g 65532 -S sandbox \
 && adduser -u 65532 -S -G sandbox -h /tmp sandbox
COPY --from=build /out/x402-guest /usr/local/bin/x402-guest
COPY --from=build /out/x402-netprobe /usr/local/bin/x402-netprobe
ENV PIP_NO_CACHE_DIR=1 \
    NPM_CONFIG_CACHE=/tmp/npm-cache
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/x402-guest"]
CMD ["run"]
