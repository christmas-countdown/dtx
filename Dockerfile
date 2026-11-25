FROM oven/bun:1-alpine

RUN apk add --no-cache ffmpeg

WORKDIR /app

COPY package.json ./
COPY bun.lock ./
COPY src ./

RUN bun install

CMD ["bun", "."]
