// openclaw-meshtastic
//
// Registers seven agent tools that talk to a running meshx daemon
// (https://github.com/retr0h/meshx) over its HTTP+SSE API. The daemon is
// expected to own the radio (USB / TCP / BLE) — this plugin is a pure
// HTTP client.
//
// AI disclosure: this plugin's initial scaffold was authored with AI
// assistance (OpenClaw / Claude). Every line is reviewed by a human
// before publication, per meshx's AI_POLICY.md.

import { Type, type Static } from "@sinclair/typebox";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
} from "openclaw/plugin-sdk/plugin-entry";

import {
  MeshxClient,
  MeshxRequestError,
  type ListRadiosOutputBody,
  type SendMessageRequest,
} from "./client.js";

// --- config ------------------------------------------------------------------

interface MeshtasticPluginConfig {
  baseUrl: string;
  defaultRadioId: string | null;
  timeoutMs: number;
  userAgent: string;
}

const DEFAULTS: MeshtasticPluginConfig = {
  baseUrl: "http://127.0.0.1:4404",
  defaultRadioId: null,
  timeoutMs: 5000,
  userAgent: "openclaw-meshtastic/0.1.0",
};

function resolveConfig(api: OpenClawPluginApi): MeshtasticPluginConfig {
  const raw = (api.config ?? {}) as Partial<MeshtasticPluginConfig>;
  return {
    baseUrl: typeof raw.baseUrl === "string" ? raw.baseUrl : DEFAULTS.baseUrl,
    defaultRadioId:
      typeof raw.defaultRadioId === "string" && raw.defaultRadioId.length > 0
        ? raw.defaultRadioId
        : null,
    timeoutMs:
      typeof raw.timeoutMs === "number" && raw.timeoutMs > 0
        ? raw.timeoutMs
        : DEFAULTS.timeoutMs,
    userAgent:
      typeof raw.userAgent === "string" && raw.userAgent.length > 0
        ? raw.userAgent
        : DEFAULTS.userAgent,
  };
}

function buildClient(api: OpenClawPluginApi): MeshxClient {
  const cfg = resolveConfig(api);
  return new MeshxClient({
    baseUrl: cfg.baseUrl,
    timeoutMs: cfg.timeoutMs,
    userAgent: cfg.userAgent,
  });
}

// --- shared helpers ----------------------------------------------------------

/**
 * Resolve the radio_id to use for a tool call.
 *
 * Priority:
 *   1. explicit `radio_id` argument
 *   2. plugin config `defaultRadioId`
 *   3. only-attached-radio auto-pick (one network call)
 *
 * Throws a friendly error if zero or multiple radios are attached and no
 * explicit / configured radio_id is available.
 */
async function resolveRadioId(
  client: MeshxClient,
  api: OpenClawPluginApi,
  explicit: string | undefined,
): Promise<string> {
  if (typeof explicit === "string" && explicit.length > 0) return explicit;

  const cfg = resolveConfig(api);
  if (cfg.defaultRadioId) return cfg.defaultRadioId;

  const list: ListRadiosOutputBody = await client.listRadios();
  const radios = list.radios ?? [];
  if (radios.length === 1) return radios[0]!.radio_id;
  if (radios.length === 0) {
    throw new Error(
      "No radio is attached to the meshx daemon. Pass radio_id, set defaultRadioId in plugin config, or attach a radio with `meshx server start --radio …`.",
    );
  }
  const ids = radios.map((r) => r.radio_id).join(", ");
  throw new Error(
    `Multiple radios attached (${ids}). Pass radio_id explicitly or set defaultRadioId in plugin config.`,
  );
}

/**
 * Build the canonical AgentToolResult shape: a text content block with the
 * pretty-printed JSON, plus the parsed object on `details` so OpenClaw can
 * render structured UI without re-parsing the text.
 */
function jsonResult<T>(data: T) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
    details: data,
  };
}

