// The real Visual proof server on the SDK's fake plugin host, for tests and the screenshot proof.
// Every RPC, CLI call and HTTP route goes through the real contract validation, SQLite store and media files.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin, { type rpcContract } from "../server.js";

type Method = keyof typeof rpcContract;
export type SentMessage = { threadId: string; text: string; images: string[] };
export type PullRequestState = { headSha: string; title: string; state: "OPEN" | "CLOSED" | "MERGED" };

export const HOST_ID = "host-build";
export const THREAD_ID = "thr-implementer";
export const PROJECT_ID = "proj-shop";

/** Minimal files whose magic bytes identify them; enough for the store, not for a browser. */
export const fixtures = {
  png: (seed = 0) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`png-${seed}`)]),
  webm: (seed = 0) => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from(`webm-${seed}`)]),
  svg: () => Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>"),
};

export async function createBackend(options: { appUrl?: string | null; settings?: Record<string, string | boolean> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "visual-proof-"));
  const hostFiles = new Map<string, Buffer>();
  const pullRequests = new Map<string, PullRequestState>();
  const sent: SentMessage[] = [];
  const uploads: Array<{ projectId: string; filename: string; bytes: number; data: Buffer }> = [];
  const comments = new Map<string, string>();
  const statuses: Array<{ repository: string; sha: string; state: string; context: string; targetUrl: string | null }> = [];
  let sendError: string | null = null;
  // Records the message, then fails like a send whose acknowledgement was lost.
  let loseNextAck = false;
  let githubError: string | null = null;
  let statusError: string | null = null;
  // One-shot gate for the next postStatus call, and a flag that it is waiting.
  let statusGate: Promise<void> | null = null;
  let statusWaiting = false;
  // One-shot gate: the next prHead call waits until the test releases it.
  let headGate: Promise<void> | null = null;

  const host = createFakePluginHost({
    pluginId: "visual-proof",
    dataDir: dir,
    appUrl: options.appUrl === undefined ? "https://bb.example.test" : options.appUrl,
    settings: options.settings,
    sdk: {
      hosts: { list: async () => [{ id: HOST_ID, status: "connected" }] as never },
      threads: {
        get: async ({ threadId }) => makeThreadResponse({ id: threadId, projectId: PROJECT_ID, environmentId: "env-1" }),
        send: async ({ threadId, input }) => {
          if (sendError) throw new Error(sendError);
          sent.push({
            threadId,
            text: input.map((part) => (part.type === "text" ? part.text : "")).join(""),
            images: input.flatMap((part) => (part.type === "localImage" ? [part.path] : [])),
          });
          if (loseNextAck) {
            loseNextAck = false;
            throw new Error("socket hang up");
          }
          return { ok: true, delivery: "sent" } as never;
        },
        queuedMessages: { list: async () => [] },
        // The thread history holds every message sent so far, newest first, like BB's turn-request events.
        events: {
          list: async ({ threadId }: { threadId: string }) => sent
            .map((message, index) => ({ message, seq: index + 1 }))
            .filter(({ message }) => message.threadId === threadId)
            .reverse()
            .map(({ message, seq }) => ({ type: "client/turn/requested", seq, data: { input: [{ type: "text", text: message.text }] } })) as never,
        },
      },
      environments: { get: async () => ({ id: "env-1", hostId: HOST_ID }) as never },
      projects: {
        attachments: {
          upload: async (args) => {
            const { projectId, filename } = args;
            uploads.push({ projectId, filename: filename ?? "", bytes: (args.clientFile as Uint8Array).byteLength, data: Buffer.from(args.clientFile as Uint8Array) });
            return { path: `.bb/attachments/${filename}` } as never;
          },
        },
      },
      files: {
        write: async ({ path, content, contentEncoding, expectedSha256 }) => {
          const current = hostFiles.get(path);
          const currentSha256 = current ? createHash("sha256").update(current).digest("hex") : null;
          if (expectedSha256 !== undefined && expectedSha256 !== currentSha256) return { outcome: "conflict", currentSha256 };
          const bytes = Buffer.from(content, contentEncoding === "base64" ? "base64" : "utf8");
          hostFiles.set(path, bytes);
          return { outcome: "written", sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length };
        },
        read: async ({ hostId, path }: { hostId?: string; path: string }) => {
          if (hostId !== HOST_ID) throw new Error(`Read on unexpected machine ${hostId}.`);
          const bytes = hostFiles.get(path);
          if (!bytes) throw new Error(`ENOENT: ${path}`);
          return { content: bytes.toString("base64"), contentEncoding: "base64", path, sha256: "x", sizeBytes: bytes.length } as never;
        },
        listPaths: async ({ path }: { path: string }) => ({
          paths: [...hostFiles.keys()].filter((file) => file.startsWith(`${path}/`)).map((file) => ({ path: file.slice(path.length + 1), kind: "file" })),
        }) as never,
      },
    },
    experimental_callHostRpc: (call) => {
      const input = call.input as Record<string, unknown>;
      const key = `${input.repository}#${input.number}`;
      if (githubError) throw new Error(githubError);
      if (call.method === "prHead" && headGate) {
        const gate = headGate;
        headGate = null;
        return gate.then(() => {
          const pr = pullRequests.get(key)!;
          return { headSha: pr.headSha, title: pr.title, url: `https://github.com/${input.repository}/pull/${input.number}`, state: pr.state };
        });
      }
      if (call.method === "prHead") {
        const pr = pullRequests.get(key);
        if (!pr) throw new Error(`gh failed: no pull request ${key}`);
        return { headSha: pr.headSha, title: pr.title, url: `https://github.com/${input.repository}/pull/${input.number}`, state: pr.state };
      }
      if (call.method === "upsertComment") {
        const created = !comments.has(key);
        comments.set(key, input.body as string);
        return { url: `https://github.com/${input.repository}/pull/${input.number}#issuecomment-1`, created };
      }
      if (call.method === "postStatus" && statusGate) {
        const gate = statusGate;
        statusGate = null;
        statusWaiting = true;
        return gate.then(() => {
          statusWaiting = false;
          statuses.push({
            repository: input.repository as string, sha: input.sha as string, state: input.state as string,
            context: input.context as string, targetUrl: input.targetUrl as string | null,
          });
          return { ok: true };
        });
      }
      if (call.method === "postStatus") {
        if (statusError) throw new Error(statusError);
        statuses.push({
          repository: input.repository as string, sha: input.sha as string, state: input.state as string,
          context: input.context as string, targetUrl: input.targetUrl as string | null,
        });
        return { ok: true };
      }
      throw new Error(`Unexpected host method ${call.method}`);
    },
  });
  await plugin(host.bb);

  const rpc = <M extends Method>(method: M, input?: unknown) => host.harness.behavior.callRpc(method, input) as Promise<never>;
  const cli = (argv: string[], ctx: { threadId?: string; cwd?: string } = { threadId: THREAD_ID, cwd: "/work/repo" }) =>
    host.harness.behavior.runCli(argv, { ...ctx, signal: new AbortController().signal } as never);
  const setPr = (repository: string, number: number, state: Partial<PullRequestState> & { headSha: string }) =>
    pullRequests.set(`${repository}#${number}`, { title: `PR ${number}`, state: "OPEN", ...pullRequests.get(`${repository}#${number}`), ...state });

  return {
    host,
    rpc,
    cli,
    fetch: (path: string, init?: RequestInit) => host.harness.behavior.fetchHttp("GET", path, init),
    hostFiles,
    setPr,
    sent,
    uploads,
    comments,
    statuses,
    signals: () => host.harness.realtimeSignals,
    failSends: (message: string | null) => { sendError = message; },
    failGithub: (message: string | null) => { githubError = message; },
    loseNextAck: () => { loseNextAck = true; },
    failStatus: (message: string | null) => { statusError = message; },
    /** Holds the next status post until released; `statusHeld()` tells whether it is waiting. */
    holdNextStatus: () => {
      let release!: () => void;
      statusGate = new Promise<void>((resolve) => { release = resolve; });
      return release;
    },
    statusHeld: () => statusWaiting,
    /** Holds the next PR head lookup until the returned function is called. */
    holdNextHeadCheck: () => {
      let release!: () => void;
      headGate = new Promise<void>((resolve) => { release = resolve; });
      return release;
    },
    revision: (setId: string) => (host.bb.storage.database().prepare("SELECT revision FROM proof_sets WHERE id = ?").get(setId) as { revision: number }).revision,
    db: () => host.bb.storage.database(),
    mediaDir: () => join(dirname(host.bb.storage.database().name), "media"),
    dataDir: dir,
    dispose: async () => {
      await host.harness.lifecycle.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export type Backend = Awaited<ReturnType<typeof createBackend>>;
