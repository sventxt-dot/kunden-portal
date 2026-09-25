FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY public ./public

# Coolify setzt PORT (aktuell 80); der Server liest process.env.PORT.
EXPOSE 80
CMD ["node", "server/index.js"]
