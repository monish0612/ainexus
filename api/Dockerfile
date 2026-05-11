FROM node:20-alpine

WORKDIR /app

# libc6-compat is required for the prebuilt `sharp` (image processing)
# linuxmusl binaries to load on Alpine. Tiny package (~80KB) and
# strictly cheaper than the vips-dev / build-base / node-gyp source
# rebuild path.
# See: https://sharp.pixelplumbing.com/install#alpine-linux
RUN apk add --no-cache libc6-compat

COPY package*.json ./
# `npm ci` keeps optionalDependencies by default (we DO want sharp).
# Only `--omit=optional` would skip them.
RUN npm ci --omit=dev

COPY . .

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "src/index.js"]
