import { describe, expect, it, vi } from "vitest";

import type { SpotClient } from "./client.js";
import {
  formatUnavailableSpotAttachments,
  hydrateSpotAttachedFiles,
  materializeSpotAttachedFiles,
} from "./attachments.js";

describe("Spot inbound attachments", () => {
  it("hydrates name-only gateway attachments through the event endpoint", async () => {
    const getEvent = vi.fn().mockResolvedValue({
      id: "event-1",
      threadId: "thread-1",
      payload: {
        attachedFiles: [
          {
            name: "image.png",
            mimeType: "image/png",
            size: 123,
            url: "https://spot.test/files/image.png",
          },
        ],
      },
    });
    const client = { getEvent } as unknown as SpotClient;
    const signal = new AbortController().signal;

    await expect(
      hydrateSpotAttachedFiles(
        client,
        { id: "event-1", attachedFiles: [{ name: "image.png" }] },
        { signal },
      ),
    ).resolves.toEqual([
      {
        name: "image.png",
        mimeType: "image/png",
        size: 123,
        url: "https://spot.test/files/image.png",
      },
    ]);
    expect(getEvent).toHaveBeenCalledWith("event-1", { signal });
  });

  it("uses complete gateway metadata without another REST request", async () => {
    const getEvent = vi.fn();
    const client = { getEvent } as unknown as SpotClient;
    const attachedFiles = [
      {
        name: "report.pdf",
        mimeType: "application/pdf",
        url: "https://spot.test/files/report.pdf",
      },
    ];

    await expect(
      hydrateSpotAttachedFiles(client, {
        id: "event-1",
        attachedFiles,
      }),
    ).resolves.toBe(attachedFiles);
    expect(getEvent).not.toHaveBeenCalled();
  });

  it("stores downloadable files for OpenClaw and reports unresolved files", async () => {
    const files = [
      {
        name: "image.png",
        mimeType: "image/png",
        url: "https://spot.test/files/image.png",
      },
      { name: "missing.pdf" },
    ];
    const saveRemoteMedia = vi.fn().mockResolvedValue({
      id: "image-id",
      path: "/openclaw/media/image.png",
      size: 123,
      contentType: "image/png",
    });

    await expect(
      materializeSpotAttachedFiles(
        { saveRemoteMedia },
        files,
        "event-1",
      ),
    ).resolves.toEqual({
      media: [
        {
          path: "/openclaw/media/image.png",
          url: "https://spot.test/files/image.png",
          contentType: "image/png",
          messageId: "event-1",
        },
      ],
      unavailable: [{ name: "missing.pdf" }],
      errors: [],
    });
    expect(saveRemoteMedia).toHaveBeenCalledWith({
      url: "https://spot.test/files/image.png",
      filePathHint: "image.png",
      originalFilename: "image.png",
      fallbackContentType: "image/png",
      maxBytes: 20 * 1024 * 1024,
      timeoutMs: 30_000,
      readIdleTimeoutMs: 30_000,
    });
    expect(formatUnavailableSpotAttachments([{ name: "missing.pdf" }])).toBe(
      "Spot could not make attachment available: missing.pdf.",
    );
  });

  it("keeps a failed download visible as an unavailable attachment", async () => {
    const file = {
      name: "report.xlsx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      url: "https://spot.test/files/report.xlsx",
    };
    const error = new Error("blocked download");

    await expect(
      materializeSpotAttachedFiles(
        { saveRemoteMedia: vi.fn().mockRejectedValue(error) },
        [file],
        "event-1",
      ),
    ).resolves.toEqual({
      media: [],
      unavailable: [file],
      errors: [{ file, error }],
    });
  });

  it("bounds downloads and unavailable attachment names", async () => {
    const files = Array.from({ length: 12 }, (_, index) => ({
      name: `report-${index + 1}.xlsx`,
      url: `https://spot.test/files/report-${index + 1}.xlsx`,
    }));
    const saveRemoteMedia = vi.fn().mockResolvedValue({
      id: "report-id",
      path: "/openclaw/media/report.xlsx",
      size: 123,
    });

    const result = await materializeSpotAttachedFiles(
      { saveRemoteMedia },
      files,
      "event-1",
    );

    expect(saveRemoteMedia).toHaveBeenCalledTimes(10);
    expect(result.media).toHaveLength(10);
    expect(result.unavailable).toEqual(files.slice(10));
    expect(formatUnavailableSpotAttachments(files)).toBe(
      "Spot could not make 12 attachments available: report-1.xlsx, report-2.xlsx, report-3.xlsx, report-4.xlsx, report-5.xlsx, and more.",
    );
  });
});
