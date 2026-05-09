# 📡 openclaw-meshtastic

> OpenClaw plugin: read from and write to a Meshtastic LoRa radio via the
> [meshx](https://github.com/retr0h/meshx) HTTP+SSE daemon.

This plugin lets your OpenClaw agent see your mesh — list attached radios,
list peers, read recent chat, and (with intent) send a message. Pair it with
the meshx daemon running on a Mac mini, Raspberry Pi, or any always-on host
that owns the radio.

## Architecture

```
        radio (USB / TCP / BLE)
               │
        ┌──────▼──────┐
        │   meshx     │   meshx server start --radio …
        │   daemon    │   exposes HTTP + SSE on 127.0.0.1:4404
        └──────┬──────┘
               │  HTTP
        ┌──────▼──────────────┐
        │ openclaw-meshtastic │   this plugin
        │      (tools)        │
        └──────┬──────────────┘
               │
        ┌──────▼──────┐
        │  OpenClaw   │
        │    agent    │
        └─────────────┘
```

The plugin does **not** speak to the radio directly. Everything is mediated by
the meshx daemon, so you get its reconnect handling, SQLite-backed history,
multi-radio registry, and per-radio SSE event stream for free.

## Tools

| Name                          | Purpose |
|-------------------------------|---------|
| `meshtastic_health`           | Liveness probe for the daemon. |
| `meshtastic_list_radios`      | List every radio currently attached to the daemon. |
| `meshtastic_get_radio`        | Per-radio session snapshot — identity, telemetry, state. |
| `meshtastic_list_channels`    | List the radio's configured channel slots. PSKs are never returned. |
| `meshtastic_list_nodes`       | List mesh peers seen by the radio (SNR, RSSI, hops, online). |
| `meshtastic_recent_messages`  | Most-recent chat rows (default 50, max 1000). |
| `meshtastic_send_message`     | Send a text message on a channel (or to a specific node). |

For per-radio tools, the `radio_id` argument is **optional**:

1. Use the explicit `radio_id` if passed.
2. Otherwise use `defaultRadioId` from plugin config.
3. Otherwise auto-pick the only attached radio.
4. Otherwise return a friendly error listing the available radios.

## Install

### From source (local development)

```bash
git clone https://github.com/retr0h/openclaw-meshtastic.git
cd openclaw-meshtastic
npm install
npm run build
openclaw plugins install .
openclaw gateway restart
```

### From ClawHub (once published)

```bash
openclaw plugins install clawhub:openclaw-meshtastic
openclaw gateway restart
```

## Configure

In your OpenClaw config (`openclaw.json` / `openclaw config.patch`), under
`plugins.entries.meshtastic.config`:

```jsonc
{
  "baseUrl": "http://127.0.0.1:4404",   // where meshx daemon listens
  "defaultRadioId": null,                // or e.g. "0xa1b2c3d4"
  "timeoutMs": 5000,
  "userAgent": "openclaw-meshtastic/0.1.0"
}
```

All fields are optional; the defaults above are used when omitted.

## Running the daemon

This plugin requires a running meshx daemon. The meshx project documents the
flag surface, but the short version is:

```bash
# no radio attached — daemon serves the API and 0 radios
meshx server start --bind 127.0.0.1:4404

# attach a USB-serial radio
meshx server start --radio /dev/cu.usbserial-…

# attach a TCP radio (meshtasticd / WiFi-bridged)
meshx server start --radio host:4403

# attach a Bluetooth LE radio (must already be paired)
meshx server start --radio ble:<uuid>
```

For long-lived deployments, wrap the daemon in `launchd` (macOS),
`systemd` (Linux), or your supervisor of choice.

## Verifying the plugin

```bash
openclaw plugins inspect meshtastic --runtime
```

You should see all seven tools listed under the plugin's runtime registrations.

## AI disclosure

Per [meshx's AI policy](https://github.com/retr0h/meshx/blob/main/AI_POLICY.md):

This plugin's initial scaffold was authored with AI assistance
(OpenClaw / Claude). Every line is reviewed and understood by a human
maintainer (John Dewey) before publication. The plugin's design — the seven
tools, the radio-id resolution rules, the no-runtime-deps fetch-based
client — is human-driven and reviewable.

## License

MIT — see [LICENSE](./LICENSE).
