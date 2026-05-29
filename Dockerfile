FROM node:20-alpine

WORKDIR /app

# Runtime dependencies:
#   • curl         — used by news-extract.js as a Cloudflare-bypass fallback
#                    for the Gizbot listing scrape. Cloudflare fingerprints
#                    Node's undici TLS client and 403s it; curl ships OpenSSL
#                    with a real-browser-like fingerprint and is allowed
#                    through. Without curl the Gizbot feed fails at the
#                    listing fetch with `spawn curl ENOENT` (other feeds keep
#                    working — they don't need this fallback).
#   • libc6-compat — defensive: if a future sharp version drops the fully-
#                    vendored linuxmusl binary, the prebuilt would fail to
#                    load on Alpine without this. ~80KB.
#                    See: https://sharp.pixelplumbing.com/install#alpine-linux
RUN apk add --no-cache curl libc6-compat

COPY api/package*.json ./
RUN npm ci --omit=dev

COPY api/ .
COPY news_rss_feeds.json /app/news_rss_feeds.json

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "src/index.js"]
