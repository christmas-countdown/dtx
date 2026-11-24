import {
  type GatewayVoiceServerUpdateDispatchData,
  type GatewayVoiceStateUpdateDispatchData,
} from "discord-api-types/v10";

export type DtxWsMessage =
  | {
      signal: "join";
      guildId: string;
      channelId: string;
    }
  | {
      signal: "suspend";
      guildId: string;
    }
  | {
      signal: "resume";
      guildId: string;
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
