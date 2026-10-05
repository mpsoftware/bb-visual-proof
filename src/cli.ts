import { posix } from "node:path";
import { readFile } from "node:fs/promises";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { LIMITS, type ProofSet } from "./contract.js";
import { describeAnchor } from "./messages.js";
import { formatBytes, inspectUpload } from "./media.js";
import type { ProofStore, UploadFile } from "./store.js";

type Deps = {
  store: ProofStore;
  prHead(repository: string, number: number, preferredHost: string | null): Promise<{ headSha: string; title: string; url: string; state: string }>;
  link(set: Pick<ProofSet, "repository" | "number">): string | null;
  publish(): void;
  updatePrComment(set: ProofSet, warnings: string[]): Promise<void>;
  syncStatus(setId: string, warnings: string[]): Promise<void>;
};

const usage = [
  "Usage:",
  "  bb visual-proof add <owner/repo#N | PR URL> [--sha <sha>] [--thread <id>] [--machine <host-id>] [--no-comment] [--json] [--caption <text>] <file|dir> [[--caption <text>] <file|dir>]...",
  "  bb visual-proof status <owner/repo#N | PR URL> [--json]",
  "  bb visual-proof list [--repo <owner/repo>] [--done] [--json]",
  "  bb visual-proof export <owner/repo#N | PR URL> <dir> [--sha <sha>] [--machine <host-id>] [--json]",
].join("\n");

const MEDIA_EXTENSIONS = /\.(png|jpe?g|webp|gif|webm|mp4)$/i;

export function parsePullRequest(value: string): { repository: string; number: number } {
  const url = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/i.exec(value.trim());
  const short = /^([^/\s#]+\/[^/\s#]+)#(\d+)$/.exec(value.trim());
  const match = url ?? short;
  if (!match) throw new Error(`Expected owner/repo#N or a GitHub PR URL, got "${value}".`);
  const repository = match[1]!.toLowerCase();
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repository)) throw new Error(`Invalid repository "${match[1]}".`);
  return { repository, number: Number(match[2]) };
}

/** "03-checkout_dark.png" → "03 checkout dark" */
export function captionFromFilename(path: string): string {
  return posix.basename(path).replace(MEDIA_EXTENSIONS, "").replace(/[-_]+/g, " ").trim().slice(0, LIMITS.captionChars);
}

type AddArgs = {
  pr: string; sha?: string; thread?: string; machine?: string; comment: boolean; json: boolean;
  inputs: Array<{ path: string; caption?: string }>;
};

