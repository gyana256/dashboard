# Multi-stage build to ensure node_modules kept and lean runtime

FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
# Build deps (sqlite3 native) – safe even if prebuilt available
RUN apk add --no-cache python3 make g++ \
	&& npm install --omit=dev \
	&& npm cache clean --force

FROM node:20-alpine AS runner
ENV NODE_ENV=production \
		DATA_DIR=/app
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

EXPOSE 3000
CMD ["node","server.js"]
