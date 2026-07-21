import {
  jsonResult,
  type AnyAgentTool,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/core";
import { Type } from "typebox";

import { SpotApiError, SpotClient } from "./client.js";
import { resolveSpotAccount } from "./config.js";
import type { ResolvedSpotAccount, SpotWorldSpot } from "./types.js";

export const SPOT_TOOL_NAMES = [
  "spot_observe",
  "spot_avatar_state",
  "spot_rooms",
  "spot_join",
  "spot_leave",
  "spot_move",
  "spot_teleport",
  "spot_move_to_room",
  "spot_face",
  "spot_emote",
] as const;

export interface SpotToolFactoryContext {
  getConfig: () => OpenClawConfig | undefined;
  accountId?: string | null;
}

export interface SpotToolDependencies {
  createClient?: (account: ResolvedSpotAccount) => SpotClient;
}

type ToolParams = Record<string, unknown>;

const commonProperties = {
  accountId: Type.Optional(
    Type.String({
      description: "Named channels.spot account. Omit to use the active/default account.",
    }),
  ),
  worldId: Type.Optional(
    Type.String({
      description: "Spot world id. Omit to use channels.spot.worldId.",
    }),
  ),
};

const finiteNumber = (description: string) =>
  Type.Number({ description, minimum: -1_000_000, maximum: 1_000_000 });

const optionalFiniteNumber = (description: string) =>
  Type.Optional(finiteNumber(description));

const optionalFacing = Type.Optional(
  Type.Number({
    description: "Avatar facing angle in radians.",
    minimum: -100_000,
    maximum: 100_000,
  }),
);

const readString = (
  params: ToolParams,
  key: string,
  options: { required?: boolean } = {},
): string | undefined => {
  const value = params[key];
  if (value === undefined || value === null) {
    if (options.required) throw new Error(`${key} is required.`);
    return undefined;
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} must be a non-empty string.`);
  }
  return value.trim();
};

const readNumber = (
  params: ToolParams,
  key: string,
  options: { required?: boolean } = {},
): number | undefined => {
  const value = params[key];
  if (value === undefined || value === null) {
    if (options.required) throw new Error(`${key} is required.`);
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${key} must be a finite number.`);
  }
  return value;
};

const resolveExecution = (
  context: SpotToolFactoryContext,
  dependencies: SpotToolDependencies,
  params: ToolParams,
): { account: ResolvedSpotAccount; client: SpotClient; worldId: string } => {
  const cfg = context.getConfig();
  if (!cfg) throw new Error("OpenClaw runtime config is unavailable.");
  const accountId = readString(params, "accountId") ?? context.accountId;
  const account = resolveSpotAccount(cfg, accountId);
  const worldId = readString(params, "worldId") ?? account.worldId;
  if (!worldId) {
    throw new Error(
      "A Spot worldId is required. Configure channels.spot.worldId or pass worldId.",
    );
  }
  const client =
    dependencies.createClient?.(account) ??
    new SpotClient({ baseUrl: account.baseUrl, token: account.token });
  return { account, client, worldId };
};

const roomMatches = (room: SpotWorldSpot, selector: string): boolean => {
  const normalized = selector.toLocaleLowerCase();
  return (
    room.id === selector ||
    room.slug.toLocaleLowerCase() === normalized ||
    room.name.toLocaleLowerCase() === normalized
  );
};

const describeFailure = (error: unknown): Error => {
  if (error instanceof SpotApiError) {
    return new Error(
      `${error.message}${error.code ? ` (code: ${error.code})` : ""}`,
      { cause: error },
    );
  }
  return error instanceof Error ? error : new Error(String(error));
};

const makeTool = (tool: AnyAgentTool): AnyAgentTool => ({
  ...tool,
  executionMode: "sequential",
  async execute(toolCallId, params, signal, onUpdate) {
    try {
      return await tool.execute(toolCallId, params, signal, onUpdate);
    } catch (error) {
      throw describeFailure(error);
    }
  },
});

