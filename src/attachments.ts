import type { InboundMediaFacts } from "openclaw/plugin-sdk/channel-inbound";
import { runTasksWithConcurrency } from "openclaw/plugin-sdk/concurrency-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";

import type { SpotClient, SpotRequestOptions } from "./client.js";
import type { SpotAttachedFile, SpotMessageEvent } from "./types.js";

const attachmentUrl = (file: SpotAttachedFile): string | undefined => {
  const url = file.url?.trim();
  return url || undefined;
};

export const hasSpotAttachmentUrl = (file: SpotAttachedFile): boolean =>
  !!attachmentUrl(file);

/**
 * Older Spot Agent Gateway payloads contain attachment names but not download
 * metadata. Hydrate only those messages through the already-authorized event
 * endpoint; upgraded servers avoid the extra request.
 */
export const hydrateSpotAttachedFiles = async (
  client: Pick<SpotClient, "getEvent">,
  event: Pick<SpotMessageEvent, "id" | "attachedFiles">,
  options?: SpotRequestOptions,
): Promise<SpotAttachedFile[]> => {
  if (
    event.attachedFiles.length === 0 ||
    event.attachedFiles.every(hasSpotAttachmentUrl)
  ) {
    return event.attachedFiles;
  }

  const hydratedEvent = await client.getEvent(event.id, options);
  const hydratedFiles = hydratedEvent.payload?.attachedFiles;
  return Array.isArray(hydratedFiles) && hydratedFiles.length > 0
    ? hydratedFiles
    : event.attachedFiles;
};

type SpotMediaRuntime = Pick<
  PluginRuntime["channel"]["media"],
  "saveRemoteMedia"
>;

export interface MaterializedSpotAttachments {
  media: InboundMediaFacts[];
  unavailable: SpotAttachedFile[];
  errors: Array<{ file: SpotAttachedFile; error: unknown }>;
}

type SpotAttachmentMaterializationResult =
  | { status: "available"; media: InboundMediaFacts }
  | { status: "missing"; file: SpotAttachedFile }
  | { status: "error"; file: SpotAttachedFile; error: unknown };

const SPOT_ATTACHMENT_DOWNLOAD_CONCURRENCY = 3;
const SPOT_ATTACHMENT_DOWNLOAD_MAX_BYTES = 20 * 1024 * 1024;
const SPOT_ATTACHMENT_DOWNLOAD_MAX_FILES = 10;
const SPOT_ATTACHMENT_DOWNLOAD_TIMEOUT_MS = 30_000;
const SPOT_ATTACHMENT_NOTICE_MAX_NAMES = 5;
const SPOT_ATTACHMENT_NOTICE_MAX_NAME_LENGTH = 120;

/**
 * Downloads Spot attachments through OpenClaw's guarded media store. Supplying
 * a local path as well as the source URL keeps every file visible to the
 * prompt and sandbox pipeline, including documents without a built-in media
 * understanding provider.
 */
export const materializeSpotAttachedFiles = async (
  mediaRuntime: SpotMediaRuntime,
  files: SpotAttachedFile[],
  messageId: string,
  options?: SpotRequestOptions,
): Promise<MaterializedSpotAttachments> => {
  const timeoutMs =
    options?.timeoutMs ?? SPOT_ATTACHMENT_DOWNLOAD_TIMEOUT_MS;
  const downloadableFiles = files.slice(0, SPOT_ATTACHMENT_DOWNLOAD_MAX_FILES);
  const overflowFiles = files.slice(SPOT_ATTACHMENT_DOWNLOAD_MAX_FILES);
  const { results } = await runTasksWithConcurrency({
    limit: SPOT_ATTACHMENT_DOWNLOAD_CONCURRENCY,
    tasks: downloadableFiles.map(
      (file) => async (): Promise<SpotAttachmentMaterializationResult> => {
        const url = attachmentUrl(file);
        if (!url) return { status: "missing", file };
        const contentType = file.mimeType?.trim() || undefined;
        const fileName = file.name?.trim() || undefined;
        try {
          const saved = await mediaRuntime.saveRemoteMedia({
            url,
            ...(fileName
              ? { filePathHint: fileName, originalFilename: fileName }
              : {}),
            ...(contentType ? { fallbackContentType: contentType } : {}),
            maxBytes: SPOT_ATTACHMENT_DOWNLOAD_MAX_BYTES,
            timeoutMs,
            readIdleTimeoutMs: timeoutMs,
            ...(options?.signal
              ? { requestInit: { signal: options.signal } }
              : {}),
          });
          const resolvedContentType = saved.contentType || contentType;
          return {
            status: "available",
            media: {
              path: saved.path,
              url,
              ...(resolvedContentType
                ? { contentType: resolvedContentType }
                : {}),
              messageId,
            },
          };
        } catch (error) {
          return { status: "error", file, error };
        }
      },
    ),
  });

  return {
    media: results.flatMap((result) =>
      result.status === "available" ? [result.media] : [],
    ),
    unavailable: results.flatMap((result) =>
      result.status !== "available" ? [result.file] : [],
    ).concat(overflowFiles),
    errors: results.flatMap((result) =>
      result.status === "error"
        ? [{ file: result.file, error: result.error }]
        : [],
    ),
  };
};

export const formatUnavailableSpotAttachments = (
  files: SpotAttachedFile[],
): string | undefined => {
  if (files.length === 0) return undefined;
  const names = files
    .slice(0, SPOT_ATTACHMENT_NOTICE_MAX_NAMES)
    .map((file) =>
      file.name
        ?.replace(/\s+/g, " ")
        .trim()
        .slice(0, SPOT_ATTACHMENT_NOTICE_MAX_NAME_LENGTH),
    )
    .filter((name): name is string => !!name);
  if (names.length === 0) {
    return files.length === 1
      ? "Spot could not make an attachment available."
      : `Spot could not make ${files.length} attachments available.`;
  }
  const namesSuffix = names.length < files.length ? ", and more" : "";
  return files.length === 1
    ? `Spot could not make attachment available: ${names[0]}.`
    : `Spot could not make ${files.length} attachments available: ${names.join(", ")}${namesSuffix}.`;
};
