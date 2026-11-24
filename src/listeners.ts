import {
  getVoiceConnection,
  getVoiceConnections,
  type VoiceConnection,
} from "@discordjs/voice";

const SILENCE_FRAME = Buffer.from([0xf8, 0xff, 0xfe]);

export const activeConnections = new Set<VoiceConnection>();

function report() {
  console.log(
    `${activeConnections.size}/${getVoiceConnections().size} channels listening`,
  );
}

async function silence(connection: VoiceConnection) {
  try {
    for (let i = 0; i < 5; i++) {
      connection.playOpusPacket(SILENCE_FRAME);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } finally {
    connection.setSpeaking(false);
  }
}

export function resume(guildId: string) {
  const connection = getVoiceConnection(guildId);
  if (!connection) return;
  if (!activeConnections.has(connection)) {
    connection.setSpeaking(true);
    activeConnections.add(connection);
  }
  report();
}

export function suspend(guildId: string) {
  const connection = getVoiceConnection(guildId);
  if (!connection) return;
  if (activeConnections.has(connection)) {
    activeConnections.delete(connection);
    silence(connection); // this sets speaking=false
  }
  report();
}

export function getActiveConnections() {
  return activeConnections.values();
}
