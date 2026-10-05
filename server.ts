import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  COMMENT_MARKER,
  LIMITS,
  STATUS_CONTEXT,
  annotationInputSchema,
  annotationSchema,
  assetSchema,
  idSchema,
  prNumberSchema,
  proofSetSchema,
  repositorySchema,
  setDetailSchema,
  setSummarySchema,
  usageSchema,
  type ProofSet,
} from "./src/contract.js";
import { hostContract } from "./src/host-contract.js";
import { inspectRaster, parseRange } from "./src/media.js";
import { approvalMessage, deliveryMarker, panelUrl, prCommentBody, sendBackMessage, statusDescription } from "./src/messages.js";
import { ProofStore } from "./src/store.js";
import { registerCli } from "./src/cli.js";

export const CHANGED_CHANNEL = "visual-proof-changed";
const base64Schema = z.string().min(1).max(Math.ceil(LIMITS.renderBytes / 3) * 4 + 4);
const revisionSchema = z.number().int().positive();
const decisionSchema = z.object({ set: proofSetSchema, warnings: z.array(z.string()) }).strict();

export const rpcContract = defineRpcContract({
  proofs_list: {
    input: z.object({ repository: repositorySchema.optional(), view: z.enum(["open", "done"]).default("open") }).strict(),
    output: z.object({
      sets: z.array(setSummarySchema), openCount: z.number(), doneCount: z.number(),
      repositories: z.array(z.string()), usage: usageSchema,
    }).strict(),
  },
  proofs_detail: {
    input: z.object({ repository: repositorySchema, number: prNumberSchema, setId: idSchema.optional() }).strict(),
    output: z.object({ detail: setDetailSchema.nullable(), usage: usageSchema, postCommitStatus: z.boolean() }).strict(),
  },
  proofs_check_head: {
    input: z.object({ repository: repositorySchema, number: prNumberSchema }).strict(),
    output: z.object({ set: proofSetSchema.nullable(), headSha: z.string(), prState: z.string() }).strict(),
  },
  proofs_annotation_add: { input: annotationInputSchema, output: annotationSchema },
  proofs_annotation_update: {
    input: z.object({ id: idSchema, body: z.string().trim().min(1, "Write a comment.").max(LIMITS.commentChars) }).strict(),
    output: annotationSchema,
  },
  proofs_annotation_delete: { input: z.object({ id: idSchema }).strict(), output: z.object({ ok: z.literal(true) }).strict() },
  proofs_stage_render: {
    input: z.object({ setId: idSchema, dataBase64: base64Schema }).strict(),
    output: z.object({ renderId: z.string() }).strict(),
  },
  proofs_send_back: {
    input: z.object({ setId: idSchema, revision: revisionSchema, renderIds: z.array(idSchema).max(LIMITS.rendersPerSendBack).default([]) }).strict(),
    output: decisionSchema,
  },
  proofs_approve: {
    input: z.object({ setId: idSchema, revision: revisionSchema, note: z.string().trim().max(LIMITS.commentChars).default("") }).strict(),
    output: decisionSchema,
  },
  proofs_retry: { input: z.object({ setId: idSchema }).strict(), output: decisionSchema },
  proofs_thumbnail_put: {
    input: z.object({ assetId: idSchema, dataBase64: z.string().min(1).max(Math.ceil(LIMITS.thumbnailBytes / 3) * 4 + 4) }).strict(),
    output: assetSchema,
  },
  proofs_delete_media: { input: z.object({ setId: idSchema }).strict(), output: proofSetSchema },
  proofs_pending_count: { input: z.null(), output: z.object({ count: z.number() }).strict() },
});

