// Typed HTTP client for the meshx daemon, driven by its OpenAPI 3.1 spec.
//
// The spec lives at `openapi/meshx.openapi.json` and is regenerated into
// `src/openapi.gen.ts` via `npm run gen:types`. We use `openapi-fetch` for a
// small (no-codegen) typed wrapper around `fetch`. Refreshing types when a
// new meshx release ships is one command — no hand-maintained shapes, no
// drift.

import createClient, { type Client } from "openapi-fetch";

import type { paths, components } from "./openapi.gen.js";

// Re-export the spec-derived component schemas so the plugin entry can
// stay loosely coupled — callers see nice short names without importing
// the full openapi-fetch type machinery.
export type RadioSummary = components["schemas"]["RadioSummary"];
export type ListRadiosOutputBody =
  components["schemas"]["ListRadiosOutputBody"];
export type SessionSnapshot = components["schemas"]["SessionSnapshot"];
export type ChannelItem = components["schemas"]["ChannelItem"];
export type ListChannelsOutputBody =
  components["schemas"]["ListChannelsOutputBody"];
export type NodeItem = components["schemas"]["NodeItem"];
export type ListNodesOutputBody = components["schemas"]["ListNodesOutputBody"];
export type MessageItem = components["schemas"]["MessageItem"];
export type ListMessagesOutputBody =
  components["schemas"]["ListMessagesOutputBody"];
export type SendMessageRequest = components["schemas"]["SendMessageRequest"];
export type SendMessageResult = components["schemas"]["SendMessageResult"];
export type HealthOutputBody = components["schemas"]["HealthOutputBody"];

export interface MeshxClientOptions {
  baseUrl: string;
  timeoutMs: number;
  userAgent: string;
}

/**
 * Thrown when the daemon returns a non-2xx response, the request times out,
 * or the network call fails. Wraps the underlying status / URL / body so
 * callers (and the plugin's tool wrappers) can surface a useful error
 * message back to the agent.
 */
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

/**
 * Public client used by the plugin's tool wrappers. Method names are stable;
 * the implementation under each method is OpenAPI-driven.
 */
export class MeshxClient {
  private readonly raw: Client<paths>;
  private readonly opts: MeshxClientOptions;

  constructor(opts: MeshxClientOptions) {
    this.opts = opts;
    this.raw = createClient<paths>({
      baseUrl: opts.baseUrl.replace(/\/+$/, ""),
      headers: {
        accept: "application/json",
        "user-agent": opts.userAgent,
      },
    });
  }

  // --- meta -----------------------------------------------------------------

  health(): Promise<HealthOutputBody> {
    return this.call("GET", "/healthz", {});
  }

  // --- radios ---------------------------------------------------------------

  listRadios(): Promise<ListRadiosOutputBody> {
    return this.call("GET", "/radios", {});
  }

  getRadio(radioId: string): Promise<SessionSnapshot> {
    return this.call("GET", "/radios/{radio_id}", {
      params: { path: { radio_id: radioId } },
    });
  }

  // --- per-radio resources --------------------------------------------------

  listChannels(radioId: string): Promise<ListChannelsOutputBody> {
    return this.call("GET", "/radios/{radio_id}/channels", {
      params: { path: { radio_id: radioId } },
    });
  }

  listNodes(radioId: string): Promise<ListNodesOutputBody> {
    return this.call("GET", "/radios/{radio_id}/nodes", {
      params: { path: { radio_id: radioId } },
    });
  }

  listMessages(
    radioId: string,
    limit?: number,
  ): Promise<ListMessagesOutputBody> {
    return this.call("GET", "/radios/{radio_id}/messages", {
      params: {
        path: { radio_id: radioId },
        ...(typeof limit === "number" ? { query: { limit } } : {}),
      },
    });
  }

  sendMessage(
    radioId: string,
    body: SendMessageRequest,
  ): Promise<SendMessageResult> {
    return this.call("POST", "/radios/{radio_id}/messages", {
      params: { path: { radio_id: radioId } },
      body,
    });
  }

  // --- internals ------------------------------------------------------------

  /**
   * Single dispatch point that:
   *   - applies our per-request AbortController timeout
   *   - normalizes openapi-fetch's `{ data, error, response }` envelope into
   *     either a resolved typed payload or a thrown MeshxRequestError
   *   - converts AbortError + network failures into MeshxRequestError(0)
   *
   * The `as any` here is unavoidable: openapi-fetch's per-method overloads
   * resolve to different `init` shapes for each path/method combo, and TS
   * can't narrow that through a generic helper. The `Method` + `Path` type
   * params keep the call sites typed; only the dispatch is dynamic.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async call<TResp>(
    method: "GET" | "POST",
    path: keyof paths,
    init: any,
  ): Promise<TResp> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs);
    const url = `${this.opts.baseUrl.replace(/\/+$/, "")}${String(path)}`;
    try {
      const fn =
        method === "GET"
          ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (this.raw.GET as any)
          : // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (this.raw.POST as any);
      const result = await fn(path, { ...init, signal: ctrl.signal });
      const { data, error, response } = result as {
        data?: TResp;
        error?: unknown;
        response: Response;
      };
      if (error !== undefined) {
        throw new MeshxRequestError(
          response.status,
          response.url,
          error,
          `${method} ${String(path)} failed: ${response.status} ${
            extractErrorMessage(error) ?? response.statusText
          }`,
        );
      }
      return data as TResp;
    } catch (err) {
      if (err instanceof MeshxRequestError) throw err;
      if ((err as { name?: string })?.name === "AbortError") {
        throw new MeshxRequestError(
          0,
          url,
          null,
          `${method} ${String(path)} timed out after ${this.opts.timeoutMs}ms`,
        );
      }
      throw new MeshxRequestError(
        0,
        url,
        null,
        `${method} ${String(path)} failed: ${(err as Error).message}`,
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
