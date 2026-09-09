FROM node:20-slim

# Install system ffmpeg and necessary libraries
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

RUN mkdir -p uploads output data && chmod -R 777 uploads output data

ENV PORT=7860
EXPOSE 7860

CMD ["node", "--max-old-space-size=256", "server.js"]
