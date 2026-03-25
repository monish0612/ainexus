FROM node:20-alpine

WORKDIR /app

COPY api/package*.json ./
RUN npm ci --omit=dev

COPY api/ .
COPY news_rss_feeds.json /app/news_rss_feeds.json

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "src/index.js"]
