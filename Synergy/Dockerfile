FROM node:22-alpine

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev

# Copy everything in Synergy (including server + public)
COPY . .

# The static front-end will be under /app/public
COPY public ./public

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server/index.js"]
