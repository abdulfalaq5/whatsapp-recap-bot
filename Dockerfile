FROM node:20-slim

# better-sqlite3 butuh build tools untuk native binding
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY src ./src

# Volume mount points untuk data yang perlu persist
VOLUME ["/app/auth_session", "/app/data"]

CMD ["node", "src/index.js"]