type TextPart = { type: string; text?: string };
const hasMarker = (parts: readonly TextPart[], marker: string) => parts.some((part) => part.type === "text" && part.text?.includes(marker));
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);
const mediaHeaders = (mime: string) => ({
  "content-type": mime,
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; sandbox",
  "cache-control": "private, max-age=31536000, immutable",
});

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    postCommitStatus: {
      type: "boolean",
      label: `Post the "${STATUS_CONTEXT}" commit status`,
      description: "On the proof's head SHA: success on approve, failure on send back, pending when new files reopen a decision. Off by default.",
      default: false,
    },
    approvedRetentionDays: { type: "select", label: "Keep media of approved proofs (days)", options: ["30", "90", "180", "365"], default: "90" },
    staleRetentionDays: { type: "select", label: "Keep media of outdated proofs (days)", options: ["7", "14", "30"], default: "14" },
    quotaGb: { type: "select", label: "Storage quota (GB)", options: ["1", "2", "5", "10"], default: "2" },
    language: {
      type: "select",
      label: "Panel language",
      description: "auto follows the browser language (German or English, else English). Messages to threads and GitHub stay English.",
      options: ["auto", "en", "de"],
      default: "auto",
    },
  });
  const store = new ProofStore(bb.storage.database(), bb.storage.migrate.bind(bb.storage));
  const applySettings = (values: Awaited<ReturnType<typeof settings.get>>) => {
    store.retention = {
      approvedDays: Number(values.approvedRetentionDays),
      staleDays: Number(values.staleRetentionDays),
      quotaBytes: Number(values.quotaGb) * 1024 * 1024 * 1024,
    };
  };
  applySettings(await settings.get());
  settings.onChange((next) => applySettings(next));
  const host = bb.hosts.experimental_client({ contract: hostContract });

  const publish = () => {
    try {
      bb.realtime.publish(CHANGED_CHANNEL, { pendingCount: store.pendingCount() });
    } catch (error) {
      bb.log.warn(`Change notification failed: ${errorText(error)}`);
    }
  };
  const link = (set: Pick<ProofSet, "repository" | "number">) => panelUrl(bb.server.experimental_appUrl, bb.pluginId, set);

  /** A connected machine with `gh`: the one the proof was uploaded from, else the first connected one. */
  const githubHost = async (preferred: string | null): Promise<string> => {
    const connected = (await bb.sdk.hosts.list()).filter((candidate) => candidate.status === "connected");
    const match = connected.find((candidate) => candidate.id === preferred) ?? connected[0];
    if (!match) throw new Error("No connected BB machine is available for GitHub.");
    return match.id;
  };

  const prHead = async (repository: string, number: number, preferredHost: string | null) =>
    host.call("prHead", { repository, number }, { hostId: await githubHost(preferredHost) });

  const updatePrComment = async (set: ProofSet, warnings: string[]) => {
    try {
      const history = store.history(set.repository, set.number);
      await host.call("upsertComment", {
        repository: set.repository, number: set.number, marker: COMMENT_MARKER,
        body: prCommentBody(history, store.assets(history[0]!.id), link(set), store.retention),
      }, { hostId: await githubHost(set.hostId) });
    } catch (error) {
      warnings.push(`PR comment not updated: ${errorText(error)}`);
    }
  };

  /**
   * Brings the set's GitHub commit status to the state its decisions want. Off unless the setting is on; a failure is
   * stored on the set, shown in the panel and retried by the delivery sweep. Calls for one set run one after another,
   * and each run re-reads the wanted state after posting, so an older post can never be the last one GitHub sees.
   */
  const statusQueues = new Map<string, Promise<void>>();
  const syncStatus = (setId: string, warnings: string[]): Promise<void> => {
    const run = (statusQueues.get(setId) ?? Promise.resolve()).then(() => syncStatusNow(setId, warnings));
    const tracked = run.finally(() => {
      if (statusQueues.get(setId) === tracked) statusQueues.delete(setId);
    });
    statusQueues.set(setId, tracked);
    return run;
  };
  const syncStatusNow = async (setId: string, warnings: string[]) => {
    if (!(await settings.get()).postCommitStatus) return;
    // Bounded: a decision changing on every round trip is not worth chasing forever; the sweep continues later.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const set = store.getSet(setId);
      const wanted = set?.githubStatus?.wanted;
      if (!set || set.stale || !wanted || set.githubStatus?.posted === wanted) return;
      try {
        await host.call("postStatus", {
          repository: set.repository, sha: set.headSha, context: STATUS_CONTEXT, state: wanted,
          description: statusDescription(set, wanted), targetUrl: link(set),
        }, { hostId: await githubHost(set.hostId) });
        store.recordStatusPosted(setId, wanted);
      } catch (error) {
        store.recordStatusError(setId, errorText(error));
        warnings.push(`Commit status not posted (will be retried): ${errorText(error)}`);
        return;
      } finally {
        publish();
      }
    }
  };

  const findRecordedMessage = async (threadId: string, marker: string): Promise<boolean> => {
    const queued = await bb.sdk.threads.queuedMessages.list({ threadId });
    if (queued.some((message) => hasMarker(message.content, marker))) return true;
    let beforeSeq: string | undefined;
    for (;;) {
      const events = await bb.sdk.threads.events.list({ threadId, types: ["client/turn/requested"], order: "desc", limit: "100", beforeSeq });
      if (events.some((event) => event.type === "client/turn/requested" && hasMarker(event.data.input, marker))) return true;
      if (events.length < 100) return false;
      const earliest = Math.min(...events.map((event) => event.seq));
      if (earliest <= 0) return false;
      if (beforeSeq && earliest >= Number(beforeSeq)) throw new Error("BB event pagination did not advance.");
      beforeSeq = String(earliest);
    }
  };

  // Annotated copies rendered in the browser wait here until the send back that uses them; they never touch disk.
  const renders = new Map<string, { setId: string; bytes: Buffer; mime: string; at: number }>();
  const pruneRenders = () => {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [id, render] of renders) if (render.at < cutoff) renders.delete(id);
  };

  const inFlight = new Set<string>();
  const exclusive = async <T>(setId: string, run: () => Promise<T>): Promise<T> => {
    if (inFlight.has(setId)) throw new Error("This proof is already being sent; wait a moment.");
    inFlight.add(setId);
    try {
      return await run();
    } finally {
      inFlight.delete(setId);
    }
  };

  /**
   * Delivers one stored decision message. The marker is looked up in the thread first, so a lost acknowledgement or a
   * retry never sends twice; the frozen text is sent unchanged.
   */
  const activeDeliveries = new Set<string>();
  const deliver = async (deliveryId: string, warnings: string[]) => {
    const delivery = store.getDelivery(deliveryId);
    if (!delivery || delivery.status === "sent" || activeDeliveries.has(deliveryId)) return;
    activeDeliveries.add(deliveryId);
    try {
      if (!await findRecordedMessage(delivery.threadId, deliveryMarker(deliveryId))) {
        await bb.sdk.threads.send({
          threadId: delivery.threadId,
          mode: "queue-if-active",
          input: [
            { type: "text", text: delivery.text, mentions: [] },
            ...delivery.images.map((path) => ({ type: "localImage" as const, path })),
          ],
        });
      }
      store.markDelivery(deliveryId, "sent");
    } catch (error) {
      store.markDelivery(deliveryId, "failed", errorText(error));
      warnings.push(`Message to the implementer thread not delivered (retry in the panel): ${errorText(error)}`);
    } finally {
      activeDeliveries.delete(deliveryId);
      publish();
    }
  };

  const sendBack = (setId: string, revision: number, renderIds: string[]) => exclusive(setId, async () => {
    const { set, annotations } = store.requireSendBack(setId, revision);
    if (!set.threadId) throw new Error("No implementer thread is known for this proof. Upload it again with --thread <id>.");
    const thread = await bb.sdk.threads.get({ threadId: set.threadId });
    pruneRenders();
    const images: string[] = [];
    for (const [index, renderId] of renderIds.entries()) {
      const render = renders.get(renderId);
      if (!render || render.setId !== setId) throw new Error("An annotated image expired; send again.");
      const uploaded = await bb.sdk.projects.attachments.upload({
        projectId: thread.projectId, clientFile: render.bytes, filename: `visual-proof-${set.number}-r${set.round}-${index + 1}.${render.mime.split("/")[1]}`,
        mimeType: render.mime,
      });
      images.push(uploaded.path);
    }
    const deliveryId = randomUUID();
    // The comments and the message are frozen together; later edits cannot slip into this round.
    const saved = store.commitSendBack({
      setId, revision, annotationIds: annotations.map((annotation) => annotation.id),
      delivery: { id: deliveryId, threadId: set.threadId, images, text: sendBackMessage(set, annotations, store.assets(setId), link(set), images.length, deliveryId) },
    });
    for (const renderId of renderIds) renders.delete(renderId);
    publish();
    const warnings: string[] = [];
    await deliver(deliveryId, warnings);
    await updatePrComment(saved, warnings);
    await syncStatus(setId, warnings);
    return { set: store.requireSet(setId), warnings };
  });

  const approve = (setId: string, revision: number, note: string) => exclusive(setId, async () => {
    const { set, annotations } = store.requireApprovable(setId, revision);
    let head: Awaited<ReturnType<typeof prHead>>;
    try {
      head = await prHead(set.repository, set.number, set.hostId);
    } catch (error) {
      throw new Error(`The PR head could not be checked, so nothing was approved: ${errorText(error)}`);
    }
    if (head.headSha !== set.headSha) {
      store.recordHead(set.repository, set.number, head.headSha);
      publish();
      throw new Error(`The PR head moved to ${head.headSha.slice(0, 7)}; this proof is outdated and was not approved.`);
    }
    const deliveryId = randomUUID();
    // Refused here when files or comments changed during the head check: the approval covers exactly `revision`.
    const saved = store.commitApproval({
      setId, revision, headSha: set.headSha, note, annotationIds: annotations.map((annotation) => annotation.id),
      delivery: set.threadId
        ? { id: deliveryId, threadId: set.threadId, images: [], text: approvalMessage(set, note, annotations, store.assets(setId), link(set), deliveryId) }
        : null,
    });
    publish();
    const warnings: string[] = [];
    if (set.threadId) await deliver(deliveryId, warnings);
    await updatePrComment(saved, warnings);
    await syncStatus(setId, warnings);
    return { set: store.requireSet(setId), warnings };
  });

  /** Retries everything a set still owes: undelivered decision messages and the GitHub status. */
  const retry = async (setId: string) => {
    const set = store.requireSet(setId);
    const warnings: string[] = [];
    for (const delivery of store.deliveries(setId)) if (delivery.status !== "sent") await deliver(delivery.id, warnings);
    await syncStatus(setId, warnings);
    return { set: store.requireSet(set.id), warnings };
  };

  const checkHead = async (repository: string, number: number) => {
    const latest = store.latestSet(repository, number);
    const head = await prHead(repository, number, latest?.hostId ?? null);
    const set = store.recordHead(repository, number, head.headSha) ?? null;
    publish();
    return { set, headSha: head.headSha, prState: head.state };
  };

  bb.http.route("GET", "/media", (context) => {
    const sha = context.req.query("sha") ?? "";
    const media = /^[0-9a-f]{64}$/.test(sha) ? store.hasMedia(sha) : undefined;
    if (!media) return new Response("Not found", { status: 404 });
    const range = parseRange(context.req.header("range"), media.bytes);
    const headers: Record<string, string> = { ...mediaHeaders(media.mime), "accept-ranges": "bytes" };
    if (range === "unsatisfiable") return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${media.bytes}` } });
    const { start, end } = range ?? { start: 0, end: media.bytes - 1 };
    const stream = Readable.toWeb(createReadStream(store.mediaPath(sha), { start, end })) as ReadableStream;
    return new Response(stream, {
      status: range ? 206 : 200,
      headers: { ...headers, "content-length": String(end - start + 1), ...(range ? { "content-range": `bytes ${start}-${end}/${media.bytes}` } : {}) },
    });
  });
  bb.http.route("GET", "/thumb", (context) => {
    const sha = context.req.query("sha") ?? "";
    const thumbnail = /^[0-9a-f]{64}$/.test(sha) ? store.thumbnail(sha) : undefined;
    if (!thumbnail) return new Response("Not found", { status: 404 });
    return new Response(new Uint8Array(thumbnail.data), { headers: mediaHeaders(thumbnail.mime) });
  });

  bb.rpc.register(rpcContract, {
    proofs_list: ({ repository, view }) => ({ ...store.listLatest({ repository, view }), repositories: store.repositories(), usage: store.usage() }),
    proofs_detail: async ({ repository, number, setId }) => ({
      detail: store.detail(repository, number, setId) ?? null,
      usage: store.usage(),
      postCommitStatus: (await settings.get()).postCommitStatus,
    }),
    proofs_check_head: ({ repository, number }) => checkHead(repository, number),
    proofs_annotation_add: (input) => { const saved = store.addAnnotation(input); publish(); return saved; },
    proofs_annotation_update: ({ id, body }) => { const saved = store.updateAnnotation(id, body); publish(); return saved; },
    proofs_annotation_delete: ({ id }) => { store.deleteAnnotation(id); publish(); return { ok: true as const }; },
    proofs_stage_render: ({ setId, dataBase64 }) => {
      store.requireSendBack(setId);
      pruneRenders();
      if ([...renders.values()].filter((render) => render.setId === setId).length >= LIMITS.rendersPerSendBack * 2) {
        throw new Error("Too many annotated images are waiting; send back first.");
      }
      const { bytes, mime } = inspectRaster(dataBase64, LIMITS.renderBytes, "Annotated image");
      const renderId = randomUUID();
      renders.set(renderId, { setId, bytes, mime, at: Date.now() });
      return { renderId };
    },
    proofs_send_back: ({ setId, revision, renderIds }) => sendBack(setId, revision, renderIds),
    proofs_approve: ({ setId, revision, note }) => approve(setId, revision, note),
    proofs_retry: ({ setId }) => retry(setId),
    proofs_thumbnail_put: ({ assetId, dataBase64 }) => {
      const { bytes, mime } = inspectRaster(dataBase64, LIMITS.thumbnailBytes, "Thumbnail");
      const saved = store.putThumbnail(assetId, mime, bytes);
      publish();
      return saved;
    },
    proofs_delete_media: ({ setId }) => { const saved = store.deleteSetMedia(setId); publish(); return saved; },
    proofs_pending_count: () => ({ count: store.pendingCount() }),
  });

  registerCli(bb, {
    store,
    prHead,
    link,
    publish,
    updatePrComment,
    syncStatus,
  });

  // Owed messages and statuses: failed ones, and pending ones a crash interrupted (older than a minute).
  bb.background.schedule("delivery-sweep", "*/10 * * * *", async () => {
    const warnings: string[] = [];
    for (const id of store.undeliveredIds(60_000)) await deliver(id, warnings);
    for (const set of store.statusesToSync()) await syncStatus(set.id, warnings);
    if (warnings.length > 0) bb.log.warn(`Delivery sweep: ${warnings.join(" | ")}`.slice(0, 2000));
  });

  bb.background.schedule("retention", "17 */6 * * *", async () => {
    const result = store.sweep();
    if (result.expiredSets.length > 0 || result.removedFiles > 0) {
      bb.log.info(`Retention: expired media of ${result.expiredSets.length} set(s), removed ${result.removedFiles} file(s).`);
      publish();
    }
  });
}
