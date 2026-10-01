# Cloud bot worker (Cloud Run worker pool). The website itself deploys to Netlify, not from this file.
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src
COPY server ./server
COPY worker ./worker
USER node
CMD ["node", "--import", "tsx", "worker/index.ts"]
