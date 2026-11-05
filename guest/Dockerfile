# Trusted sandbox runtime image.
#
# Contains only:
#   - the Go guest runtime (x402-guest)
#   - python3 + ca-certificates (fixed, operator-controlled toolchain)
#   - a network probe used exclusively by the security test suite
#
# Customers never supply an image, a command, or a PodSpec.
FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/x402-guest ./ && \
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/x402-netprobe ./cmd/netprobe

FROM alpine:3.21
RUN apk add --no-cache python3 ca-certificates \
 && addgroup -g 65532 -S sandbox \
 && adduser -u 65532 -S -G sandbox -h /tmp sandbox
COPY --from=build /out/x402-guest /usr/local/bin/x402-guest
COPY --from=build /out/x402-netprobe /usr/local/bin/x402-netprobe
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/x402-guest"]
CMD ["run"]
