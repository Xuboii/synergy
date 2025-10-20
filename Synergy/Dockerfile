# Node/socket.io service
FROM node:20-alpine

WORKDIR /app

# Install only production deps
COPY package*.json ./
RUN npm ci --omit=dev

# Copy the rest
COPY . .

# Cloud Run will inject PORT=8080; your server reads process.env.PORT
ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080
CMD ["node", "index.js"]
