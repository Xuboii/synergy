FROM node:22-alpine

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev

# Copy server files
COPY . .

# Copy your front-end assets
COPY ../public ./public

ENV PORT=8080
EXPOSE 8080

CMD ["node", "index.js"]
