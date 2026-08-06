import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  OpenClawConfig,
  PluginRuntime,
} from "openclaw/plugin-sdk/core";
import { describe, expect, it, vi } from "vitest";

import type { SpotClient } from "./client.js";
import type { ResolvedSpotAccount, SpotMessageEvent } from "./types.js";

describe("OpenClaw runtime integration", () => {
  it("runs an attachment-only Spot turn through the real dispatcher", async () => {
    const stateDir = await mkdtemp(
      join(tmpdir(), "spot-openclaw-runtime-integration-"),
    );
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const previousTestFast = process.env.OPENCLAW_TEST_FAST;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    process.env.OPENCLAW_TEST_FAST = "1";

    try {
      // OpenClaw resolves and opens its state database when these modules load.
      // Importing after the environment setup keeps this test isolated from the
      // user's real OpenClaw state.
      const [{ dispatchSpotMessage }, channelInbound, replyRuntime] =
        await Promise.all([
          import("./gateway.js"),
          import("openclaw/plugin-sdk/channel-inbound"),
          import("openclaw/plugin-sdk/reply-runtime"),
        ]);
      const {
        buildChannelInboundEventContext,
        dispatchChannelInboundReply,
      } = channelInbound;
      const { dispatchReplyWithBufferedBlockDispatcher } = replyRuntime;

      const getOrCreateEventThread = vi
        .fn()
        .mockResolvedValue({ id: "reply-thread-1" });
      const setThreadTyping = vi.fn().mockResolvedValue(undefined);
      const sendThreadMessage = vi
        .fn()
        .mockResolvedValue({ id: "reply-event-1" });
      const savedAttachmentPath = join(stateDir, "media", "report.xlsx");
      const saveRemoteMedia = vi.fn().mockResolvedValue({
        id: "report-id",
        path: savedAttachmentPath,
        size: 123,
        contentType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const client = {
        getOrCreateEventThread,
        setThreadTyping,
        sendThreadMessage,
      } as unknown as SpotClient;

      const resolveAgentRoute = vi.fn(
        ({ peer }: { peer: { id: string } }) => ({
          agentId: "main",
          sessionKey: `agent:main:spot:group:${peer.id}`,
        }),
      );
      const runtime = {
        routing: { resolveAgentRoute },
        inbound: {
          buildContext: buildChannelInboundEventContext,
          dispatchReply: (
            params: Parameters<typeof dispatchChannelInboundReply>[0],
          ) =>
            dispatchChannelInboundReply({
              ...params,
              // This replaces only the model call. The OpenClaw dispatcher,
              // option merging, typing lifecycle, and delivery are real.
              replyResolver: async (context, options) => {
                expect(context).toEqual(
                  expect.objectContaining({
                    BodyForAgent: "",
                    MediaPath: savedAttachmentPath,
                    MediaPaths: [savedAttachmentPath],
                    MediaUrl: "https://spot.test/files/report.xlsx",
                    MediaUrls: ["https://spot.test/files/report.xlsx"],
                    MediaType:
                      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                  }),
                );
                await options?.onReplyStart?.();
                return { text: "runtime integration reply" };
              },
            }),
        },
        media: { saveRemoteMedia },
        session: {
          resolveStorePath: () => join(stateDir, "sessions.json"),
          recordInboundSession: vi.fn(async () => undefined),
        },
        reply: { dispatchReplyWithBufferedBlockDispatcher },
      } as unknown as PluginRuntime["channel"];

      const account: ResolvedSpotAccount = {
        accountId: "default",
        enabled: true,
        baseUrl: "https://spot.test",
        token: "token",
        orgId: "org-1",
        activationMode: "all",
        allowFrom: ["user-1"],
        allowBotMessages: false,
        subscribeWorlds: [],
        subscribeThreads: [],
        monitorOrgChannels: true,
      };
      const event: SpotMessageEvent = {
        id: "root-event-1",
        threadId: "channel-1",
        thread: {
          id: "channel-1",
          type: "Channel",
          name: "general",
          orgId: "org-1",
          isPrivate: false,
          spotId: null,
          parentEventId: null,
        },
        userId: "user-1",
        user: {
          id: "user-1",
          fullName: "Ada User",
          displayName: "Ada",
          isBot: false,
        },
        timestamp: "2026-07-21T12:00:00.000Z",
        message: "",
        text: "",
        attachedFiles: [
          {
            name: "report.xlsx",
            mimeType:
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            size: 123,
            url: "https://spot.test/files/report.xlsx",
          },
        ],
        mentions: [],
        isMentioned: true,
        isDirectMessage: false,
      };

      await dispatchSpotMessage({
        cfg: {} as OpenClawConfig,
        account,
        runtime,
        client,
        event,
      });

      expect(getOrCreateEventThread).toHaveBeenCalledWith("root-event-1", {
        signal: undefined,
      });
      expect(saveRemoteMedia).toHaveBeenCalledWith({
        url: "https://spot.test/files/report.xlsx",
        filePathHint: "report.xlsx",
        originalFilename: "report.xlsx",
        fallbackContentType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        maxBytes: 20 * 1024 * 1024,
        timeoutMs: 30_000,
        readIdleTimeoutMs: 30_000,
      });
      expect(setThreadTyping.mock.calls).toEqual([
        ["channel-1", false, { signal: undefined }],
        ["channel-1", true],
      ]);
      expect(sendThreadMessage).toHaveBeenCalledWith(
        "reply-thread-1",
        "runtime integration reply",
        { signal: undefined },
      );
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      if (previousTestFast === undefined) {
        delete process.env.OPENCLAW_TEST_FAST;
      } else {
        process.env.OPENCLAW_TEST_FAST = previousTestFast;
      }
      await rm(stateDir, { force: true, recursive: true });
    }
  });
});
