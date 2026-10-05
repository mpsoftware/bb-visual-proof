import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMMENT_MARKER, type Annotation, type ProofSet, type SetDetail } from "../src/contract.js";
import { captionFromFilename, parseAddArgs, parsePullRequest } from "../src/cli.js";
import { parseRange, sniffMedia } from "../src/media.js";
import { ProofStore, migrations } from "../src/store.js";
import { THREAD_ID, createBackend, fixtures, type Backend } from "./backend.js";

const REPO = "acme/shop";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const DAY = 86_400_000;

let backend: Backend;
beforeEach(async () => {
  backend = await createBackend();
  backend.setPr(REPO, 231, { headSha: SHA_A, title: "Order form redesign" });
  backend.hostFiles.set("/work/repo/proof/01-checkout.png", fixtures.png(1));
  backend.hostFiles.set("/work/repo/proof/02-checkout-dark.png", fixtures.png(2));
  backend.hostFiles.set("/work/repo/proof/video/run.webm", fixtures.webm(1));
  backend.hostFiles.set("/work/repo/proof/notes.txt", Buffer.from("not media"));
  backend.hostFiles.set("/work/repo/proof/deep/nested/skip.png", fixtures.png(9));
});
afterEach(async () => {
  await backend.dispose();
});

const detail = async (setId?: string) =>
  (await backend.rpc("proofs_detail", { repository: REPO, number: 231, ...(setId ? { setId } : {}) }) as { detail: SetDetail }).detail;
const addOk = async (argv: string[]) => {
  const result = await backend.cli(["add", `${REPO}#231`, ...argv]);
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  return result.stdout;
};

