import { VoiceConnectionStatus } from "@discordjs/voice";
import { getActiveConnections } from "./listeners";
import ffmpeg from "./ffmpeg";

const FRAME_MS = 20;
const MAX_QUEUE_FRAMES = 100;
const INITIAL_BUFFER_MS = FRAME_MS * 10;

const frameQueue: Buffer[] = [];

// health-tracking metrics
let lastTickAt: number | null = null;
let maxGapMs = 0;
let starvedTicks = 0;
let overflowDrops = 0;
let minQueue = Infinity;
let maxQueue = 0;

let nextTick = performance.now() + INITIAL_BUFFER_MS;

function tick() {
  const now = performance.now();
  if (lastTickAt !== null) {
    const gap = now - lastTickAt;
    if (gap > maxGapMs) maxGapMs = gap;
  }
  lastTickAt = now;
  if (frameQueue.length < minQueue) minQueue = frameQueue.length;
  if (frameQueue.length > maxQueue) maxQueue = frameQueue.length;
  const frame = frameQueue.shift();
  if (frame) {
    for (const conn of getActiveConnections()) {
      if (conn.state.status !== VoiceConnectionStatus.Ready) continue;
      conn.playOpusPacket(frame);
    }
  } else {
    starvedTicks++;
  }
  nextTick += FRAME_MS;
  if (nextTick < now) {
    nextTick = now + FRAME_MS;
  }
  setTimeout(tick, Math.max(0, nextTick - now));
}

setInterval(() => {
  const queueLength = `${Number.isFinite(minQueue) ? minQueue : frameQueue.length}..${frameQueue.length}..${maxQueue}`;
  const suboptimal = starvedTicks > 0 || overflowDrops > 0 || maxGapMs > 22;
  if (suboptimal) {
    console.warn(
      `[cast] queue=${queueLength} starved=${starvedTicks} drops=${overflowDrops} maxGap=${maxGapMs.toFixed(1)}ms`,
    );
  }
  starvedTicks = 0;
  overflowDrops = 0;
  maxGapMs = 0;
  minQueue = frameQueue.length;
  maxQueue = frameQueue.length;
}, 1000);

export async function startBroadcast() {
  /**
   * A socket or stdout stream only works if the Opus frames are contained in Ogg/WebM.
   * Datagrams allow pure frames to be delivered discretely.
   */
  const socket = await Bun.udpSocket({
    hostname: "127.0.67.87",
    port: 6787,
    socket: {
      data(socket, frame) {
        if (frame.byteLength === 0) return;
        if (frameQueue.length >= MAX_QUEUE_FRAMES) {
          overflowDrops++;
          frameQueue.shift();
        }
        frameQueue.push(frame);
      },
    },
  });
  const ffproc = Bun.spawn(ffmpeg, {
    stdout: "ignore",
    stderr: "inherit",
  });
  setTimeout(tick, INITIAL_BUFFER_MS);
  const cleanup = () => {
    if (!socket.closed) socket.close();
    if (!ffproc.killed) ffproc.kill(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGKILL", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("exit", cleanup);
}
