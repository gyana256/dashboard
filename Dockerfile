# Lightweight production image
FROM node:20-alpine
ENV NODE_ENV=production \
	DATA_DIR=/app
WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install --production

# Copy application source
COPY . .

# NOTE: Removed VOLUME instruction. Declaring a volume at /app would hide node_modules at runtime.
# If you need persistent DB storage, mount an external volume to /app or set DATA_DIR.

EXPOSE 3000
CMD ["npm","start"]
