// Thin typed HTTP client for the meshx daemon.
//
// Only covers what the plugin's tools need; the daemon's full surface is in
// /openapi.json and is mirrored by meshx's own internal/sdk/gen/ Go client.
// We intentionally keep this client small and fetch-based so the plugin has
// zero runtime dependencies beyond Node 22+.

export interface MeshxClientOptions {
  baseUrl: string;
  timeoutMs: number;
  userAgent: string;
}

export class MeshxRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    public readonly body: unknown,
    message: string,
  ) {
    super(message);
    this.name = "MeshxRequestError";
  }
}

export class MeshxClient {
  constructor(private readonly opts: MeshxClientOptions) {}

  // --- meta -----------------------------------------------------------------

  health(): Promise<{ status: string }> {
    return this.get<{ status: string }>("/healthz");
  }

  // --- radios ---------------------------------------------------------------

  listRadios(): Promise<ListRadiosOutputBody> {
    return this.get<ListRadiosOutputBody>("/radios");
  }

  getRadio(radioId: string): Promise<SessionSnapshot> {
    return this.get<SessionSnapshot>(`/radios/${encodeURIComponent(radioId)}`);
  }

  // --- per-radio resources --------------------------------------------------

  listChannels(radioId: string): Promise<ListChannelsOutputBody> {
    return this.get<ListChannelsOutputBody>(
      `/radios/${encodeURIComponent(radioId)}/channels`,
    );
  }

  listNodes(radioId: string): Promise<ListNodesOutputBody> {
    return this.get<ListNodesOutputBody>(
      `/radios/${encodeURIComponent(radioId)}/nodes`,
    );
  }

  listMessages(
    radioId: string,
    limit?: number,
  ): Promise<ListMessagesOutputBody> {
    const path =
      `/radios/${encodeURIComponent(radioId)}/messages` +
      (typeof limit === "number" ? `?limit=${limit}` : "");
    return this.get<ListMessagesOutputBody>(path);
  }

  sendMessage(
    radioId: string,
    body: SendMessageRequest,
  ): Promise<SendMessageResult> {
    return this.post<SendMessageResult>(
      `/radios/${encodeURIComponent(radioId)}/messages`,
      body,
    );
  }

  // --- internals ------------------------------------------------------------

  private async get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = this.opts.baseUrl.replace(/\/+$/, "") + path;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        signal: ctrl.signal,
        headers: {
          accept: "application/json",
          "user-agent": this.opts.userAgent,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });

      const text = await res.text();
      let parsed: unknown = null;
      if (text.length > 0) {
        try {
          parsed = JSON.parse(text);
        } catch {
          // leave parsed as the raw text in the error path below
          parsed = text;
        }
      }

      if (!res.ok) {
        const detail = extractErrorMessage(parsed) ?? res.statusText;
        throw new MeshxRequestError(
          res.status,
          url,
          parsed,
          `${method} ${path} failed: ${res.status} ${detail}`,
        );
      }
      return parsed as T;
    } catch (err) {
      if (err instanceof MeshxRequestError) throw err;
      if ((err as { name?: string })?.name === "AbortError") {
        throw new MeshxRequestError(
          0,
          url,
          null,
          `${method} ${path} timed out after ${this.opts.timeoutMs}ms`,
        );
      }
      throw new MeshxRequestError(
        0,
        url,
        null,
        `${method} ${path} failed: ${(err as Error).message}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

function extractErrorMessage(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b.detail === "string") return b.detail;
  if (typeof b.title === "string") return b.title;
  if (typeof b.message === "string") return b.message;
  return null;
}

// --- minimal type mirrors of the daemon's OpenAPI shapes ---------------------
// Matches /openapi.json (v0.1.0). We only declare fields the plugin actually
// surfaces; extra fields from the daemon are preserved in JSON output but not
// statically typed.

export interface RadioSummary {
  radio_id: string;
  connection_status: string;
  dest?: string;
  short_name?: string;
  long_name?: string;
  hw_model?: string;
  firmware?: string;
  [k: string]: unknown;
}

export interface ListRadiosOutputBody {
  radios: RadioSummary[];
}

export interface SessionSnapshot {
  radio_id: string;
  connection_status: string;
  [k: string]: unknown;
}

export interface ChannelItem {
  index: number;
  name: string;
  role?: string;
  has_psk?: boolean;
  [k: string]: unknown;
}

export interface ListChannelsOutputBody {
  channels: ChannelItem[];
}

export interface NodeItem {
  node_num: number;
  short_name?: string;
  long_name?: string;
  last_snr?: number;
  last_rssi?: number;
  last_hops?: number;
  last_heard?: string;
  online?: boolean;
  [k: string]: unknown;
}

export interface ListNodesOutputBody {
  nodes: NodeItem[];
}

export interface MessageItem {
  id?: string;
  packet_id?: number;
  channel_index?: number;
  channel?: string;
  from?: string;
  from_node_num?: number;
  to?: string;
  text?: string;
  time?: string;
  status?: string;
  ack?: boolean;
  [k: string]: unknown;
}

export interface ListMessagesOutputBody {
  messages: MessageItem[];
}

export interface SendMessageRequest {
  text: string;
  channel_index?: number;
  to?: string;
}

export interface SendMessageResult {
  packet_id?: number;
  status?: string;
  [k: string]: unknown;
}
