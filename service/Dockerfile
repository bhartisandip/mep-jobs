FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

# No npm dependencies: only the app source is copied.
COPY package.json ./
COPY src ./src

# Volumes for the SQLite database and its backups, owned by the unprivileged user.
RUN mkdir -p /data /backups && chown node:node /data /backups
USER node

EXPOSE 3000
HEALTHCHECK --interval=60s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.js"]
