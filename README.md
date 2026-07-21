# OpenClaw Spot

An OpenClaw 2026.7 channel plugin that lets an agent receive and send Spot chat messages while managing a headless Spot avatar.

This is an OpenClaw **channel plugin** (the most precise current term), with companion avatar tools and an OpenClaw skill. It connects to Spot's Agent Gateway over WebSocket for inbound events and uses the Spot REST API for chat and avatar actions.

## Capabilities

- Per-conversation serialized, bounded inbound `message.created` handling with limited cross-conversation concurrency, deduplication, mention/DM activation, sender allowlisting, self filtering, bot-loop protection, and reconnect backoff.
- Text replies and proactive text sends to `thread:<threadId>`; `user:<userId>` creates/resolves a DM thread first.
- Managed-avatar observe, join, leave, move, teleport, room movement, facing, and emote tools.
- Room discovery with access decisions and canonical chat thread ids.
- Literal or OpenClaw SecretRef tokens, including user-scoped environment secret providers.
- Root/default and named account configurations.

## Requirements

- OpenClaw `2026.7.1-2` (the package is intentionally pinned while the plugin SDK evolves).
- Node.js 24.15 or newer.
- A Spot API token with the scopes needed by the configured features:
  - `EventRead` for Agent Gateway default streams and thread subscriptions.
  - `EventWrite` for sending messages to an existing thread.
  - `ThreadWrite` only when initiating DMs through `user:<userId>`.
  - `WorldRead` for world subscriptions, room discovery, and avatar observation.
  - `AvatarWrite` for join, leave, movement, facing, and emotes.
- Spot server support for `GET /api/world/:worldId/spots`. This endpoint returns room metadata, access decisions, and thread ids without exposing floorplan geometry.

API token scopes and the bot user's effective Spot permissions are separate checks. Scopes authorize an API surface; they do not override organization, world, room, or role policy. Provision the bot user with the normal effective permissions needed for the rooms and actions it will use. In particular, `canViewChatHistory` is required for REST history reads and any future missed-event reconciliation. The connector does not currently fetch or replay missed messages.

## Develop

```bash
npm install
npm run check
npm test
npm run build
npm pack --dry-run
```

Link the checkout into a development OpenClaw instance:

```bash
openclaw plugins install --link .
openclaw plugins enable spot
openclaw plugins doctor
openclaw plugins inspect spot
```

Restart the OpenClaw gateway after installing or rebuilding the plugin.

## Minimal configuration

Store the token in a secret provider rather than directly in `openclaw.json`. With a user-scoped environment provider named `default`, the channel section is:

```json
{
  "plugins": {
    "entries": {
      "spot": {
        "enabled": true
      }
    }
  },
  "channels": {
    "spot": {
      "enabled": true,
      "baseUrl": "https://spot.example.com",
      "token": {
        "source": "env",
        "provider": "default",
        "id": "SPOT_AGENT_TOKEN"
      },
      "worldId": "your-world-id",
      "allowFrom": ["trusted-spot-user-id"],
      "activationMode": "direct-or-mention",
      "avatar": {
        "joinOnStart": true
      }
    }
  }
}
```

The resolved secret must be a non-empty string. File and exec SecretRefs are also accepted. A literal token works for development but is not recommended.

`baseUrl` defaults to `https://spotvirtual.com`. HTTPS is required for remote hosts so bearer tokens are never sent over plaintext; `http://localhost`, `http://*.localhost`, `http://127.x.x.x`, and `http://[::1]` remain available for local development.

Inbound activation is fail-closed: it is disabled until `allowFrom` contains exact Spot user ids. `"allowFrom": ["*"]` explicitly allows every sender visible on the subscribed surfaces, so use that only when the whole Spot audience is trusted. Bot-authored events are still ignored unless `allowBotMessages` is explicitly enabled.

With `avatar.joinOnStart` enabled, the gateway maintains an avatar lease for the configured world. Connects and reconnects preserve an already-joined avatar's current room and position; the startup `spotId`/position is used only when the avatar is absent. The lease defaults to 600 seconds, accepts configured values from 30 through 3,600 seconds, and renews at half the lease lifetime while the connection remains active.

