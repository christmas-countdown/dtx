import { VoiceConnectionStatus } from "@discordjs/voice";
import { getActiveConnections } from "./listeners";
import ffmpeg from "./ffmpeg";

const FRAME_MS = 20;
const QUEUE_TARGET_MS = 4e3;
const QUEUE_TARGET_FRAMES = QUEUE_TARGET_MS / FRAME_MS;
const QUEUE_MAX_MS = QUEUE_TARGET_MS * 1.5;
const QUEUE_MAX_FRAMES = QUEUE_MAX_MS / FRAME_MS;
const QUEUE_DRAIN_FRAMES = QUEUE_MAX_FRAMES - QUEUE_TARGET_FRAMES;

const frameQueue: Buffer[] = [];

// health-tracking metrics
let lastTickAt: number | null = null;
let gapSamples = 0;
let minGapMs = Infinity;
let maxGapMs = 0;
let sumGaps = 0;
let starvedTicks = 0;
let overflowDrops = 0;
let minQueue = Infinity;
let maxQueue = 0;

let nextTick = performance.now() + FRAME_MS;
let tickTimeout: ReturnType<typeof setTimeout> | null = null;

function tick() {
  const now = performance.now();
  if (lastTickAt !== null) {
    const gap = now - lastTickAt;
    sumGaps += gap;
    gapSamples++;
    if (gap < minGapMs) minGapMs = gap;
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
    /**
     * Return early to surrender tick control and allow the queue to build up to prevent running on the edge of empty,
     * which would cause starvation to continue to occur frequently.
     *
     * This also means that rather than continuing to run starved ticks, the tickrate falls.
     */
    starvedTicks++;
    lastTickAt = null;
    return;
  }
  nextTick += FRAME_MS;
  if (nextTick < now) {
    nextTick = now + FRAME_MS;
  }
  scheduleTick(Math.max(0, nextTick - now));
}

function scheduleTick(delay: number) {
  tickTimeout = setTimeout(() => {
    tickTimeout = null;
    tick();
  }, delay);
}

export async function startBroadcast() {
  const pc = (n: number) =>
    (
      ((Number.isFinite(n) ? n : frameQueue.length) / QUEUE_MAX_FRAMES) *
      100
    ).toFixed();
  setInterval(() => {
    const avgGapMs = gapSamples > 0 ? sumGaps / gapSamples : Infinity;
    const suboptimal =
      starvedTicks > 0 ||
      overflowDrops > 0 ||
      maxGapMs > FRAME_MS * 1.5 ||
      avgGapMs > FRAME_MS * 1.1;
    if (suboptimal) {
      const queueLength = `${pc(minQueue)}..${pc(frameQueue.length)}..${pc(maxQueue)}%`;
      const gaps = `${minGapMs.toFixed(1)}/${avgGapMs.toFixed(1)}/${maxGapMs.toFixed(1)}ms`;
      console.warn(
        `[cast] queue=${queueLength} starved=${starvedTicks} dropped=${overflowDrops} timing=${gaps}`,
      );
    }
    starvedTicks = 0;
    overflowDrops = 0;
    gapSamples = 0;
    minGapMs = Infinity;
    maxGapMs = 0;
    sumGaps = 0;
    minQueue = frameQueue.length;
    maxQueue = frameQueue.length;
  }, 1000);
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
        if (tickTimeout === null && frameQueue.length >= QUEUE_TARGET_FRAMES) {
          nextTick = performance.now() + FRAME_MS;
          scheduleTick(FRAME_MS);
        }
        if (frameQueue.length >= QUEUE_MAX_FRAMES) {
          /**
           * When ffmpeg begins streaming, it bursts far beyond real-time and fills the queue.
           * Under normal conditions, it continues streaming at the same rate as the internet source is producing,
           * but jitter can cause 1-2 frames to be dropped if the queue is constantly on the edge of being full.
           *
           * Draining the queue quickly creates a significant disruption, but focusses drops into a single large event
           * rather than dropping a tiny number of frames much more frequently.
           */
          overflowDrops += QUEUE_DRAIN_FRAMES;
          frameQueue.splice(0, QUEUE_DRAIN_FRAMES);
        }
        frameQueue.push(frame);
      },
    },
  });
  let ffproc: ReturnType<typeof Bun.spawn>;
  const spawn = () => {
    ffproc = Bun.spawn(ffmpeg, {
      stdout: "ignore",
      stderr: "inherit",
    });
    ffproc.exited.then((code) => {
      console.error("ffmpeg exited with code", code);
      setTimeout(spawn, 5e3);
    });
  };
  spawn();
  const cleanup = () => {
    if (!socket.closed) socket.close();
    if (!ffproc?.killed) ffproc.kill(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("exit", cleanup);
}
