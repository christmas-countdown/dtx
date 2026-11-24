import { startBroadcast } from "./cast";
import { adapters, createAdapter } from "./adapter";
import type { DtxWsMessage } from "./types";
import {
  entersState,
  joinVoiceChannel,
  getVoiceConnection,
  VoiceConnectionStatus,
} from "@discordjs/voice";
import { activeConnections, resume, suspend } from "./listeners";

startBroadcast();

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
      const msg = JSON.parse(String(message)) as DtxWsMessage;
      switch (msg.signal) {
        case "join": {
          const { guildId, channelId } = msg;
          const connection = joinVoiceChannel({
            guildId,
            channelId,
            adapterCreator: createAdapter(server, guildId, ws.data.shardId),
          });
          connection.on(VoiceConnectionStatus.Ready, () => {
            resume(guildId);
          });
          connection.on(VoiceConnectionStatus.Destroyed, () => {
            activeConnections.delete(connection);
          });
          entersState(connection, VoiceConnectionStatus.Ready, 10_000)
            .then((connection) => {
              connection.on(VoiceConnectionStatus.Disconnected, () => {
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
              });
            })
            .catch((error) => {
              connection.destroy();
              console.error(error);
            });
          break;
        }
        case "suspend": {
          suspend(msg.guildId);
          break;
        }
        case "resume": {
          resume(msg.guildId);
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

process.on("SIGINT", () => {
  process.exit(0);
});