/**
 * Convert any thrown value into an Error with a friendly prefix for
 * meshx-daemon HTTP failures. Per pi-agent-core's contract, tools throw
 * on failure instead of encoding the error in `content`.
 */
function toFriendlyError(err: unknown): Error {
  if (err instanceof MeshxRequestError) {
    return new Error(`meshx daemon error: ${err.message}`);
  }
  if (err instanceof Error) return err;
  return new Error(String(err));
}

// --- tool factories ----------------------------------------------------------

const HealthSchema = Type.Object({}, { additionalProperties: false });

function createHealthTool(api: OpenClawPluginApi): AnyAgentTool {
  return {
    name: "meshtastic_health",
    label: "Meshtastic: daemon health",
    description:
      "Liveness probe for the meshx daemon. Returns {status: 'ok'} when the daemon is reachable. Use this to verify the plugin can reach the daemon before calling other tools.",
    parameters: HealthSchema,
    execute: async () => {
      try {
        return jsonResult(await buildClient(api).health());
      } catch (err) {
        throw toFriendlyError(err);
      }
    },
  };
}

const ListRadiosSchema = Type.Object({}, { additionalProperties: false });

function createListRadiosTool(api: OpenClawPluginApi): AnyAgentTool {
  return {
    name: "meshtastic_list_radios",
    label: "Meshtastic: list attached radios",
    description:
      "List every radio currently registered with the meshx daemon. Each entry has radio_id, connection_status, and optional identity / firmware fields. Use the returned radio_id with the per-radio tools.",
    parameters: ListRadiosSchema,
    execute: async () => {
      try {
        return jsonResult(await buildClient(api).listRadios());
      } catch (err) {
        throw toFriendlyError(err);
      }
    },
  };
}

const RadioIdSchema = Type.Object(
  {
    radio_id: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "radio_id to target. If omitted, uses the plugin's defaultRadioId, or the only attached radio when exactly one is present.",
      }),
    ),
  },
  { additionalProperties: false },
);

function createGetRadioTool(api: OpenClawPluginApi): AnyAgentTool {
  return {
    name: "meshtastic_get_radio",
    label: "Meshtastic: per-radio snapshot",
    description:
      "Return the per-radio session snapshot — identity, telemetry, current channel, and connection status. Useful for rendering a status bar or confirming which radio is currently usable.",
    parameters: RadioIdSchema,
    execute: async (_id, raw) => {
      try {
        const params = raw as Static<typeof RadioIdSchema>;
        const client = buildClient(api);
        const radioId = await resolveRadioId(client, api, params.radio_id);
        return jsonResult(await client.getRadio(radioId));
      } catch (err) {
        throw toFriendlyError(err);
      }
    },
  };
}

function createListChannelsTool(api: OpenClawPluginApi): AnyAgentTool {
  return {
    name: "meshtastic_list_channels",
    label: "Meshtastic: list channels",
    description:
      "List the radio's configured channel slots. PSK bytes are NEVER returned by the daemon — only metadata (slot index, name, role, has_psk flag). Channel index is what `meshtastic_send_message` consumes.",
    parameters: RadioIdSchema,
    execute: async (_id, raw) => {
      try {
        const params = raw as Static<typeof RadioIdSchema>;
        const client = buildClient(api);
        const radioId = await resolveRadioId(client, api, params.radio_id);
        return jsonResult(await client.listChannels(radioId));
      } catch (err) {
        throw toFriendlyError(err);
      }
    },
  };
}

function createListNodesTool(api: OpenClawPluginApi): AnyAgentTool {
  return {
    name: "meshtastic_list_nodes",
    label: "Meshtastic: list mesh peers",
    description:
      "List every mesh peer the radio's NodeDB has seen, with the most-recent telemetry (SNR, RSSI, hop count) and derived state (online / offline / muted). Use this to find a peer node_num before sending a direct message.",
    parameters: RadioIdSchema,
    execute: async (_id, raw) => {
      try {
        const params = raw as Static<typeof RadioIdSchema>;
        const client = buildClient(api);
        const radioId = await resolveRadioId(client, api, params.radio_id);
        return jsonResult(await client.listNodes(radioId));
      } catch (err) {
        throw toFriendlyError(err);
      }
    },
  };
}

