FROM oven/bun:1-debian

RUN apt install ffmpeg

WORKDIR /app

COPY package.json ./
COPY bun.lock ./
COPY src ./

RUN bun install

CMD ["bun", "."]
