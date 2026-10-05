import { createHash } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SetDetail } from "../src/contract.js";
import { createBackend, fixtures, HOST_ID, THREAD_ID, type Backend } from "./backend.js";

const REPO = "acme/shop";
const PR = `${REPO}#231`;
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
let backend: Backend;

beforeEach(async () => {
  backend = await createBackend();
  backend.setPr(REPO, 231, { headSha: SHA_A });
  backend.hostFiles.set("/work/repo/shot.png", fixtures.png(1));
  backend.hostFiles.set("/work/repo/run.webm", fixtures.webm(1));
});
afterEach(async () => { await backend.dispose(); });

const add = async (file = "shot.png") => {
  expect((await backend.cli(["add", PR, "--no-comment", "--caption", "Checkout", file])).exitCode).toBe(0);
};
const detail = async () => (await backend.rpc("proofs_detail", { repository: REPO, number: 231 }) as { detail: SetDetail }).detail;
const writes = () => backend.host.harness.inspection.sdk.callsTo("files.write");

describe("proof export", () => {
  it("exports original image and video bytes with the reviewed head and captions on the reviewer's machine", async () => {
    await add();
    await add("run.webm");
    const { set } = await detail();
    await backend.rpc("proofs_approve", { setId: set.id, revision: backend.revision(set.id), note: "Checked" });
    backend.host.harness.sdk.stub("environments.get", () => ({ id: "env-review", hostId: "host-reviewer" }));
    const result = await backend.cli(["export", `https://github.com/${REPO}/pull/231`, "export", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const output = JSON.parse(result.stdout);
    expect(output).toMatchObject({ directory: "/work/repo/export", manifestPath: "/work/repo/export/manifest.json", headSha: SHA_A, status: "approved", stale: false, currentHeadSha: SHA_A });
    const manifest = JSON.parse(backend.hostFiles.get(output.manifestPath)!.toString());
    expect(manifest.files).toHaveLength(2);
    for (const [index, bytes] of [fixtures.png(1), fixtures.webm(1)].entries()) {
      const file = manifest.files[index];
      expect(file).toMatchObject({ caption: "Checkout", sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length });
      expect(backend.hostFiles.get(`/work/repo/export/${file.file}`)).toEqual(bytes);
    }
    expect(manifest.files.map((file: { kind: string }) => file.kind)).toEqual(["image", "video"]);
    expect(writes()).toHaveLength(3);
    expect(writes().every(([args]) => (args as { hostId: string }).hostId === "host-reviewer")).toBe(true);
    expect((await detail()).set.hostId).toBe(HOST_ID);
  });

  it("checks the live head even before any panel head check and refuses stale proof without writes", async () => {
    await add();
    backend.setPr(REPO, 231, { headSha: SHA_B });
    const result = await backend.cli(["export", PR, "export"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("outdated");
    expect(result.stderr).toContain("--sha");
    expect(writes()).toHaveLength(0);
    expect((await detail()).set).toMatchObject({ stale: true, currentHeadSha: SHA_B });
  });

  it("selects an older set by explicit SHA without GitHub and exports its status and stale flag", async () => {
    await add();
    backend.setPr(REPO, 231, { headSha: SHA_B });
    await add("run.webm");
    backend.failGithub("offline");
    const result = await backend.cli(["export", PR, "old", "--sha", SHA_A.slice(0, 7).toUpperCase(), "--json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ headSha: SHA_A, stale: true, status: "pending", currentHeadSha: SHA_B, files: [{ filename: "shot.png" }] });
    expect(backend.hostFiles.get("/work/repo/old/01-shot.png")).toEqual(fixtures.png(1));
  });

  it("refuses an ambiguous SHA prefix and a SHA without proof", async () => {
    await add();
    backend.setPr(REPO, 231, { headSha: `${SHA_A.slice(0, 39)}b` });
    await add("run.webm");
    expect((await backend.cli(["export", PR, "out", "--sha", "aaaaaaa"])).stderr).toContain("Ambiguous");
    expect((await backend.cli(["export", PR, "out", "--sha", SHA_B])).stderr).toContain("No visual proof");
    expect(writes()).toHaveLength(0);
    expect((await backend.cli(["export", PR, "out", "--sha", SHA_A])).exitCode).toBe(0);
  });

  it("refuses a default export when GitHub is unavailable", async () => {
    await add();
    backend.failGithub("GitHub unavailable");
    expect((await backend.cli(["export", PR, "out"])).exitCode).toBe(1);
    expect(writes()).toHaveLength(0);
  });

  it("refuses missing proof and expired media, including when another set still shares its bytes", async () => {
    expect((await backend.cli(["export", PR, "out"])).stderr).toContain("No visual proof");
    await add();
    const first = await detail();
    backend.setPr(REPO, 231, { headSha: SHA_B });
    await add();
    await backend.rpc("proofs_delete_media", { setId: first.set.id });
    const result = await backend.cli(["export", PR, "out", "--sha", SHA_A]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("expired or was deleted");
    expect(writes()).toHaveLength(0);
  });

  it("does not write a manifest for missing or corrupt stored media", async () => {
    await add();
    const asset = (await detail()).assets[0]!;
    const path = join(backend.mediaDir(), asset.sha256);
    writeFileSync(path, fixtures.png(2));
    expect((await backend.cli(["export", PR, "corrupt"])).stderr).toContain("integrity check");
    rmSync(path);
    expect((await backend.cli(["export", PR, "missing"])).exitCode).toBe(1);
    expect(writes()).toHaveLength(0);
  });

  it("uses safe unique names for duplicate and hostile upload filenames", async () => {
    await add();
    backend.hostFiles.set("/work/repo/other/shot.png", fixtures.png(2));
    backend.hostFiles.set("/work/repo/unsafe/..\\escape.png", fixtures.png(3));
    await add("other/shot.png");
    await add("unsafe/..\\escape.png");
    const result = await backend.cli(["export", PR, "out", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).files.map((file: { file: string }) => file.file)).toEqual(["01-shot.png", "02-shot.png", "03-.._escape.png"]);
    expect(backend.hostFiles.get("/work/repo/out/01-shot.png")).toEqual(fixtures.png(1));
    expect(backend.hostFiles.get("/work/repo/out/02-shot.png")).toEqual(fixtures.png(2));
    expect(writes().every(([args]) => (args as { path: string }).path.startsWith("/work/repo/out/"))).toBe(true);
  });

  it("preserves existing files and fails instead of reporting a complete export", async () => {
    await add();
    const existing = Buffer.from("keep this");
    backend.hostFiles.set("/work/repo/out/01-shot.png", existing);
    const conflict = await backend.cli(["export", PR, "out"]);
    expect(conflict.exitCode).toBe(1);
    expect(conflict.stderr).toContain("already exists");
    expect(backend.hostFiles.get("/work/repo/out/01-shot.png")).toEqual(existing);
    expect(backend.hostFiles.has("/work/repo/out/manifest.json")).toBe(false);
    backend.hostFiles.set("/work/repo/other/manifest.json", existing);
    expect((await backend.cli(["export", PR, "other"])).exitCode).toBe(1);
    expect(backend.hostFiles.get("/work/repo/other/manifest.json")).toEqual(existing);
  });

  it("reports SDK write errors without a completion manifest", async () => {
    await add();
    backend.host.harness.sdk.stub("files.write", () => { throw new Error("disk full"); });
    const result = await backend.cli(["export", PR, "out"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("disk full");
    expect(backend.hostFiles.has("/work/repo/out/manifest.json")).toBe(false);
  });

  it("resolves absolute output paths with an explicit machine outside a thread", async () => {
    await add();
    expect((await backend.cli(["export", PR, "out"], {})).exitCode).toBe(1);
    expect((await backend.cli(["export", PR, "out", "--machine", HOST_ID], {})).stderr).toContain("absolute export directory");
    const result = await backend.cli(["export", PR, "/tmp/export", "--machine", HOST_ID], {});
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Manifest: /tmp/export/manifest.json");
  });

  it.each([
    [PR], [PR, "out", "extra"], [PR, "out", "--unknown"],
    [PR, "out", "--sha"], [PR, "out", "--sha", "a"],
    [PR, "out", "--sha", "g".repeat(40)], [PR, "out", "--machine"],
  ])("rejects invalid export arguments %j before writing", async (...args) => {
    const result = await backend.cli(["export", ...args], { threadId: THREAD_ID, cwd: "/work/repo" });
    expect(result.exitCode).toBe(1);
    expect(writes()).toHaveLength(0);
  });
});