const RecentMessagesSchema = Type.Object(
  {
    radio_id: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "radio_id to read from. Uses defaultRadioId / single-radio auto-pick when omitted.",
      }),
    ),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 1000,
        default: 50,
        description: "Maximum number of most-recent messages to return.",
      }),
    ),
  },
  { additionalProperties: false },
);

function createRecentMessagesTool(api: OpenClawPluginApi): AnyAgentTool {
  return {
    name: "meshtastic_recent_messages",
    label: "Meshtastic: recent messages",
    description:
      "Return persisted + in-memory chat rows in chronological order. Includes channel, sender, text, timestamp, and ack status. Optional limit (default 50) caps to the most recent N rows.",
    parameters: RecentMessagesSchema,
    execute: async (_id, raw) => {
      try {
        const params = raw as Static<typeof RecentMessagesSchema>;
        const client = buildClient(api);
        const radioId = await resolveRadioId(client, api, params.radio_id);
        return jsonResult(await client.listMessages(radioId, params.limit));
      } catch (err) {
        throw toFriendlyError(err);
      }
    },
  };
}

const SendMessageSchema = Type.Object(
  {
    radio_id: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "radio_id to send through. Uses defaultRadioId / single-radio auto-pick when omitted.",
      }),
    ),
    text: Type.String({
      minLength: 1,
      maxLength: 228,
      description:
        "Message body. Meshtastic packets cap at ~228 bytes after encoding; longer text will be rejected by the daemon.",
    }),
    channel_index: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: 7,
        description:
          "Channel slot index (0-7). Defaults to channel 0 (PRIMARY) if omitted. Use meshtastic_list_channels to see the slot table.",
      }),
    ),
    to: Type.Optional(
      Type.String({
        description:
          "Optional destination node id (e.g. '!a1b2c3d4'). Omit to broadcast on the channel.",
      }),
    ),
  },
  { additionalProperties: false },
);

function createSendMessageTool(api: OpenClawPluginApi): AnyAgentTool {
  return {
    name: "meshtastic_send_message",
    label: "Meshtastic: send a chat message",
    description:
      "Enqueue an outbound text message on the named channel via the daemon. Returns the allocated MeshPacket.id so the caller can correlate with future ack / fail events. Sending external messages costs airtime — do not call this without an explicit user request.",
    parameters: SendMessageSchema,
    execute: async (_id, raw) => {
      try {
        const params = raw as Static<typeof SendMessageSchema>;
        const client = buildClient(api);
        const radioId = await resolveRadioId(client, api, params.radio_id);
        const body: SendMessageRequest = { text: params.text };
        if (typeof params.channel_index === "number") {
          body.channel_index = params.channel_index;
        }
        if (typeof params.to === "string" && params.to.length > 0) {
          body.to = params.to;
        }
        return jsonResult(await client.sendMessage(radioId, body));
      } catch (err) {
        throw toFriendlyError(err);
      }
    },
  };
}

// --- entry -------------------------------------------------------------------

export default definePluginEntry({
  id: "meshtastic",
  name: "Meshtastic",
  description:
    "Read from and write to a Meshtastic LoRa radio via the meshx HTTP+SSE daemon.",
  register(api) {
    api.registerTool(createHealthTool(api));
    api.registerTool(createListRadiosTool(api));
    api.registerTool(createGetRadioTool(api));
    api.registerTool(createListChannelsTool(api));
    api.registerTool(createListNodesTool(api));
    api.registerTool(createRecentMessagesTool(api));
    api.registerTool(createSendMessageTool(api));
  },
});
