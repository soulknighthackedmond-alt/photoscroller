# Photoscroller — tiny self-hosted image
FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

# install dependencies first so the layer caches between code changes
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY . .

# ffmpeg makes the still frame for every video — the thumbnail on its tile and the
# length shown on it. Alpine's build is about 70 MB installed. Without it the app still
# runs: it just falls back to each video's own first frame, which is what it did before.
RUN apk add --no-cache ffmpeg

# albums live here — mount a volume at /data to keep them across deploys
ENV DATA_DIR=/data
ENV PORT=3000
RUN mkdir -p /data/albums /data/posters && chown -R node:node /data /app
VOLUME ["/data"]

# Started as root on purpose: docker-entrypoint.js makes /data writable for the
# unprivileged "node" user (a bind-mounted volume arrives owned by root, which is
# what made the app exit at startup), then drops privileges before serving.
# PUID/PGID can be set to match the owner of a bind-mounted folder.
CMD ["node", "docker-entrypoint.js"]

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=4s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
