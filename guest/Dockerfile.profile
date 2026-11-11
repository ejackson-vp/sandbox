ARG RUNTIME_IMAGE=alpine:3.21@sha256:bc21487101ae47172509130ee1092cc273a831968d64b617776d1f69c81e42ab
FROM ${RUNTIME_IMAGE} AS runtime

FROM golang:1.27.3-alpine@sha256:fa3d596898d9f126af7c01d14ee7597bab3f39cccf392ef36b69fe77cd681f18 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/x402-guest ./ && \
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/x402-netprobe ./cmd/netprobe

FROM alpine:3.21@sha256:bc21487101ae47172509130ee1092cc273a831968d64b617776d1f69c81e42ab
ARG PROFILE=python
RUN apk add --no-cache bash coreutils findutils procps git curl tar gzip ca-certificates \
    sqlite-libs openssl libffi bzip2 xz-libs zlib ncurses-libs readline libgcc libstdc++ \
 && addgroup -g 65532 -S sandbox \
 && adduser -u 65532 -S -G sandbox -h /tmp sandbox
COPY --from=build /out/x402-guest /usr/local/bin/x402-guest
COPY --from=build /out/x402-netprobe /usr/local/bin/x402-netprobe
COPY --from=runtime /usr/local/ /runtimes/${PROFILE}/
COPY profiles/${PROFILE}.json /runtimes/${PROFILE}/profile.json
# The Node image ships an npm tree with known HIGH advisories. Pin the fixed
# npm release so the profile scan is clean without dropping package tooling.
RUN if [ "${PROFILE}" = "node" ]; then \
      PATH=/runtimes/node/bin:/usr/local/bin:/usr/bin:/bin \
      npm_config_prefix=/runtimes/node \
      /runtimes/node/bin/npm install -g npm@12.2.2; \
    fi
ENV RUNTIME_PROFILE=${PROFILE} \
    RUNTIMES_DIR=/runtimes \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/x402-guest"]
CMD ["run"]