export const createSpotTools = (
  context: SpotToolFactoryContext,
  dependencies: SpotToolDependencies = {},
): AnyAgentTool[] => [
  makeTool({
    name: "spot_observe",
    label: "Observe Spot",
    description:
      "Inspect the managed avatar, visible avatars, and available rooms in a Spot world before deciding how to act.",
    parameters: Type.Object(commonProperties, { additionalProperties: false }),
    async execute(_toolCallId, rawParams) {
      const params = rawParams as ToolParams;
      const { client, worldId } = resolveExecution(context, dependencies, params);
      const [avatar, avatars, rooms] = await Promise.all([
        client.getAvatarState(worldId),
        client.getWorldAvatars(worldId),
        client.getSpots(worldId),
      ]);
      return jsonResult({ ok: true, worldId, avatar, avatars, rooms });
    },
  }),
  makeTool({
    name: "spot_avatar_state",
    label: "Get Spot avatar state",
    description: "Get the managed avatar's current join, room, position, and facing state.",
    parameters: Type.Object(commonProperties, { additionalProperties: false }),
    async execute(_toolCallId, rawParams) {
      const params = rawParams as ToolParams;
      const { client, worldId } = resolveExecution(context, dependencies, params);
      const avatar = await client.getAvatarState(worldId);
      return jsonResult({ ok: true, worldId, avatar });
    },
  }),
  makeTool({
    name: "spot_rooms",
    label: "List Spot rooms",
    description:
      "List rooms/spots in the configured world, including their chat thread ids and access decisions.",
    parameters: Type.Object(commonProperties, { additionalProperties: false }),
    async execute(_toolCallId, rawParams) {
      const params = rawParams as ToolParams;
      const { client, worldId } = resolveExecution(context, dependencies, params);
      const rooms = await client.getSpots(worldId);
      return jsonResult({ ok: true, worldId, rooms });
    },
  }),
  makeTool({
    name: "spot_join",
    label: "Join Spot world",
    description:
      "Join or rejoin the managed avatar to a Spot world, optionally in a particular room and position.",
    parameters: Type.Object(
      {
        ...commonProperties,
        spotId: Type.Optional(Type.String({ description: "Room/spot id to join." })),
        x: optionalFiniteNumber("Optional world X position."),
        z: optionalFiniteNumber("Optional world Z position."),
        facing: optionalFacing,
        ttlSeconds: Type.Optional(
          Type.Integer({
            description: "Optional avatar lease duration in seconds.",
            minimum: 30,
            maximum: 3_600,
          }),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, rawParams) {
      const params = rawParams as ToolParams;
      const { client, worldId } = resolveExecution(context, dependencies, params);
      const spotId = readString(params, "spotId");
      const x = readNumber(params, "x");
      const z = readNumber(params, "z");
      if ((x === undefined) !== (z === undefined)) {
        throw new Error("x and z must be supplied together.");
      }
      const facing = readNumber(params, "facing");
      const ttlSeconds = readNumber(params, "ttlSeconds");
      const avatar = await client.joinAvatar(worldId, {
        ...(spotId ? { spotId } : {}),
        ...(x === undefined || z === undefined ? {} : { position: { x, z } }),
        ...(facing === undefined ? {} : { facing }),
        ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
      });
      return jsonResult({ ok: true, worldId, avatar });
    },
  }),
  makeTool({
    name: "spot_leave",
    label: "Leave Spot world",
    description: "Remove the managed avatar from the Spot world.",
    parameters: Type.Object(commonProperties, { additionalProperties: false }),
    async execute(_toolCallId, rawParams) {
      const params = rawParams as ToolParams;
      const { client, worldId } = resolveExecution(context, dependencies, params);
      await client.leaveAvatar(worldId);
      return jsonResult({ ok: true, worldId, avatar: { joined: false } });
    },
  }),
  makeTool({
    name: "spot_move",
    label: "Move Spot avatar",
    description:
      "Move the managed avatar to a reachable coordinate. Use spot_observe first when context is uncertain.",
    parameters: Type.Object(
      {
        ...commonProperties,
        x: finiteNumber("Destination world X coordinate."),
        z: finiteNumber("Destination world Z coordinate."),
        facing: optionalFacing,
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, rawParams) {
      const params = rawParams as ToolParams;
      const { client, worldId } = resolveExecution(context, dependencies, params);
      const x = readNumber(params, "x", { required: true })!;
      const z = readNumber(params, "z", { required: true })!;
      const facing = readNumber(params, "facing");
      const avatar = await client.moveAvatar(worldId, {
        x,
        z,
        ...(facing === undefined ? {} : { facing }),
      });
      return jsonResult({ ok: true, worldId, avatar });
    },
  }),
  makeTool({
    name: "spot_teleport",
    label: "Teleport Spot avatar",
    description:
      "Teleport the managed avatar to an exact coordinate when ordinary movement is not appropriate.",
    parameters: Type.Object(
      {
        ...commonProperties,
        x: finiteNumber("Destination world X coordinate."),
        z: finiteNumber("Destination world Z coordinate."),
        facing: optionalFacing,
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, rawParams) {
      const params = rawParams as ToolParams;
      const { client, worldId } = resolveExecution(context, dependencies, params);
      const x = readNumber(params, "x", { required: true })!;
      const z = readNumber(params, "z", { required: true })!;
      const facing = readNumber(params, "facing");
      const avatar = await client.teleportAvatar(worldId, {
        x,
        z,
        ...(facing === undefined ? {} : { facing }),
      });
      return jsonResult({ ok: true, worldId, avatar });
    },
  }),
  makeTool({
    name: "spot_move_to_room",
    label: "Move Spot avatar to room",
    description:
      "Discover a room by id, slug, or exact name and join/reposition the managed avatar there without guessing coordinates.",
    parameters: Type.Object(
      {
        ...commonProperties,
        room: Type.String({ description: "Room id, slug, or exact room name." }),
        facing: optionalFacing,
        ttlSeconds: Type.Optional(
          Type.Integer({ minimum: 30, maximum: 3_600 }),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, rawParams) {
      const params = rawParams as ToolParams;
      const { client, worldId } = resolveExecution(context, dependencies, params);
      const selector = readString(params, "room", { required: true })!;
      const rooms = await client.getSpots(worldId);
      const room = rooms.find((candidate) => roomMatches(candidate, selector));
      if (!room) {
        throw new Error(`Spot room ${selector} was not found in world ${worldId}.`);
      }
      if (!room.canAccess) {
        throw new Error(
          `Spot room ${room.name} is not accessible (${room.accessDeniedReason ?? "spot_access_denied"}).`,
        );
      }
      const facing = readNumber(params, "facing");
      const ttlSeconds = readNumber(params, "ttlSeconds");
      const avatar = await client.joinAvatar(worldId, {
        spotId: room.id,
        ...(facing === undefined ? {} : { facing }),
        ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
      });
      return jsonResult({ ok: true, worldId, room, avatar });
    },
  }),
  makeTool({
    name: "spot_face",
    label: "Turn Spot avatar",
    description: "Set the managed avatar's facing angle in radians.",
    parameters: Type.Object(
      {
        ...commonProperties,
        facing: Type.Number({
          description: "Facing angle in radians.",
          minimum: -100_000,
          maximum: 100_000,
        }),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, rawParams) {
      const params = rawParams as ToolParams;
      const { client, worldId } = resolveExecution(context, dependencies, params);
      const facing = readNumber(params, "facing", { required: true })!;
      const avatar = await client.setAvatarFacing(worldId, facing);
      return jsonResult({ ok: true, worldId, avatar });
    },
  }),
  makeTool({
    name: "spot_emote",
    label: "Emote as Spot avatar",
    description:
      "Play an emoji or animation on the managed avatar. At least one name is required.",
    parameters: Type.Object(
      {
        ...commonProperties,
        emojiName: Type.Optional(Type.String({ description: "Spot emoji name." })),
        animationName: Type.Optional(
          Type.String({ description: "Spot avatar animation name." }),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, rawParams) {
      const params = rawParams as ToolParams;
      const { client, worldId } = resolveExecution(context, dependencies, params);
      const emojiName = readString(params, "emojiName");
      const animationName = readString(params, "animationName");
      if (!emojiName && !animationName) {
        throw new Error("emojiName or animationName is required.");
      }
      const avatar = await client.emote(worldId, {
        ...(emojiName ? { emojiName } : {}),
        ...(animationName ? { animationName } : {}),
      });
      return jsonResult({ ok: true, worldId, avatar });
    },
  }),
];