describe("upload", () => {
  it("stores a directory's media for the PR head and serves it with safe headers", async () => {
    const out = await addOk(["proof"]);
    expect(out).toContain("Uploaded 3 file(s)");
    expect(out).toContain("https://bb.example.test/plugins/visual-proof/proofs/acme/shop/231");
    const current = await detail();
    expect(current.set).toMatchObject({ headSha: SHA_A, status: "pending", stale: false, threadId: THREAD_ID, imageCount: 2, videoCount: 1, prTitle: "Order form redesign" });
    expect(current.assets.map((asset) => [asset.filename, asset.caption, asset.kind])).toEqual([
      ["01-checkout.png", "01 checkout", "image"],
      ["02-checkout-dark.png", "02 checkout dark", "image"],
      ["run.webm", "run", "video"],
    ]);

    const response = await backend.fetch(`/media?sha=${current.assets[0]!.sha256}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(fixtures.png(1));
    expect((await backend.fetch("/media?sha=../../data.db")).status).toBe(404);
  });

  it("serves byte ranges so screencasts can seek", async () => {
    await addOk(["proof/video/run.webm"]);
    const [video] = (await detail()).assets;
    const partial = await backend.fetch(`/media?sha=${video!.sha256}`, { headers: { range: "bytes=2-5" } });
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-range")).toBe(`bytes 2-5/${fixtures.webm(1).length}`);
    expect(Buffer.from(await partial.arrayBuffer())).toEqual(fixtures.webm(1).subarray(2, 6));
    expect((await backend.fetch(`/media?sha=${video!.sha256}`, { headers: { range: "bytes=999-" } })).status).toBe(416);
  });

  it("maintains exactly one marked PR comment and applies captions to the following file", async () => {
    await addOk(["--caption", "Checkout, light", "proof/01-checkout.png"]);
    expect(backend.comments.get(`${REPO}#231`)).toContain(COMMENT_MARKER);
    expect(backend.comments.get(`${REPO}#231`)).toContain("Checkout, light");
    await addOk(["proof/02-checkout-dark.png"]);
    expect(backend.comments.size).toBe(1);
    expect(backend.comments.get(`${REPO}#231`)).toContain("2 screenshots");
    await addOk(["--no-comment", "proof/video/run.webm"]);
    expect(backend.comments.get(`${REPO}#231`)).not.toContain("screencast");
  });

  it("rejects SVG, unknown types, oversized files and wrong heads without storing anything", async () => {
    backend.hostFiles.set("/work/repo/evil.png", fixtures.svg());
    backend.hostFiles.set("/work/repo/huge.png", Buffer.concat([fixtures.png(), Buffer.alloc(10 * 1024 * 1024)]));
    const svg = await backend.cli(["add", `${REPO}#231`, "evil.png"]);
    expect(svg.exitCode).toBe(1);
    expect(svg.stderr).toContain("not an allowed type");
    const huge = await backend.cli(["add", `${REPO}#231`, "huge.png"]);
    expect(huge.stderr).toContain("exceeds the 10.0 MB limit");
    const sha = await backend.cli(["add", `${REPO}#231`, "--sha", "abcdef1", "proof"]);
    expect(sha.stderr).toContain("Push first");
    expect((await backend.cli(["add", `${REPO}#231`, "--sha", "a", "proof"])).stderr).toContain("at least 7 hex");
    backend.setPr(REPO, 231, { headSha: SHA_A, state: "MERGED" });
    expect((await backend.cli(["add", `${REPO}#231`, "proof"])).stderr).toContain("is merged");
    expect(await detail()).toBeNull();
    expect(readdirSync(backend.mediaDir()).filter((name) => !name.endsWith(".tmp"))).toEqual([]);
  });

  it("reads files on the calling thread's machine and needs a machine outside a thread", async () => {
    const outside = await backend.cli(["add", `${REPO}#231`, "/work/repo/proof"], {});
    expect(outside.stderr).toContain("--machine");
    const relative = await backend.cli(["add", `${REPO}#231`, "--machine", "host-build", "proof"], {});
    expect(relative.stderr).toContain("use an absolute path");
    const ok = await backend.cli(["add", `${REPO}#231`, "--machine", "host-build", "--thread", "thr-other", "/work/repo/proof/01-checkout.png"], {});
    expect(ok.exitCode).toBe(0);
    expect((await detail()).set.threadId).toBe("thr-other");
  });

  it("deduplicates files within a set and across heads", async () => {
    await addOk(["proof/01-checkout.png"]);
    const again = await addOk(["proof/01-checkout.png"]);
    expect(again).toContain("Already present: 01-checkout.png");
    backend.setPr(REPO, 231, { headSha: SHA_B });
    await addOk(["proof/01-checkout.png"]);
    expect(readdirSync(backend.mediaDir())).toHaveLength(1);
  });
});

describe("stale on new head", () => {
  it("supersedes older heads, keeps them readable, and makes them read-only", async () => {
    await addOk(["proof/01-checkout.png"]);
    const first = (await detail()).set;
    backend.setPr(REPO, 231, { headSha: SHA_B });
    const out = await addOk(["proof/02-checkout-dark.png"]);
    expect(out).toContain("Marked 1 older head(s) as outdated");

    const old = await detail(first.id);
    expect(old.set).toMatchObject({ stale: true, staleReason: "superseded", currentHeadSha: SHA_B });
    expect(old.history.map((set) => set.headSha)).toEqual([SHA_B, SHA_A]);
    await expect(backend.rpc("proofs_annotation_add", {
      setId: first.id, assetId: old.assets[0]!.id, anchor: { kind: "rect", x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, body: "Too late",
    })).rejects.toThrow("outdated head");
    expect(backend.comments.get(`${REPO}#231`)).toContain("Older heads: `aaaaaaa` outdated");

    backend.setPr(REPO, 231, { headSha: SHA_A });
    expect((await backend.cli(["add", `${REPO}#231`, "proof/01-checkout.png"])).stderr).toContain("is outdated");
  });

  it("marks the newest proof stale when the PR head moved without a new upload", async () => {
    await addOk(["proof/01-checkout.png"]);
    backend.setPr(REPO, 231, { headSha: SHA_B });
    const checked = await backend.rpc("proofs_check_head", { repository: REPO, number: 231 }) as { set: ProofSet; headSha: string };
    expect(checked.headSha).toBe(SHA_B);
    expect(checked.set).toMatchObject({ headSha: SHA_A, stale: true, staleReason: "head_moved", currentHeadSha: SHA_B });
  });
});

describe("review", () => {
  const annotate = async (setId: string, assetId: string | null, anchor: object, body: string) =>
    await backend.rpc("proofs_annotation_add", { setId, assetId, anchor, body }) as Annotation;

  it("validates anchors against the file kind", async () => {
    await addOk(["proof"]);
    const { set, assets } = await detail();
    const [image, , video] = assets;
    await expect(annotate(set.id, image!.id, { kind: "time", ms: 1000 }, "x")).rejects.toThrow("use a box");
    await expect(annotate(set.id, video!.id, { kind: "rect", x: 0, y: 0, w: 0.5, h: 0.5 }, "x")).rejects.toThrow("use a time");
    await expect(annotate(set.id, image!.id, { kind: "rect", x: 0.8, y: 0, w: 0.5, h: 0.5 }, "x")).rejects.toThrow();
    await expect(annotate(set.id, null, { kind: "rect", x: 0, y: 0, w: 0.5, h: 0.5 }, "x")).rejects.toThrow("no position");
    expect((await annotate(set.id, video!.id, { kind: "time", ms: 12_000 }, "Flicker")).number).toBe(1);
    expect((await annotate(set.id, null, { kind: "none" }, "General")).number).toBe(2);
  });

  it("sends comments and annotated images back to the implementer thread", async () => {
    await addOk(["proof"]);
    const { set, assets } = await detail();
    await expect(backend.rpc("proofs_send_back", { setId: set.id, revision: backend.revision(set.id) })).rejects.toThrow("at least one comment");
    await annotate(set.id, assets[0]!.id, { kind: "rect", x: 0.1, y: 0.2, w: 0.3, h: 0.1 }, "Button label is cut off");
    await annotate(set.id, assets[2]!.id, { kind: "time", ms: 12_000 }, "Flicker on submit");
    const { renderId } = await backend.rpc("proofs_stage_render", { setId: set.id, dataBase64: fixtures.png(7).toString("base64") }) as { renderId: string };
    await expect(backend.rpc("proofs_stage_render", { setId: set.id, dataBase64: fixtures.svg().toString("base64") })).rejects.toThrow("expected PNG");

    const result = await backend.rpc("proofs_send_back", { setId: set.id, revision: backend.revision(set.id), renderIds: [renderId] }) as { set: ProofSet; warnings: string[] };
    expect(result.warnings).toEqual([]);
    expect(result.set).toMatchObject({ status: "changes_requested", round: 2 });
    expect(backend.sent).toHaveLength(1);
    const [message] = backend.sent;
    expect(message!.threadId).toBe(THREAD_ID);
    expect(message!.text).toContain(`[visual-proof:${(await detail()).deliveries[0]!.id}]`);
    expect(message!.text).toContain("1. [\"01 checkout\" (01-checkout.png), box x 10%–40%, y 20%–30%]\n> Button label is cut off");
    expect(message!.text).toContain("at 0:12");
    expect(message!.images).toEqual([".bb/attachments/visual-proof-231-r1-1.png"]);
    expect(backend.uploads[0]).toMatchObject({ projectId: "proj-shop" });

    const after = await detail();
    expect(after.annotations.every((annotation) => annotation.sent)).toBe(true);
    await expect(backend.rpc("proofs_annotation_update", { id: after.annotations[0]!.id, body: "edit" })).rejects.toThrow("sent comment");
    expect(backend.comments.get(`${REPO}#231`)).toContain("Changes requested");
  });

  it("stores the send back and keeps a failed message retryable", async () => {
    await addOk(["proof/01-checkout.png"]);
    const { set, assets } = await detail();
    await annotate(set.id, assets[0]!.id, { kind: "rect", x: 0, y: 0, w: 0.5, h: 0.5 }, "Spacing");
    backend.failSends("thread is archived");
    const result = await backend.rpc("proofs_send_back", { setId: set.id, revision: backend.revision(set.id) }) as { set: ProofSet; warnings: string[] };
    expect(result.warnings.join()).toContain("thread is archived");
    const after = await detail();
    expect(after.set).toMatchObject({ status: "changes_requested", round: 2 });
    expect(after.annotations[0]).toMatchObject({ locked: true, sent: false });
    const status = await backend.cli(["status", `${REPO}#231`]);
    expect(status.stdout).toContain("Comments sent back in the last round (message not delivered yet):");
    expect(status.stdout).not.toContain("Comments not sent yet:");
    expect(after.deliveries[0]).toMatchObject({ kind: "send_back", status: "failed", error: "thread is archived" });
    backend.failSends(null);
    await backend.rpc("proofs_retry", { setId: set.id });
    expect((await detail()).annotations[0]).toMatchObject({ locked: true, sent: true });
    expect(backend.sent).toHaveLength(1);
  });

  it("approves only the verified current head and records the decision", async () => {
    await addOk(["proof/01-checkout.png"]);
    const { set, assets } = await detail();
    await annotate(set.id, assets[0]!.id, { kind: "rect", x: 0, y: 0, w: 0.2, h: 0.2 }, "Nice to have: softer shadow");

    backend.failGithub("gh: network down");
    await expect(backend.rpc("proofs_approve", { setId: set.id, revision: backend.revision(set.id) })).rejects.toThrow("nothing was approved");
    backend.failGithub(null);

    const result = await backend.rpc("proofs_approve", { setId: set.id, revision: backend.revision(set.id), note: "Looks good" }) as { set: ProofSet; warnings: string[] };
    expect(result.set).toMatchObject({ status: "approved", decisionNote: "Looks good" });
    expect(result.set.mediaExpiresAt).not.toBeNull();
    expect(backend.sent.at(-1)!.text).toContain(`[visual-proof:${(await detail()).deliveries[0]!.id}]`);
    expect(backend.sent.at(-1)!.text).toContain("Non-blocking remarks:");
    expect(backend.statuses).toEqual([]);
    expect(backend.comments.get(`${REPO}#231`)).toContain("**Approved**");
    await expect(backend.rpc("proofs_approve", { setId: set.id, revision: backend.revision(set.id) })).rejects.toThrow("already approved");

    // New files on an approved head need a new review.
    await addOk(["proof/02-checkout-dark.png"]);
    expect((await detail()).set.status).toBe("pending");
  });

  it("refuses approval when the head moved and marks the proof stale", async () => {
    await addOk(["proof/01-checkout.png"]);
    const { set } = await detail();
    backend.setPr(REPO, 231, { headSha: SHA_B });
    await expect(backend.rpc("proofs_approve", { setId: set.id, revision: backend.revision(set.id) })).rejects.toThrow("head moved to bbbbbbb");
    expect((await detail()).set).toMatchObject({ status: "pending", stale: true, staleReason: "head_moved" });
  });

  it("posts the visual-proof commit status only when the option is on", async () => {
    await backend.dispose();
    backend = await createBackend({ settings: { postCommitStatus: true } });
    backend.setPr(REPO, 231, { headSha: SHA_A });
    backend.hostFiles.set("/work/repo/a.png", fixtures.png(1));
    await addOk(["a.png"]);
    const { set, assets } = await detail();
    await annotate(set.id, assets[0]!.id, { kind: "rect", x: 0, y: 0, w: 0.2, h: 0.2 }, "Fix");
    await backend.rpc("proofs_send_back", { setId: set.id, revision: backend.revision(set.id) });
    await backend.rpc("proofs_approve", { setId: set.id, revision: backend.revision(set.id) });
    expect(backend.statuses).toEqual([
      { repository: REPO, sha: SHA_A, state: "failure", context: "visual-proof", targetUrl: "https://bb.example.test/plugins/visual-proof/proofs/acme/shop/231" },
      { repository: REPO, sha: SHA_A, state: "success", context: "visual-proof", targetUrl: "https://bb.example.test/plugins/visual-proof/proofs/acme/shop/231" },
    ]);
  });

  it("stores thumbnails permanently and serves them", async () => {
    await addOk(["proof/01-checkout.png"]);
    const { assets } = await detail();
    await expect(backend.rpc("proofs_thumbnail_put", { assetId: assets[0]!.id, dataBase64: fixtures.webm().toString("base64") })).rejects.toThrow("expected PNG");
    const saved = await backend.rpc("proofs_thumbnail_put", { assetId: assets[0]!.id, dataBase64: fixtures.png(5).toString("base64") }) as { hasThumbnail: boolean };
    expect(saved.hasThumbnail).toBe(true);
    const response = await backend.fetch(`/thumb?sha=${assets[0]!.sha256}`);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(fixtures.png(5));
  });
});

describe("list", () => {
  it("orders open proofs by urgency and counts pending ones for the badge", async () => {
    backend.setPr(REPO, 232, { headSha: SHA_B, title: "Second" });
    await addOk(["proof/01-checkout.png"]);
    await backend.cli(["add", `${REPO}#232`, "proof/02-checkout-dark.png"]);
    const second = (await backend.rpc("proofs_detail", { repository: REPO, number: 232 }) as { detail: SetDetail }).detail;
    await backend.rpc("proofs_approve", { setId: second.set.id, revision: backend.revision(second.set.id) });
    const open = await backend.rpc("proofs_list", { view: "open" }) as { sets: Array<{ number: number }>; openCount: number; doneCount: number };
    expect(open.sets.map((set) => set.number)).toEqual([231]);
    expect([open.openCount, open.doneCount]).toEqual([1, 1]);
    expect(await backend.rpc("proofs_pending_count", null)).toEqual({ count: 1 });
    const cli = await backend.cli(["list", "--done"]);
    expect(cli.stdout).toContain("#232 head bbbbbbb: approved");
  });
});

describe("retention", () => {
  it("expires approved and stale media after their windows and keeps metadata and thumbnails", async () => {
    await addOk(["proof/01-checkout.png", "proof/02-checkout-dark.png"]);
    const first = await detail();
    await backend.rpc("proofs_thumbnail_put", { assetId: first.assets[0]!.id, dataBase64: fixtures.png(5).toString("base64") });
    backend.setPr(REPO, 231, { headSha: SHA_B });
    await addOk(["proof/01-checkout.png"]); // shares 01 with the stale set
    const current = await detail();
    await backend.rpc("proofs_approve", { setId: current.set.id, revision: backend.revision(current.set.id) });

    const mediaDir = backend.mediaDir();
    await backend.host.harness.behavior.runSchedule("retention");
    expect(readdirSync(mediaDir)).toHaveLength(2);

    const db = backend.db();
    const past = (days: number) => new Date(Date.now() - days * DAY).toISOString();
    db.prepare("UPDATE proof_sets SET stale_at = ? WHERE id = ?").run(past(15), first.set.id);
    await backend.host.harness.behavior.runSchedule("retention");
    // 02 was only in the stale set; 01 is still referenced by the approved current set.
    expect(readdirSync(mediaDir)).toEqual([current.assets[0]!.sha256]);
    const expired = await detail(first.set.id);
    expect(expired.assets.map((asset) => asset.expired)).toEqual([true, true]);
    expect(expired.assets[0]!.hasThumbnail).toBe(true);
    expect(expired.events[0]!.kind).toBe("media_expired");
    expect((await backend.fetch(`/media?sha=${first.assets[1]!.sha256}`)).status).toBe(404);

    db.prepare("UPDATE proof_sets SET decided_at = ? WHERE id = ?").run(past(91), current.set.id);
    await backend.host.harness.behavior.runSchedule("retention");
    expect(readdirSync(mediaDir)).toEqual([]);
    expect((await backend.fetch(`/thumb?sha=${first.assets[0]!.sha256}`)).status).toBe(200);
    expect((await detail()).set.status).toBe("approved");
  });

  it("never expires media of a pending current proof", async () => {
    await addOk(["proof/01-checkout.png"]);
    backend.db().prepare("UPDATE proof_sets SET created_at = ?, updated_at = ?").run("2020-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z");
    await backend.host.harness.behavior.runSchedule("retention");
    expect((await detail()).assets[0]!.expired).toBe(false);
  });
});

describe("decisions bound to a revision", () => {
  beforeEach(() => {
    for (const [name, seed] of [["a.png", 1], ["b.png", 2], ["c.png", 3]] as const) backend.hostFiles.set(`/work/repo/${name}`, fixtures.png(seed));
  });
  const annotate = async (setId: string, assetId: string | null, anchor: object, body: string) =>
    await backend.rpc("proofs_annotation_add", { setId, assetId, anchor, body }) as Annotation;
  const withStatus = async () => {
    await backend.dispose();
    backend = await createBackend({ settings: { postCommitStatus: true } });
    backend.setPr(REPO, 231, { headSha: SHA_A });
    backend.hostFiles.set("/work/repo/a.png", fixtures.png(1));
    backend.hostFiles.set("/work/repo/b.png", fixtures.png(2));
    backend.hostFiles.set("/work/repo/c.png", fixtures.png(3));
  };

  // Changes that arrive while the head is being checked.
  it("refuses an approval when a file arrives during its head check, with no status or message", async () => {
    await withStatus();
    await addOk(["a.png"]);
    const { set } = await detail();
    const release = backend.holdNextHeadCheck();
    const approval = backend.rpc("proofs_approve", { setId: set.id, revision: backend.revision(set.id) });
    await addOk(["b.png"]);
    release();
    await expect(approval).rejects.toThrow("changed since you opened it");
    const after = await detail();
    expect(after.set).toMatchObject({ status: "pending", imageCount: 2 });
    expect(backend.statuses).toEqual([]);
    expect(backend.sent).toEqual([]);
  });

  it("refuses an approval when a comment changes during its head check", async () => {
    await addOk(["a.png"]);
    const { set, assets } = await detail();
    const release = backend.holdNextHeadCheck();
    const approval = backend.rpc("proofs_approve", { setId: set.id, revision: backend.revision(set.id) });
    await annotate(set.id, assets[0]!.id, { kind: "rect", x: 0, y: 0, w: 0.2, h: 0.2 }, "Late remark");
    release();
    await expect(approval).rejects.toThrow("changed since you opened it");
    expect((await detail()).annotations[0]).toMatchObject({ locked: false, sent: false });
  });

  it("refuses a decision made on an older revision than the panel shows", async () => {
    await addOk(["a.png"]);
    const { set, assets } = await detail();
    const seen = backend.revision(set.id);
    await annotate(set.id, assets[0]!.id, { kind: "rect", x: 0, y: 0, w: 0.2, h: 0.2 }, "Fix");
    await expect(backend.rpc("proofs_send_back", { setId: set.id, revision: seen })).rejects.toThrow("changed since you opened it");
    await expect(backend.rpc("proofs_approve", { setId: set.id, revision: seen })).rejects.toThrow("changed since you opened it");
  });

  // A send back whose acknowledgement was lost.
  it("delivers exactly the frozen send back after a lost acknowledgement, never an edit", async () => {
    await addOk(["a.png"]);
    const { set, assets } = await detail();
    const original = await annotate(set.id, assets[0]!.id, { kind: "rect", x: 0, y: 0, w: 0.2, h: 0.2 }, "Original");
    backend.loseNextAck();
    const result = await backend.rpc("proofs_send_back", { setId: set.id, revision: backend.revision(set.id) }) as { warnings: string[] };
    expect(result.warnings.join()).toContain("socket hang up");
    await expect(backend.rpc("proofs_annotation_update", { id: original.id, body: "Edited" })).rejects.toThrow("cannot be changed");
    const later = await annotate(set.id, null, { kind: "none" }, "Found after sending");

    await backend.rpc("proofs_retry", { setId: set.id });
    await backend.rpc("proofs_retry", { setId: set.id });
    expect(backend.sent).toHaveLength(1);
    expect(backend.sent[0]!.text).toContain("> Original");
    expect(backend.sent[0]!.text).not.toContain("Found after sending");
    const after = await detail();
    expect(after.deliveries).toMatchObject([{ status: "sent" }]);
    expect(after.annotations.find((annotation) => annotation.id === original.id)).toMatchObject({ body: "Original", locked: true, sent: true });
    expect(after.annotations.find((annotation) => annotation.id === later.id)).toMatchObject({ locked: false, sent: false });
  });

  // Approval messages and their retries.
  it("keeps a failed approval message retryable and gives each approval its own message", async () => {
    await addOk(["a.png"]);
    let { set, assets } = await detail();
    await annotate(set.id, assets[0]!.id, { kind: "rect", x: 0, y: 0, w: 0.2, h: 0.2 }, "Nice to have");
    backend.failSends("thread busy");
    await backend.rpc("proofs_approve", { setId: set.id, revision: backend.revision(set.id), note: "First" });
    let after = await detail();
    expect(after.set.status).toBe("approved");
    expect(after.annotations[0]).toMatchObject({ locked: true, sent: false });
    expect(after.deliveries).toMatchObject([{ kind: "approval", status: "failed" }]);
    backend.failSends(null);
    await backend.host.harness.behavior.runSchedule("delivery-sweep");
    expect((await detail()).annotations[0]).toMatchObject({ sent: true });

    await addOk(["b.png"]);
    ({ set } = await detail());
    await backend.rpc("proofs_approve", { setId: set.id, revision: backend.revision(set.id), note: "Second" });
    after = await detail();
    expect(after.deliveries.map((delivery) => delivery.status)).toEqual(["sent", "sent"]);
    expect(backend.sent).toHaveLength(2);
    expect(backend.sent[1]!.text).toContain("> Second");
    expect(backend.sent[1]!.text).toContain("2 screenshot(s)");
    const markers = backend.sent.map((message) => /\[visual-proof:[^\]]+\]/.exec(message.text)![0]);
    expect(new Set(markers).size).toBe(2);
  });

  it("marks remarks of an approval without implementer thread as undelivered, never as sent", async () => {
    const out = await backend.cli(["add", `${REPO}#231`, "--machine", "host-build", "/work/repo/a.png"], {});
    expect(out.exitCode).toBe(0);
    const { set, assets } = await detail();
    expect(set.threadId).toBeNull();
    await annotate(set.id, assets[0]!.id, { kind: "rect", x: 0, y: 0, w: 0.2, h: 0.2 }, "Remark without recipient");
    await backend.rpc("proofs_approve", { setId: set.id, revision: backend.revision(set.id) });
    await backend.rpc("proofs_retry", { setId: set.id });
    await backend.host.harness.behavior.runSchedule("delivery-sweep");
    const after = await detail();
    expect(after.set.status).toBe("approved");
    expect(after.annotations[0]).toMatchObject({ locked: true, sent: false, delivery: "no_recipient" });
    expect(after.deliveries).toEqual([]);
    expect(backend.sent).toEqual([]);
  });

  // The GitHub commit status.
  it("sets GitHub back to pending when new files reopen an approved head, and retries a failed post", async () => {
    await withStatus();
    await addOk(["a.png"]);
    const { set } = await detail();
    await backend.rpc("proofs_approve", { setId: set.id, revision: backend.revision(set.id) });
    backend.failStatus("GitHub 502");
    const out = await addOk(["b.png"]);
    expect(out).toContain("Commit status not posted");
    expect((await detail()).set.githubStatus).toMatchObject({ wanted: "pending", posted: "success", error: "GitHub 502" });
    backend.failStatus(null);
    await backend.host.harness.behavior.runSchedule("delivery-sweep");
    expect(backend.statuses.map((status) => status.state)).toEqual(["success", "pending"]);
    expect((await detail()).set.githubStatus).toMatchObject({ wanted: "pending", posted: "pending", error: null });
  });

  it("never leaves an older success on GitHub when status posts overlap", async () => {
    await withStatus();
    await addOk(["a.png"]);
    const { set } = await detail();
    const release = backend.holdNextStatus();
    const approval = backend.rpc("proofs_approve", { setId: set.id, revision: backend.revision(set.id) });
    await vi.waitFor(() => expect(backend.statusHeld()).toBe(true));
    const upload = backend.cli(["add", `${REPO}#231`, "b.png"], { threadId: THREAD_ID, cwd: "/work/repo" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    await approval;
    expect((await upload).exitCode).toBe(0);
    expect(backend.statuses.map((status) => status.state)).toEqual(["success", "pending"]);
    expect((await detail()).set.githubStatus).toMatchObject({ wanted: "pending", posted: "pending", error: null });
  });

  it("posts no status while the option is off", async () => {
    await addOk(["a.png"]);
    const { set } = await detail();
    await backend.rpc("proofs_approve", { setId: set.id, revision: backend.revision(set.id) });
    await addOk(["b.png"]);
    await backend.host.harness.behavior.runSchedule("delivery-sweep");
    expect(backend.statuses).toEqual([]);
  });

  // Approved sets are read-only.
  it("keeps approved proofs read-only for comments", async () => {
    await addOk(["a.png"]);
    const { set, assets } = await detail();
    const remark = await annotate(set.id, assets[0]!.id, { kind: "rect", x: 0, y: 0, w: 0.2, h: 0.2 }, "Remark");
    await backend.rpc("proofs_approve", { setId: set.id, revision: backend.revision(set.id) });
    await expect(annotate(set.id, null, { kind: "none" }, "After approval")).rejects.toThrow("approved and read-only");
    await expect(backend.rpc("proofs_annotation_update", { id: remark.id, body: "x" })).rejects.toThrow("cannot be changed");
    await expect(backend.rpc("proofs_annotation_delete", { id: remark.id })).rejects.toThrow("cannot be changed");
    // A comment that is unlocked on an approved set (stored before this guard existed) stays untouchable too.
    backend.db().prepare(`INSERT INTO annotations (id, set_id, asset_id, number, anchor_json, body, round, created_at, updated_at)
      VALUES ('legacy', ?, NULL, 9, '{"kind":"none"}', 'legacy', 1, 'x', 'x')`).run(set.id);
    await expect(backend.rpc("proofs_annotation_update", { id: "legacy", body: "x" })).rejects.toThrow("approved and read-only");
    await expect(backend.rpc("proofs_annotation_delete", { id: "legacy" })).rejects.toThrow("approved and read-only");
  });
});

describe("store limits", () => {
  let dir: string;
  let store: ProofStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "visual-proof-store-"));
    const db = new Database(join(dir, "data.db"));
    store = new ProofStore(db, (database, statements) => { for (const statement of statements) database.exec(statement); });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const target = { repository: REPO, number: 1, headSha: SHA_A, prTitle: "t", prUrl: "https://github.com/x/y/pull/1", threadId: null, hostId: null };
  const file = (seed: number, size = 16) => ({
    bytes: Buffer.concat([fixtures.png(seed), Buffer.alloc(size)]), sha256: String(seed).padStart(64, "0"), mime: "image/png", kind: "image" as const,
    filename: `${seed}.png`, caption: "",
  });

  it("rejects an upload over the quota without writing a record", () => {
    store.retention = { ...store.retention, quotaBytes: 100 };
    expect(() => store.addAssets(target, [file(1, 200)])).toThrow("storage is full");
    expect(store.latestSet(REPO, 1)).toBeUndefined();
  });

  it("caps files per set", () => {
    const files = Array.from({ length: 61 }, (_, index) => file(index + 1));
    expect(() => store.addAssets(target, files)).toThrow("at most 60 files");
  });

  it("removes files a crash left behind after an hour", () => {
    writeFileSync(join(store.mediaDir, "a".repeat(64)), "partial");
    store.sweep(Date.now() + 2 * 3_600_000);
    expect(readdirSync(store.mediaDir)).toHaveLength(0);
    expect(existsSync(store.mediaDir)).toBe(true);
  });

  // A refused upload changes neither the database nor the media directory.
  const snapshot = (db: Database.Database) => ({
    files: readdirSync(store.mediaDir).sort(),
    rows: ["proof_sets", "assets", "media", "events"].map((table) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n),
  });

  it("leaves no rows and no files behind for every refused upload", () => {
    const db = (store as unknown as { db: Database.Database }).db;
    store.addAssets(target, [file(1)]);
    const before = snapshot(db);
    const refusals: Array<[string, () => void]> = [
      ["quota", () => {
        store.retention = { ...store.retention, quotaBytes: 100 };
        try { store.addAssets(target, [file(2, 200), file(1)]); } finally { store.retention = { ...store.retention, quotaBytes: 10 ** 9 }; }
      }],
      ["file count", () => store.addAssets(target, Array.from({ length: 60 }, (_, index) => file(index + 10)))],
      // Validation runs before any write, so a length is enough to exceed the 200 MB set limit.
      ["set size", () => store.addAssets(target, [101, 102].map((seed) => ({ ...file(seed), bytes: { length: 101 * 1024 * 1024 } as Buffer })))],
      ["stale head", () => {
        store.addAssets({ ...target, headSha: SHA_B }, [file(3)]);
        const staleBefore = snapshot(db);
        try {
          store.addAssets(target, [file(4)]);
        } finally {
          expect(snapshot(db)).toEqual(staleBefore);
        }
      }],
    ];
    for (const [name, attempt] of refusals) {
      const start = snapshot(db);
      expect(attempt, name).toThrow();
      if (name !== "stale head") expect(snapshot(db), name).toEqual(start);
    }
    expect(snapshot(db).files).toEqual(expect.arrayContaining(before.files));
  });

  it("removes the files it wrote when recording fails, and keeps shared media", () => {
    store.addAssets(target, [file(1)]);
    const shared = readdirSync(store.mediaDir);
    const failing = store as unknown as { recordUpload: () => never };
    failing.recordUpload = () => { throw new Error("disk I/O error"); };
    expect(() => store.addAssets(target, [file(1), file(2)])).toThrow("disk I/O error");
    expect(readdirSync(store.mediaDir)).toEqual(shared);
  });
});

describe("upgrade from the first release", () => {
  /** Applies statements once each, in order, the way BB's migrate helper does. */
  const migrate = (database: Database.Database, statements: string[]) => {
    database.exec("CREATE TABLE IF NOT EXISTS _applied (n INTEGER NOT NULL)");
    const applied = (database.prepare("SELECT COUNT(*) AS n FROM _applied").get() as { n: number }).n;
    database.transaction(() => {
      for (const statement of statements.slice(applied)) {
        database.exec(statement);
        database.prepare("INSERT INTO _applied (n) VALUES (1)").run();
      }
    })();
  };

  it("keeps sent remarks sent and marks remarks of a thread-less approval as never delivered", () => {
    const dir = mkdtempSync(join(tmpdir(), "visual-proof-upgrade-"));
    try {
      const database = new Database(join(dir, "data.db"));
      // The schema of the first release: its nine statements, unchanged at the head of the list.
      migrate(database, migrations.slice(0, 9));
      const at = "2026-09-30T10:00:00.000Z";
      const insertSet = database.prepare(`INSERT INTO proof_sets (id, repository, number, head_sha, pr_title, pr_url, thread_id, host_id,
        status, round, decided_at, created_at, updated_at) VALUES (?, ?, ?, ?, 't', 'https://github.com/o/r/pull/1', ?, NULL, ?, ?, ?, ?, ?)`);
      insertSet.run("with-thread", REPO, 1, SHA_A, "thr-implementer", "changes_requested", 2, at, at, at);
      insertSet.run("no-thread", REPO, 2, SHA_B, null, "approved", 1, at, at, at);
      const insertNote = database.prepare(`INSERT INTO annotations (id, set_id, asset_id, number, anchor_json, body, round, sent_at, created_at, updated_at)
        VALUES (?, ?, NULL, ?, '{"kind":"none"}', ?, 1, ?, ?, ?)`);
      insertNote.run("sent-back", "with-thread", 1, "Delivered in round 1", at, at, at);
      insertNote.run("open", "with-thread", 2, "Still open", null, at, at);
      insertNote.run("remark", "no-thread", 1, "Approved without recipient", at, at, at);

      const store = new ProofStore(database, migrate, join(dir, "media"));
      expect(store.annotations("with-thread").map(({ id, locked, sent, delivery }) => ({ id, locked, sent, delivery }))).toEqual([
        { id: "sent-back", locked: true, sent: true, delivery: "sent" },
        { id: "open", locked: false, sent: false, delivery: null },
      ]);
      expect(store.annotations("no-thread")).toMatchObject([{ id: "remark", locked: true, sent: false, delivery: "no_recipient" }]);
      expect(store.deliveries("no-thread")).toEqual([]);
      expect(store.requireSet("with-thread")).toMatchObject({ revision: 1, githubStatus: null });
      database.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("parsing", () => {
  it("parses PR references and add arguments", () => {
    expect(parsePullRequest("Acme/Shop#231")).toEqual({ repository: REPO, number: 231 });
    expect(parsePullRequest("https://github.com/Acme/Shop/pull/231/files")).toEqual({ repository: REPO, number: 231 });
    expect(() => parsePullRequest("shop#231")).toThrow("owner/repo#N");
    expect(parseAddArgs(["o/r#1", "--caption", "A", "a.png", "b.png", "--json"])).toMatchObject({
      pr: "o/r#1", json: true, inputs: [{ path: "a.png", caption: "A" }, { path: "b.png", caption: undefined }],
    });
    expect(() => parseAddArgs(["o/r#1", "a.png", "--caption", "dangling"])).toThrow("followed by a file");
    expect(captionFromFilename("proof/03-checkout_dark.png")).toBe("03 checkout dark");
  });

  it("sniffs allowed media by magic bytes only", () => {
    expect(sniffMedia(fixtures.png())).toEqual({ mime: "image/png", kind: "image" });
    expect(sniffMedia(fixtures.svg())).toBeNull();
    const ftyp = (brand: string) => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from(`ftyp${brand}`)]);
    expect(sniffMedia(ftyp("isom"))).toEqual({ mime: "video/mp4", kind: "video" });
    expect(sniffMedia(ftyp("heic"))).toBeNull();
    expect(sniffMedia(ftyp("avif"))).toBeNull();
  });

  it("parses single byte ranges", () => {
    expect(parseRange(undefined, 10)).toBeNull();
    expect(parseRange("bytes=0-", 10)).toEqual({ start: 0, end: 9 });
    expect(parseRange("bytes=-3", 10)).toEqual({ start: 7, end: 9 });
    expect(parseRange("bytes=4-100", 10)).toEqual({ start: 4, end: 9 });
    expect(parseRange("bytes=10-", 10)).toBe("unsatisfiable");
    expect(parseRange("bytes=0-1,4-5", 10)).toBeNull();
  });
});
