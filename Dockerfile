# Lightweight production image
FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install --production

# Copy application source
COPY . .

# Ensure SQLite DB path is writable
VOLUME ["/app"]

EXPOSE 3000
CMD ["npm","start"]
