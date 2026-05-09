# meshx — agent-first architecture (MCP pivot)

> Notes for retr0h, captured 2026-05-08, after wiring up
> openclaw-meshtastic against the live HTTP+SSE daemon. Reflects what
> the plugin's agent consumer (OpenClaw / Claude) actually hit while
> using the API in anger.

## TL;DR

The current HTTP+SSE + OpenAPI + multi-radio registry architecture is
**good** — the right shape for tools, plugins, and SDK consumers in
general. The pain points are agent-specific: agents don't read source,
they read tool descriptions and JSON Schema. They lose context across
turns, they can't keep long-lived connections cheaply, and they want
the lifecycle (scan → pair → attach → use) to be self-describing.

The proposed direction: **make meshx MCP-native** — same long-running
daemon, but speak MCP alongside HTTP+SSE (or eventually instead of).
The lifecycle, the events, the writes — all become MCP primitives that
an agent can discover from the tool list without reading code.

---

## Why MCP-native, not just an MCP shim

We initially considered: keep HTTP+SSE as canonical, ship a tiny
stdio MCP shim that translates MCP tool calls to HTTP requests. That
works, but you lose self-description on the lifecycle:

- agent has to know to call `--radio /dev/cu.usbX` at daemon startup
- agent has to read meshx's README to know how to pair a BLE radio
- agent has to wire SSE separately to get push events

If meshx itself speaks MCP, all of that becomes discoverable:

```
agent connects → tools list:
  meshtastic_scan_usb         "list candidate USB-serial radios"
  meshtastic_scan_ble         "discover Bluetooth Meshtastic radios"
  meshtastic_pair_ble         "pair a BLE radio (triggers OS prompt)"
  meshtastic_attach_radio     "dial a radio at runtime — no daemon restart"
  meshtastic_detach_radio
  meshtastic_list_radios
  meshtastic_get_radio
  meshtastic_list_channels
  meshtastic_list_nodes
  meshtastic_recent_messages
  meshtastic_send_message     "broadcast on a channel"
  meshtastic_send_dm          "unicast to a specific peer"
  meshtastic_set_my_info      "update long_name / short_name / region"
  meshtastic_mute_channel
  meshtastic_reboot_radio

resources:
  meshx://docs/connection-guide.md
  meshx://docs/troubleshooting.md
  meshx://radios/0x103d20cd/snapshot

prompts:
  "walk me through pairing my radio"
  "diagnose why my mesh feels quiet"
```

Agent reads the tool list, follows the descriptions, never has to
guess what the daemon expects.

---

## Concrete shape

### Daemon process model (unchanged)

`meshx server start` is still the long-running daemon. It owns the
serial port, the SQLite store, the pump, the registry. None of that
moves.

### Transports (additive)

```
meshx server start
  --bind 127.0.0.1:4404       # HTTP + SSE (existing — keep for now)
  --mcp-stdio                 # also speak MCP on stdin/stdout (new)
  --mcp-http :4405            # MCP-over-streamable-HTTP (new, optional)
```

`mark3labs/mcp-go` is the standard Go MCP server library. The handlers
register tools/resources/notifications — implementation calls into the
same `Session` / `Registry` / `Store` packages the HTTP layer already
uses. No duplicate logic; just an MCP adapter alongside the Huma one.

### Lifecycle as runtime tools

The biggest win. Today `--radio` is a startup flag; you can't change
the attached radio without restarting the daemon. Make it dynamic:

```
meshtastic_scan_usb()                      → [{ port, hw_model, callsign, … }]
meshtastic_scan_ble()                      → [{ uuid, name, rssi, … }]
meshtastic_pair_ble({ uuid })              → { status: "awaiting_user_confirmation" | "paired" | "failed" }
meshtastic_pair_status({ uuid })           → { status: "paired" }
meshtastic_attach_radio({ dest })          → { radio_id, connected }
meshtastic_detach_radio({ radio_id })      → { ok }
```

Daemon stays up. Agent walks the lifecycle by reading tool
descriptions. No "edit your shell command and restart" friction.

### Notifications replace SSE

MCP supports server-pushed notifications. Map directly:

