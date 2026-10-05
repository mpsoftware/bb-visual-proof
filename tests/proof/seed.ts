// Demo data for the screenshot proof: real PNG/WebM files rendered by shoot.mjs, uploaded through the real CLI.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Annotation, SetDetail } from "../../src/contract.js";
import type { Backend } from "../backend.js";

const sha = (char: string) => char.repeat(40);
export const HEADS = { oldShop: sha("1"), shop: sha("3"), billing: sha("9"), chartsOld: sha("c"), chartsNew: sha("d"), plugins: sha("7") };

async function upload(backend: Backend, pr: string, files: Array<[string, string?]>) {
  const argv = ["add", pr, "--no-comment", ...files.flatMap(([file, caption]) => (caption ? ["--caption", caption, file] : [file]))];
  const result = await backend.cli(argv, { threadId: "thr-implementer", cwd: "/work/proof" });
  if (result.exitCode !== 0) throw new Error(result.stderr);
}

async function detail(backend: Backend, repository: string, number: number): Promise<SetDetail> {
  return (await backend.rpc("proofs_detail", { repository, number }) as { detail: SetDetail }).detail;
}

async function annotate(backend: Backend, setId: string, assetId: string | null, anchor: object, body: string) {
  return await backend.rpc("proofs_annotation_add", { setId, assetId, anchor, body }) as Annotation;
}

/** `demo`: one PR per state. `review`: only the PR under review, for the send-back and approve scenes. */
export async function seed(backend: Backend, scenario: string, mediaDir: string) {
  if (scenario === "empty") return;
  if (scenario === "no-thread") {
    // Uploaded outside a BB thread: nobody can receive the decision.
    backend.hostFiles.set("/work/proof/settings.png", readFileSync(join(mediaDir, "settings.png")));
    backend.setPr("acme/plugins", 15, { headSha: HEADS.plugins, title: "Settings: plugin details" });
    const result = await backend.cli(["add", "acme/plugins#15", "--no-comment", "--machine", "host-build", "--caption", "Settings – details", "/work/proof/settings.png"], {});
    if (result.exitCode !== 0) throw new Error(result.stderr);
    const proof = await detail(backend, "acme/plugins", 15);
    await annotate(backend, proof.set.id, proof.assets[0]!.id, { kind: "rect", x: 0.02, y: 0.1, w: 0.55, h: 0.35 }, "Row spacing could be a little larger.");
    await backend.rpc("proofs_approve", { setId: proof.set.id, revision: backend.revision(proof.set.id), note: "Looks good." });
    return;
  }
  for (const name of ["checkout-light.png", "checkout-dark.png", "checkout-mobile.png", "checkout-old.png", "dashboard.png", "chart.png", "settings.png", "checkout-flow.webm"]) {
    backend.hostFiles.set(`/work/proof/${name}`, readFileSync(join(mediaDir, name)));
  }

  // acme/shop #231: round 1 on an older head was sent back; the current head waits for review with fresh comments.
  backend.setPr("acme/shop", 231, { headSha: HEADS.oldShop, title: "Checkout form: new layout with summary" });
  await upload(backend, "acme/shop#231", [["checkout-old.png", "Checkout – light, desktop"], ["checkout-mobile.png", "Checkout – mobile"]]);
  const old = await detail(backend, "acme/shop", 231);
  await annotate(backend, old.set.id, old.assets[0]!.id, { kind: "rect", x: 0.56, y: 0.2, w: 0.38, h: 0.3 }, "Summary is missing on the right.");
  await backend.rpc("proofs_send_back", { setId: old.set.id, revision: backend.revision(old.set.id) });
  backend.setPr("acme/shop", 231, { headSha: HEADS.shop });
  await upload(backend, "acme/shop#231", [
    ["checkout-light.png", "Checkout – light, desktop"], ["checkout-dark.png", "Checkout – dark, desktop"],
    ["checkout-mobile.png", "Checkout – mobile"], ["checkout-flow.webm", "Flow: place the order"],
  ]);

  if (scenario === "review") return;

  const current = await detail(backend, "acme/shop", 231);
  const [light, , , video] = current.assets;
  await annotate(backend, current.set.id, light!.id, { kind: "rect", x: 0.6, y: 0.735, w: 0.3, h: 0.1 }, "Button label is cut off: \"Place order and continue…\". Please wrap or shorten it.");
  await annotate(backend, current.set.id, light!.id, { kind: "rect", x: 0.04, y: 0.3, w: 0.5, h: 0.24 }, "Spacing between the fields is inconsistent (16 vs. 24 px).");
  await annotate(backend, current.set.id, video!.id, { kind: "time", ms: 2000 }, "The button briefly flashes white on submit.");

  backend.setPr("acme/billing", 88, { headSha: HEADS.billing, title: "Dashboard: metric tiles" });
  await upload(backend, "acme/billing#88", [["dashboard.png", "Dashboard – overview"]]);
  const billing = await detail(backend, "acme/billing", 88);
  await annotate(backend, billing.set.id, billing.assets[0]!.id, { kind: "rect", x: 0.05, y: 0.25, w: 0.9, h: 0.3 }, "Tiles jump while loading.");
  await backend.rpc("proofs_send_back", { setId: billing.set.id, revision: backend.revision(billing.set.id) });

  backend.setPr("acme/charts", 812, { headSha: HEADS.chartsOld, title: "Chart legend with scenario colours" });
  await upload(backend, "acme/charts#812", [["chart.png", "Chart with legend"]]);
  backend.setPr("acme/charts", 812, { headSha: HEADS.chartsNew });
  await backend.rpc("proofs_check_head", { repository: "acme/charts", number: 812 });

  backend.setPr("acme/plugins", 14, { headSha: HEADS.plugins, title: "Settings: plugin overview" });
  await upload(backend, "acme/plugins#14", [["settings.png", "Settings – overview"]]);
  const plugins = await detail(backend, "acme/plugins", 14);
  await backend.rpc("proofs_approve", { setId: plugins.set.id, revision: backend.revision(plugins.set.id), note: "Looks good as is." });

  // Stable ordering for the list: most recent activity on acme/shop.
  backend.db().prepare("UPDATE proof_sets SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 hours') WHERE repository = 'acme/charts'").run();
  backend.db().prepare("UPDATE proof_sets SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 days') WHERE repository = 'acme/billing'").run();
}