`avatar.joinOnStart` requires a `worldId` after account defaults are merged. An explicit `spot_leave` pauses automatic renewal for that account and world. A successful `spot_join` or `spot_move_to_room` resumes it and wakes the lease manager immediately; a failed or cancelled join leaves renewal paused.

When `orgId` is configured, the connector accepts events explicitly scoped to that organization and filters events scoped to other organizations. Spot direct-message frames have `orgId: null`; those remain eligible and are still protected by `allowFrom` and activation policy.

### Named accounts

Top-level fields are inherited by named accounts, so a shared base URL can be combined with per-account tokens and worlds:

```json
{
  "channels": {
    "spot": {
      "baseUrl": "https://spot.example.com",
      "activationMode": "mentions",
      "allowFrom": ["trusted-spot-user-id"],
      "accounts": {
        "hq": {
          "enabled": true,
          "token": {
            "source": "env",
            "provider": "default",
            "id": "SPOT_HQ_AGENT_TOKEN"
          },
          "worldId": "hq-world-id",
          "avatar": {
            "joinOnStart": true,
            "spotId": "lobby-spot-id"
          }
        }
      }
    }
  }
}
```

## Target grammar

- `thread:<threadId>` — canonical room or DM chat destination.
- `user:<userId>` — get or create a DM thread, then send to it.
- `spot:<spotId-or-slug>` — convenience target that resolves through the configured world's room list.
- `world:<worldId>` — convenience target for the configured avatar's current room in that world.

Inbound events always establish `thread:<event.threadId>` as the durable reply target and canonical OpenClaw session identity, including DMs. `user:`, `spot:`, and `world:` convenience targets are resolved to that same thread identity before outbound session routing. Gateway events received before the `hello` identity frame are buffered so self filtering is active before dispatch. Inbound events do not carry a world id; avatar tools use `channels.spot.worldId` (or an explicit tool argument).

Persist Spot ids and thread ids, not the discovery response's floorplan `roomId`. A Spot id is the logical room identity used by chat and avatar targeting; the floorplan room id represents current geometry and may change after topology edits.

## Avatar tools

| Tool | Purpose |
| --- | --- |
| `spot_observe` | Get avatar state, visible avatars, and room list together. |
| `spot_avatar_state` | Get only the managed avatar state. |
| `spot_rooms` | Discover room ids/slugs/names, access decisions, and thread ids. |
| `spot_join` / `spot_leave` | Start or end avatar presence. |
| `spot_move` / `spot_teleport` | Move to coordinates. |
| `spot_move_to_room` | Resolve a room and reposition by Spot room id. |
| `spot_face` | Set avatar facing. |
| `spot_emote` | Play an emoji or animation. |

Use OpenClaw's shared `message` tool for speech. The connector deliberately does not register a second `spot_say` tool.

## Security and failure behavior

- Tokens are used only in the `Authorization` header and are never included in errors or status snapshots.
- REST requests have a 15-second deadline and honor account, connection, and tool cancellation where those signals are available.
- The Agent Gateway connection is listen-only; all mutations go through authorized REST endpoints.
- Inbound messages are ordered per conversation. Up to four conversations run concurrently, with a maximum account backlog of 256 adopted messages; overflow is surfaced as an unhealthy account instead of growing memory without bound.
- Event ids are bounded-deduplicated across reconnects.
- Agent Gateway delivery is at-most-once, not lossless. A sequence gap marks the account unhealthy and is logged, but is not automatically reconciled today.
- Reconciliation TODO: after reconnect or a sequence gap, fetch missed events for explicitly configured `subscribeThreads` via the thread-events REST API. Default and world streams need additional server cursor/thread-discovery support before they can be reconciled safely.
- Spot machine error codes such as `spot_locked`, `spot_access_denied`, `out_of_bounds`, `not_joined`, and `rate_limited` are preserved in tool errors so the agent can recover safely.
- Room movement never guesses floorplan coordinates. `spot_move_to_room` calls the join/reposition endpoint with the discovered room id.

## Architecture

```text
Spot Agent Gateway -- message.created --> OpenClaw channel runtime --> agent
        ^                                                        |
        |                                                        v
        +---------------- Spot REST chat <---------------- message tool

agent -- spot_* tools --> Spot REST avatar + room discovery --> Spot world
```

## License

This repository is public source, but the package is currently `UNLICENSED`. No open-source license or redistribution permission is granted unless the repository owners add one explicitly.
