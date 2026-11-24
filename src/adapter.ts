import {
  type DiscordGatewayAdapterCreator,
  type DiscordGatewayAdapterLibraryMethods,
} from "@discordjs/voice";

export const adapters = new Map<string, DiscordGatewayAdapterLibraryMethods>();

export function createAdapter(
  server: Bun.Server<{
    shardId: string;
  }>,
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