export function parseAddArgs(args: string[]): AddArgs {
  const parsed: AddArgs = { pr: "", comment: true, json: false, inputs: [] };
  let caption: string | undefined;
  const takeValue = (index: number, name: string) => {
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${name}.`);
    return value;
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--sha") parsed.sha = takeValue(index++, arg);
    else if (arg === "--thread") parsed.thread = takeValue(index++, arg);
    else if (arg === "--machine") parsed.machine = takeValue(index++, arg);
    else if (arg === "--caption") {
      if (caption !== undefined) throw new Error("--caption must be followed by a file.");
      caption = takeValue(index++, arg).trim().slice(0, LIMITS.captionChars);
    } else if (arg === "--no-comment") parsed.comment = false;
    else if (arg === "--json") parsed.json = true;
    else if (arg.startsWith("--")) throw new Error(`Unknown option ${arg}.`);
    else if (!parsed.pr) parsed.pr = arg;
    else {
      parsed.inputs.push({ path: arg, caption });
      caption = undefined;
    }
  }
  if (caption !== undefined) throw new Error("--caption must be followed by a file.");
  if (!parsed.pr) throw new Error("Name the pull request.");
  if (parsed.inputs.length === 0) throw new Error("Name at least one file or directory.");
  return parsed;
}

function setLine(set: ProofSet): string {
  const state = set.stale ? `outdated (${set.staleReason === "head_moved" ? "head moved" : "superseded"})`
    : set.status === "changes_requested" ? "changes requested" : set.status === "approved" ? "approved" : "review pending";
  return `${set.repository}#${set.number} head ${set.headSha.slice(0, 7)}: ${state}, round ${set.round}, ${set.imageCount} screenshot(s), ${set.videoCount} screencast(s)`;
}

export function registerCli(bb: BbPluginApi, deps: Deps): void {
  const { store } = deps;

  /** Every path names a file on the machine that ran the command, never on the server. */
  const invokingHost = async (ctx: { threadId?: string }, machine?: string): Promise<string> => {
    if (machine) return machine;
    if (!ctx.threadId) throw new Error("Run this inside a BB thread or pass --machine <host-id>.");
    const thread = await bb.sdk.threads.get({ threadId: ctx.threadId });
    if (!thread.environmentId) throw new Error("The calling thread has no environment; pass --machine <host-id>.");
    const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
    if (!environment.hostId) throw new Error("The calling thread's environment has no machine; pass --machine <host-id>.");
    return environment.hostId;
  };

  const expandInputs = async (hostId: string, cwd: string | undefined, inputs: AddArgs["inputs"]) => {
    const files: Array<{ path: string; caption: string }> = [];
    for (const input of inputs) {
      if (!posix.isAbsolute(input.path) && !cwd) throw new Error(`${input.path}: use an absolute path; the command has no working directory.`);
      const path = posix.resolve(cwd ?? "/", input.path);
      if (MEDIA_EXTENSIONS.test(path)) {
        files.push({ path, caption: input.caption ?? captionFromFilename(path) });
        continue;
      }
      // A directory: its media files and those one level down (a prove/capture.mjs evidence dir keeps the run video in video/).
      const listing = await bb.sdk.files.listPaths({ hostId, path, includeFiles: true, includeDirectories: false, includeHidden: false });
      const found = listing.paths
        .filter((entry) => entry.kind === "file" && MEDIA_EXTENSIONS.test(entry.path) && entry.path.split("/").length <= 2)
        .map((entry) => entry.path)
        .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
      if (found.length === 0) throw new Error(`${input.path}: no PNG, JPEG, WebP, GIF, WebM or MP4 files found.`);
      for (const relative of found) files.push({ path: posix.join(path, relative), caption: captionFromFilename(relative) });
    }
    if (files.length > LIMITS.setFiles) throw new Error(`At most ${LIMITS.setFiles} files per proof set; got ${files.length}.`);
    return files;
  };

  const add = async (args: string[], ctx: { cwd?: string; threadId?: string }) => {
    const parsed = parseAddArgs(args);
    const { repository, number } = parsePullRequest(parsed.pr);
    const hostId = await invokingHost(ctx, parsed.machine);
    const threadId = parsed.thread ?? ctx.threadId ?? null;
    if (threadId) await bb.sdk.threads.get({ threadId });
    const head = await deps.prHead(repository, number, hostId);
    if (head.state !== "OPEN") throw new Error(`${repository}#${number} is ${head.state.toLowerCase()}; proof is only taken for open PRs.`);
    if (parsed.sha && !/^[0-9a-f]{7,40}$/i.test(parsed.sha)) throw new Error("--sha needs at least 7 hex characters of the commit SHA.");
    if (parsed.sha && !head.headSha.startsWith(parsed.sha.toLowerCase())) {
      throw new Error(`The PR head is ${head.headSha.slice(0, 7)}, not ${parsed.sha}. Push first, then upload for the pushed head.`);
    }
    const paths = await expandInputs(hostId, ctx.cwd, parsed.inputs);
    const files: UploadFile[] = [];
    let total = 0;
    for (const { path, caption } of paths) {
      const file = await bb.sdk.files.read({ hostId, path });
      const bytes = Buffer.from(file.content, file.contentEncoding === "base64" ? "base64" : "utf8");
      const filename = posix.basename(path);
      const inspected = inspectUpload(bytes, filename);
      total += bytes.length;
      if (total > LIMITS.setBytes) throw new Error(`This upload exceeds ${formatBytes(LIMITS.setBytes)} per proof set.`);
      files.push({ bytes, filename, caption, ...inspected });
    }
    const result = store.addAssets({
      repository, number, headSha: head.headSha, prTitle: head.title, prUrl: head.url, threadId, hostId,
    }, files);
    deps.publish();
    const warnings: string[] = [];
    if (parsed.comment) await deps.updatePrComment(result.set, warnings);
    // New files invalidate an earlier decision on this head; GitHub must not keep showing it.
    if (result.reopenedFrom) await deps.syncStatus(result.set.id, warnings);
    const panel = deps.link(result.set);
    const human = [
      `Uploaded ${result.added.length} file(s) to ${setLine(result.set)}.`,
      result.duplicates.length ? `Already present: ${result.duplicates.join(", ")}.` : undefined,
      result.superseded.length ? `Marked ${result.superseded.length} older head(s) as outdated.` : undefined,
      result.reopenedFrom ? `The earlier ${result.reopenedFrom === "approved" ? "approval" : "send back"} of this head no longer holds; the proof waits for review again.` : undefined,
      threadId ? `Implementer thread: ${threadId}.` : "No implementer thread: Send back is unavailable until you upload with --thread <id>.",
      panel ? `Panel: ${panel}` : `Panel: BB → Visual proof → ${repository} #${number}`,
      ...warnings,
    ].filter(Boolean).join("\n");
    return { json: parsed.json, value: { set: result.set, added: result.added, duplicates: result.duplicates, warnings, panel }, human };
  };

  const status = (args: string[]) => {
    const json = args.includes("--json");
    const positional = args.filter((arg) => arg !== "--json");
    if (positional.length !== 1 || positional[0]!.startsWith("--")) throw new Error("Name exactly one pull request.");
    const { repository, number } = parsePullRequest(positional[0]!);
    const detail = store.detail(repository, number);
    if (!detail) return { json, value: null, human: `No visual proof for ${repository}#${number}.` };
    // Locked comments belong to a stored decision even while its message is still undelivered.
    const lastRound = detail.annotations.filter((annotation) => annotation.locked && annotation.round === detail.set.round - 1);
    const open = detail.annotations.filter((annotation) => !annotation.locked);
    const describe = (list: typeof open) => list.map((annotation) => {
      const asset = detail.assets.find((candidate) => candidate.id === annotation.assetId);
      return `  ${annotation.number}. [${asset ? `${asset.filename}, ${describeAnchor(annotation.anchor)}` : "whole set"}] ${annotation.body.replace(/\s+/g, " ").slice(0, 500)}`;
    });
    const human = [
      setLine(detail.set),
      detail.set.currentHeadSha && detail.set.currentHeadSha !== detail.set.headSha ? `PR head is now ${detail.set.currentHeadSha.slice(0, 7)}.` : undefined,
      ...detail.assets.map((asset) => `  - ${asset.filename}${asset.caption ? ` "${asset.caption}"` : ""}${asset.expired ? " (media expired)" : ""}`),
      lastRound.length ? `Comments sent back in the last round${lastRound.every((annotation) => annotation.sent) ? "" : " (message not delivered yet)"}:` : undefined,
      ...describe(lastRound),
      open.length ? "Comments not sent yet:" : undefined,
      ...describe(open),
      detail.set.status === "approved" && detail.set.decisionNote ? `Approval note: ${detail.set.decisionNote}` : undefined,
    ].filter(Boolean).join("\n");
    return { json, value: { set: detail.set, assets: detail.assets, annotations: detail.annotations.slice(-100) }, human };
  };

  const exportProof = async (args: string[], ctx: { cwd?: string; threadId?: string }) => {
    const positional: string[] = [];
    let sha: string | undefined;
    let machine: string | undefined;
    let json = false;
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index]!;
      if (arg === "--sha" || arg === "--machine") {
        const value = args[++index];
        if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}.`);
        if (arg === "--sha") sha = value.toLowerCase();
        else machine = value;
      } else if (arg === "--json") json = true;
      else if (arg.startsWith("--")) throw new Error(`Unknown option ${arg}.`);
      else positional.push(arg);
    }
    if (positional.length !== 2 || !positional[1]!.trim()) throw new Error("Name exactly one pull request and an export directory.");
    if (sha !== undefined && !/^[0-9a-f]{7,40}$/.test(sha)) throw new Error("--sha needs at least 7 hex characters of the commit SHA.");
    const { repository, number } = parsePullRequest(positional[0]!);
    const hostId = await invokingHost(ctx, machine);
    if (!posix.isAbsolute(positional[1]!) && !ctx.cwd) throw new Error("Use an absolute export directory; the command has no working directory.");
    const directory = posix.resolve(ctx.cwd ?? "/", positional[1]!);
    let set: ProofSet | undefined;
    if (sha !== undefined) {
      const matches = store.history(repository, number).filter((candidate) => candidate.headSha.startsWith(sha));
      if (matches.length !== 1) throw new Error(matches.length ? `Ambiguous proof SHA ${sha}; use the full head SHA.` : `No visual proof for ${repository}#${number} at ${sha}.`);
      set = matches[0]!;
    } else {
      if (!store.latestSet(repository, number)) throw new Error(`No visual proof for ${repository}#${number}.`);
      const head = await deps.prHead(repository, number, hostId);
      set = store.recordHead(repository, number, head.headSha);
      deps.publish();
      if (set?.stale || set?.headSha !== head.headSha) {
        throw new Error(`This proof is outdated; the PR head is ${head.headSha}. Use --sha <proof-head-sha> to export that set explicitly.`);
      }
    }
    if (!set) throw new Error(`No visual proof for ${repository}#${number}.`);
    const assets = store.assets(set.id);
    if (!assets.length) throw new Error("This proof has no media to export.");
    if (assets.some((asset) => asset.expired || !store.hasMedia(asset.sha256))) throw new Error("This proof's media has expired or was deleted; nothing was exported.");
    const files = assets.map((asset, index) => ({
      file: `${String(index + 1).padStart(2, "0")}-${posix.basename(asset.filename).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 160)}`,
      filename: asset.filename, caption: asset.caption, sha256: asset.sha256,
      kind: asset.kind, mime: asset.mime, bytes: asset.bytes,
    }));
    const manifest = {
      repository, number, setId: set.id, headSha: set.headSha, status: set.status,
      stale: set.stale, currentHeadSha: set.currentHeadSha, files,
    };
    const write = async (file: string, content: string, contentEncoding: "base64" | "utf8") => {
      const path = posix.join(directory, file);
      const result = await bb.sdk.files.write({ hostId, path, content, contentEncoding, createParents: true, expectedSha256: null });
      if (result.outcome !== "written") throw new Error(`${path}: already exists; export to a new directory.`);
    };
    for (const file of files) {
      const bytes = await readFile(store.mediaPath(file.sha256));
      const inspected = inspectUpload(bytes, file.filename);
      if (inspected.sha256 !== file.sha256 || bytes.length !== file.bytes) throw new Error(`${file.filename}: stored media failed its integrity check.`);
      await write(file.file, bytes.toString("base64"), "base64");
    }
    // A manifest is the completion marker; failed writes can leave media, but no new manifest.
    await write("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return {
      json, value: { directory, manifestPath: posix.join(directory, "manifest.json"), ...manifest },
      human: `Exported ${files.length} file(s) from ${setLine(set)} to ${directory}.\nManifest: ${posix.join(directory, "manifest.json")}`,
    };
  };

  const list = (args: string[]) => {
    let repository: string | undefined;
    let view: "open" | "done" = "open";
    let json = false;
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index]!;
      if (arg === "--repo") repository = args[++index]?.toLowerCase();
      else if (arg === "--done") view = "done";
      else if (arg === "--json") json = true;
      else throw new Error(`Unknown argument ${arg}.`);
    }
    const result = store.listLatest({ repository, view }, 50);
    const sets = result.sets.map(({ previews: _previews, ...set }) => set);
    const human = sets.length ? sets.map(setLine).join("\n") : "No visual proofs.";
    return { json, value: { sets, openCount: result.openCount, doneCount: result.doneCount }, human };
  };

  bb.cli.register({
    name: "visual-proof",
    summary: "Upload PR screenshots and screencasts to the BB Visual proof panel and read the review",
    commands: [
      { name: "add", summary: "Upload proof files for the PR's current head", usage: usage.split("\n")[1]! },
      { name: "status", summary: "Show the review state and comments of a PR's proof", usage: usage.split("\n")[2]! },
      { name: "list", summary: "List proofs waiting for review (or --done)", usage: usage.split("\n")[3]! },
      { name: "export", summary: "Export proof media and a manifest to the calling machine", usage: usage.split("\n")[4]! },
    ],
    async run(argv, ctx) {
      const [command, ...args] = argv;
      try {
        const result = command === "add" ? await add(args, ctx)
          : command === "status" ? status(args)
            : command === "list" ? list(args)
              : command === "export" ? await exportProof(args, ctx)
              : null;
        if (!result) return { exitCode: 1, stderr: usage };
        return { exitCode: 0, stdout: result.json ? JSON.stringify(result.value) : result.human };
      } catch (error) {
        return { exitCode: 1, stderr: `${error instanceof Error ? error.message : String(error)}\n\n${usage}` };
      }
    },
  });
}