```
notification: meshtastic.text_received
  { radio_id, channel, from_num, from_callsign, text, hops, snr, sent_at }

notification: meshtastic.dm_received
  { radio_id, from_num, from_callsign, text, sent_at }

notification: meshtastic.message_status
  { radio_id, packet_id, status: "ack"|"fail", ackers?: [...] }

notification: meshtastic.node_seen
  { radio_id, node_num, callsign, snr, rssi, hops, last_heard }

notification: meshtastic.transport_state
  { radio_id, state: "connected"|"reconnecting"|"disconnected", attempt? }
```

Plus a replay tool for restart-resilience:

```
meshtastic_replay_events({ since: "<event_id>", limit: 200 })
  → { events: [...], cursor: "<event_id>" }
```

This collapses my original list items #1 (resumable SSE), #2 (unified
stream), and #4 (packet status) into one MCP-shaped feature.

### Schema cleanups (still relevant)

These don't depend on MCP, but worth doing as part of the pivot since
both transports can pick up the new shapes:

- **Drop `acks` formatted string from the wire.** Replace with structured
  `ackers: [{ node_num, callsign, hops, at }]`. TUI formats. Consumers
  (plugin, MCP, future web UI) get raw data and format themselves.
- **Separate `Message` (wire-shape) from `MessageItem` (TUI display
  hints).** `bang` and the formatted `acks` string belong to the TUI's
  rendering layer, not the API contract.
- **Idempotency-Key on send.** A retry after a network blip shouldn't
  re-broadcast. Apply at both transports — for MCP, dedupe on the
  request id within a 60s window.

### Auth

- **stdio MCP**: free — process boundary is the auth boundary.
- **HTTP MCP / HTTP+SSE**: needs `Authorization: Bearer <token>` once
  you bind anything other than 127.0.0.1. `--auth-token-file` flag,
  generated on first run, printed once for the user to copy.

### Spec-first contract testing

MCP gives you this almost free:

- Boot the daemon in test mode, dump the MCP tool/resource manifest as
  JSON, snapshot it.
- CI step: regenerate, diff against the snapshot, fail on
  backward-incompatible removals (tool dropped, required input added,
  enum narrowed).
- Same trick for the Huma OpenAPI spec via `oasdiff` while HTTP exists.

---

## What this means for openclaw-meshtastic

The current plugin is fine **today**. It works, it's small, it's the
fastest reference for a 7-tool surface. But once meshx ships MCP:

- OpenClaw can talk directly to meshx via its built-in MCP support
  (`openclaw mcp set …`). No plugin install needed.
- The plugin keeps a niche: TS-side post-processing, custom tool
  naming, OpenClaw-specific config (default radio, tighter timeouts).
- Other MCP hosts (Claude Desktop, Cline, Cursor, Windsurf) all get
  meshx for free with one config block.

Net: the plugin becomes optional, not required. Lower friction for
adoption.

---

## Migration path (low-risk)

1. **Land schema cleanups** (acks → ackers, separate Message from
   MessageItem, Idempotency-Key support). Bump API to v0.2.
2. **Add `meshtastic_attach_radio` / `_detach_radio` HTTP routes** so
   lifecycle is dynamic before MCP. Plugin and TUI both benefit.
3. **Add MCP-stdio transport** to the daemon, sharing handlers with
   Huma. `meshx server start --mcp-stdio`.
4. **Spec-first contract test** dumps + diffs the MCP manifest in CI.
5. **Add MCP-over-HTTP** (Streamable HTTP transport) when fan-out
   matters.
6. **Decide whether to deprecate** raw HTTP+SSE — probably no, lots of
   reasons to keep it (curl debugging, generated SDKs, future web UI).

Each step is shippable independently. None of them break existing
HTTP consumers. The plugin keeps working through every step.

---

## Open questions for you

- **MCP-go library** — `mark3labs/mcp-go` is the de facto choice but
  evolving fast. Worth pinning a tag.
- **Notifications: per-tool subscription model?** MCP's notification
  semantics are still maturing. Some hosts surface every notification
  to the agent context (token cost!), others only on explicit
  subscription. May need a `subscribe`/`unsubscribe` tool pair to give
  agents control.
- **Resource URIs**: `meshx://radios/<id>/snapshot` is nice but
  resources are pull-only. State that changes fast (NodeDB) might be
  better as a tool than a resource so the agent picks freshness when
  it asks.
- **Streaming long results**: `meshtastic_recent_messages?limit=5000`
  could be huge. MCP supports tool result chunking; worth using.
