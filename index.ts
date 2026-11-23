import {
  entersState,
  joinVoiceChannel,
  getVoiceConnection,
  VoiceConnectionStatus,
  type DiscordGatewayAdapterCreator,
  type DiscordGatewayAdapterLibraryMethods,
  getVoiceConnections,
} from "@discordjs/voice";
import {
  type GatewayVoiceServerUpdateDispatchData,
  type GatewayVoiceStateUpdateDispatchData,
} from "discord-api-types/v10";

const FRAME_MS = 20;
const MAX_QUEUE_FRAMES = 3;

const opusQueue: Buffer[] = [];

const adapters = new Map<string, DiscordGatewayAdapterLibraryMethods>();

function createAdapter(
  guildId: string,
  shardId: string,
): DiscordGatewayAdapterCreator {
  return (methods) => {
    adapters.set(guildId, methods);
    return {
      sendPayload(payload) {
        server.publish(shardId, JSON.stringify(payload));
        return true;
      },
      destroy() {
        adapters.delete(guildId);
      },
    };
  };
}

const socket = await Bun.udpSocket({
  port: 6787,
  socket: {
    data(socket, frame) {
      if (frame.byteLength === 0) return;
      if (opusQueue.length >= MAX_QUEUE_FRAMES) opusQueue.shift();
      opusQueue.push(frame);
    },
  },
});

const server = Bun.serve({
  routes: {
    "/ws/:shardId": (req, server) => {
      const [, key] = (req.headers.get("authorization") ?? "").split(" ");
      if (key !== process.env.SECRET_KEY) {
        console.warn(
          "Unauthorized request from %s",
          server.requestIP(req)?.address,
        );
        return new Response("Unauthorized", { status: 401 });
      }

      const { shardId } = req.params;
      const upgraded = server.upgrade(req, { data: { shardId } });
      if (upgraded) return undefined;
      return new Response(null, { status: 400 });
    },
  },
  fetch() {
    return new Response("Hello world!");
  },
  websocket: {
    data: {} as {
      shardId: string;
    },
    idleTimeout: 300,
    open(ws) {
      console.log("shard %s connected", ws.data.shardId);
      ws.subscribe(ws.data.shardId);
    },
    message(ws, message) {
      const msg = JSON.parse(String(message)) as
        | {
            signal: "join";
            guildId: string;
            channelId: string;
          }
        | {
            signal: "leave";
            guildId: string;
          }
        | {
            signal: "upserver";
            d: GatewayVoiceServerUpdateDispatchData;
          }
        | {
            signal: "upstate";
            d: GatewayVoiceStateUpdateDispatchData;
          };
      switch (msg.signal) {
        case "join": {
          const { guildId, channelId } = msg;
          const connection = joinVoiceChannel({
            guildId,
            channelId,
            adapterCreator: createAdapter(guildId, ws.data.shardId),
          });
          entersState(connection, VoiceConnectionStatus.Ready, 10_000)
            .then((connection) => {
              connection.on(
                VoiceConnectionStatus.Disconnected,
                async (oldState, newState) => {
                  Promise.race([
                    entersState(
                      connection,
                      VoiceConnectionStatus.Signalling,
                      5_000,
                    ),
                    entersState(
                      connection,
                      VoiceConnectionStatus.Connecting,
                      5_000,
                    ),
                  ]).catch(() => connection.destroy());
                },
              );
            })
            .catch((error) => {
              connection.destroy();
              console.error(error);
            });
          break;
        }
        case "leave": {
          const { guildId } = msg;
          const connection = getVoiceConnection(guildId);
          connection?.destroy();
          break;
        }
        case "upserver": {
          const adapter = adapters.get(msg.d.guild_id);
          adapter?.onVoiceServerUpdate(msg.d);
          break;
        }
        case "upstate": {
          if (!msg.d.guild_id) break;
          const adapter = adapters.get(msg.d.guild_id);
          adapter?.onVoiceStateUpdate(msg.d);
          const connection = getVoiceConnection(msg.d.guild_id);
          if (!connection) break;
          // TODO: >=1 non-bot non-deafened listener
          // TODO: fix dangling connections on restart
          break;
        }
      }
    },
    close(ws, code, reason) {
      console.log(
        "shard %s disconnected (%d): '%s'",
        ws.data.shardId,
        code,
        reason,
      );
    },
    error(error, ws) {
      console.error(ws.data.shardId, error);
    },
  },
});

let nextTick = performance.now() + FRAME_MS;
let timer: ReturnType<typeof setTimeout> | null = null;

function tick() {
  const frame = opusQueue.shift();

  for (const [, conn] of getVoiceConnections()) {
    if (conn.state.status !== VoiceConnectionStatus.Ready) continue;

    // const canTransmit = hasActiveListeners(conn.joinConfig.guildId);
    // if (!canTransmit) {
    //   conn.setSpeaking(false);
    //   continue;
    // }

    if (frame) {
      conn.setSpeaking(true);
      conn.playOpusPacket(frame);
    }
  }

  // Advance target deadline and compensate for timer jitter
  nextTick += FRAME_MS;
  const now = performance.now();
  if (nextTick < now) {
    // If we fell behind by more than a tick, reset deadline so we don't spin rapidly
    nextTick = now + FRAME_MS;
  }

  timer = setTimeout(tick, Math.max(0, nextTick - now));
}

timer = setTimeout(tick, FRAME_MS);

process.on("SIGINT", () => {
  if (timer) clearTimeout(timer);
  socket.close();
  process.exit(0);
});
