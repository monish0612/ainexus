FROM node:20-alpine

WORKDIR /app

# Runtime dependencies:
#   • libc6-compat — required for the prebuilt `sharp` (image processing)
#                    linuxmusl binaries to load on Alpine.
#                    See: https://sharp.pixelplumbing.com/install#alpine-linux
#   • curl         — used by news-extract.js as a Cloudflare-bypass fallback
#                    for the Gizbot listing scrape. Cloudflare fingerprints
#                    Node's undici TLS client and 403s it; curl ships OpenSSL
#                    with a real-browser-like fingerprint and is allowed
#                    through. Without curl the Gizbot feed fails at the
#                    listing fetch with `spawn curl ENOENT` (other feeds keep
#                    working — they don't need this fallback).
RUN apk add --no-cache libc6-compat curl

COPY package*.json ./
# `npm ci` keeps optionalDependencies by default (we DO want sharp).
# Only `--omit=optional` would skip them.
RUN npm ci --omit=dev

COPY . .
# RSS/listing feed list MUST live in this folder (`news_rss_feeds.json`).
# Coolify builds with context `./api` never see the repo-root copy, and an
# empty feed list is exactly how X/Twitter still arrives while movies/news
# stay blank.

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "src/index.js"]
