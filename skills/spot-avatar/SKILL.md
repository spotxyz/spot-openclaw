---
name: spot-avatar
description: Manage a Spot virtual-office avatar and participate in Spot conversations through the Spot channel.
metadata: { "openclaw": { "emoji": "📍" } }
---

# Spot Avatar

Use this skill when the user asks you to join, observe, move around, emote, or speak in a Spot virtual office.

## Mental model

- Chat and avatar presence are related but separate. Chat destinations are Spot thread ids; avatar operations use a configured world id.
- An inbound chat event has a `threadId`, but does not identify its world. Never infer a world id from chat. Sanitized avatar-activity payloads identify their subscribed world and are mapped to the corresponding room session by the connector.
- A Spot "room" is exposed by `spot_rooms` as a spot with an id, slug, display name, access decision, and chat thread id.
- Room history is permission-scoped and exposed through `spot_history`; avatar presence alone does not grant access to it.
- Tool success is the evidence that a physical/avatar effect happened. Do not claim that you moved, joined, or emoted before the tool returns successfully.

## Default workflow

1. Call `spot_observe` when you do not already have fresh state. It returns the managed avatar, other visible avatars, and rooms.
2. If the avatar is absent, call `spot_join` or `spot_move_to_room`.
3. Prefer `spot_move_to_room` for a named room. It discovers the room and makes an already-live avatar walk there without guessing coordinates; an absent avatar joins directly in the destination.
4. Use `spot_move` for normal coordinate movement and `spot_teleport` only when exact repositioning is explicitly appropriate.
5. Call `spot_emotes` when the supported animation ids are not fresh, then use `spot_emote` for a visible emoji overlay, body animation, or both.
6. Call `spot_gestures` before unfamiliar social interactions. Use `spot_gesture` to request, cancel, or complete high-fives, fist bumps, handshakes, and rock-paper-scissors.
7. Call `spot_leave` only when the user asks to leave or the task clearly requires ending presence. It pauses managed-avatar renewal until `spot_join` or `spot_move_to_room` is called explicitly.

## Avatar activity

- When avatar-activity monitoring is enabled, presence, emote, and gesture updates arrive as ephemeral, at-most-once ambient room events. Treat them as physical context, not automatically as a request to speak or as an audit log.
- A gesture-request event includes the requester user id. Complete it only when doing so is socially appropriate; Spot verifies that both avatars are still in the same room.
- Ignore self-authored activity and avoid mirroring every emote. Prefer a small, contextually relevant response over repeated animation.

## Speaking and messaging

- Use OpenClaw's shared `message` tool to speak in Spot; there is no separate `spot_say` tool.
- Reply to the current Spot conversation using its durable `thread:<threadId>` target.
- Named-channel replies are delivered in the message's Spot reply thread. Followups stay in that thread; do not create a nested thread.
- To initiate a DM, target `user:<userId>`; the connector gets or creates the DM thread and posts there.
- A room returned by `spot_rooms` includes `threadId`; target `thread:<threadId>` to speak in that room.
- Do not use a world id as if it were a chat thread id.
- Use the shared `message` tool's `react` and `reactions` actions with the Spot event id. An empty emoji removes only this agent's reactions.

## Reading missed context

- If someone refers to an earlier message, says "above", or reports that an inbound message was missed, call `spot_history` before answering.
- With no arguments, `spot_history` reads the avatar's current room. Pass `room` for another discoverable room or `threadId` for the current Spot conversation.
- Treat the returned cursor as opaque. Pass `before` to read an older page; do not construct or edit cursors.
- A permission error is authoritative. Do not claim that Spot lacks history support when the tool was unavailable or was not called.

## Error handling

- `spot_locked` means the room is locked; do not retry movement blindly.
- `spot_access_denied` means the avatar lacks room access.
- `out_of_bounds` means choose a valid coordinate or use room movement.
- `not_joined` means join before moving, turning, or emoting.
- `rate_limited` means pause rather than retrying in a tight loop.
- `gesture_unavailable` means the request was cancelled, moved to another room, already completed, or requires a different response.
- If room discovery marks `canAccess: false`, explain the returned reason and ask for another destination.
