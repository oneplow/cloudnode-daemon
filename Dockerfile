FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copy source
COPY src/ ./src/

# Create data directory
RUN mkdir -p /opt/ghosting/data

EXPOSE 8443

CMD ["node", "src/index.js"]
