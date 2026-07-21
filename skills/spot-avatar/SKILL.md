---
name: spot-avatar
description: Manage a Spot virtual-office avatar and participate in Spot conversations through the Spot channel.
metadata: { "openclaw": { "emoji": "📍" } }
---

# Spot Avatar

Use this skill when the user asks you to join, observe, move around, emote, or speak in a Spot virtual office.

## Mental model

- Chat and avatar presence are related but separate. Chat destinations are Spot thread ids; avatar operations use a configured world id.
- An inbound Agent Gateway event has a `threadId`, but does not identify its world. Never infer a world id from an inbound event.
- A Spot "room" is exposed by `spot_rooms` as a spot with an id, slug, display name, access decision, and chat thread id.
- Tool success is the evidence that a physical/avatar effect happened. Do not claim that you moved, joined, or emoted before the tool returns successfully.

## Default workflow

1. Call `spot_observe` when you do not already have fresh state. It returns the managed avatar, other visible avatars, and rooms.
2. If the avatar is absent, call `spot_join` or `spot_move_to_room`.
3. Prefer `spot_move_to_room` for a named room. It discovers the room and joins/repositions by spot id without guessing coordinates.
4. Use `spot_move` for normal coordinate movement and `spot_teleport` only when exact repositioning is explicitly appropriate.
5. Use `spot_face` to turn and `spot_emote` for a visible emoji or animation.
6. Call `spot_leave` only when the user asks to leave or the task clearly requires ending presence.

## Speaking and messaging

- Use OpenClaw's shared `message` tool to speak in Spot; there is no separate `spot_say` tool.
- Reply to the current Spot conversation using its durable `thread:<threadId>` target.
- To initiate a DM, target `user:<userId>`; the connector gets or creates the DM thread and posts there.
- A room returned by `spot_rooms` includes `threadId`; target `thread:<threadId>` to speak in that room.
- Do not use a world id as if it were a chat thread id.

## Error handling

- `spot_locked` means the room is locked; do not retry movement blindly.
- `spot_access_denied` means the avatar lacks room access.
- `out_of_bounds` means choose a valid coordinate or use room movement.
- `not_joined` means join before moving, turning, or emoting.
- `rate_limited` means pause rather than retrying in a tight loop.
- If room discovery marks `canAccess: false`, explain the returned reason and ask for another destination.
