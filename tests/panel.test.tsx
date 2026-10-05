// @vitest-environment jsdom
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, createEvent, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { SetDetail } from "../src/contract.js";
import { detailSubPath, formatBytes, formatDate, parseSubPath } from "../src/panel/model.js";
import { createBackend, fixtures, type Backend } from "./backend.js";
import { HEADS, seed } from "./proof/seed.js";

const app = await loadPluginApp(() => import("../app.js"));
// Imported after the app: the SDK binds its hooks to the test runtime when the app module loads.
const { resolveLocale } = await import("../src/panel/i18n.js");
const panel = app.navPanels.find((entry) => entry.id === "visual-proof")!;
const METHODS = [
  "proofs_list", "proofs_detail", "proofs_check_head", "proofs_annotation_add", "proofs_annotation_update", "proofs_annotation_delete",
  "proofs_stage_render", "proofs_send_back", "proofs_approve", "proofs_retry", "proofs_thumbnail_put", "proofs_delete_media", "proofs_pending_count",
] as const;

let mediaDir: string;
beforeAll(() => {
  // jsdom loads no media; fail image loads the way a browser reports a broken image, so send back falls back to text.
  for (const prototype of [HTMLImageElement.prototype, HTMLMediaElement.prototype]) {
    Object.defineProperty(prototype, "src", {
      configurable: true,
      set(this: HTMLImageElement | HTMLMediaElement) { setTimeout(() => this.onerror?.(new Event("error"))); },
      get() { return ""; },
    });
  }
  // The viewer measures its stage; jsdom has no ResizeObserver and no layout.
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  mediaDir = mkdtempSync(join(tmpdir(), "visual-proof-panel-media-"));
  const names = ["checkout-light.png", "checkout-dark.png", "checkout-mobile.png", "checkout-old.png", "dashboard.png", "chart.png", "settings.png"];
  names.forEach((name, index) => writeFileSync(join(mediaDir, name), fixtures.png(index + 1)));
  writeFileSync(join(mediaDir, "checkout-flow.webm"), fixtures.webm(1));
});
afterAll(() => rmSync(mediaDir, { recursive: true, force: true }));

const backends: Backend[] = [];
afterEach(async () => {
  cleanup();
  for (const backend of backends.splice(0)) await backend.dispose();
});

async function backend(scenario: "empty" | "demo" | "review" | "no-thread") {
  const created = await createBackend();
  backends.push(created);
  await seed(created, scenario, mediaDir);
  return created;
}

// The assertions below are English; the language tests pass their own settings.
function render(backend: Backend, subPath = "", settings: Record<string, string> = { language: "en" }) {
  const rpc = Object.fromEntries(METHODS.map((method) => [method, (input: unknown) => backend.rpc(method, input)]));
  return renderSlot(panel, { subPath }, { rpc: rpc as never, settings });
}

const detail = async (backend: Backend, repository: string, number: number) =>
  (await backend.rpc("proofs_detail", { repository, number }) as { detail: SetDetail }).detail;

describe("registration and routing", () => {
  it("registers one nav panel with a pending-count accessory", () => {
    expect(app.navPanels).toHaveLength(1);
    expect(panel).toMatchObject({ id: "visual-proof", title: "Visual proof", path: "proofs", icon: "Eye" });
    expect(panel.experimental_sidebarAccessory).toBeTypeOf("function");
  });

  it("maps sub-paths to a PR detail and back", () => {
    expect(parseSubPath("")).toEqual({ kind: "list" });
    expect(parseSubPath("Acme/Shop/231")).toEqual({ kind: "detail", repository: "acme/shop", number: 231 });
    expect(parseSubPath(detailSubPath("acme/shop", 231, "set-1"))).toMatchObject({ setId: "set-1" });
    expect(parseSubPath("acme/shop/abc")).toEqual({ kind: "list" });
  });
});

describe("list", () => {
  it("shows the upload hint when nothing waits", async () => {
    const slot = render(await backend("empty"));
    expect(await slot.findByText("No open proofs.")).toBeTruthy();
    expect(slot.getByText(/bb visual-proof add/)).toBeTruthy();
  });

  it("lists open proofs by urgency and opens a PR", async () => {
    const slot = render(await backend("demo"));
    const list = await slot.findByRole("list", { name: "Open proofs" });
    const titles = within(list).getAllByRole("article").map((article) => article.getAttribute("aria-labelledby") && within(article).getByRole("heading").textContent);
    expect(titles).toEqual(["Checkout form: new layout with summary", "Dashboard: metric tiles", "Chart legend with scenario colours"]);
    expect(within(list).getByText("Head moved on")).toBeTruthy();
    fireEvent.click(within(list).getByRole("button", { name: "Dashboard: metric tiles" }));
    expect(slot.navigateCalls.at(-1)).toMatchObject({ method: "toPluginPanel", path: "proofs", options: { subPath: "acme/billing/88" } });
    fireEvent.click(slot.getByRole("button", { name: /^Approved/ }));
    expect(await slot.findByRole("button", { name: "Settings: plugin overview" })).toBeTruthy();
  });
});

describe("review", () => {
  it("adds a note for the whole set", async () => {
    const proof = await backend("review");
    const slot = render(proof, "acme/shop/231");
    fireEvent.click(await slot.findByRole("button", { name: "+ General" }));
    fireEvent.change(slot.getByLabelText(/New comment · Whole set/), { target: { value: "Please also show the error state." } });
    fireEvent.click(slot.getByRole("button", { name: "Save" }));
    expect(await slot.findByText("Please also show the error state.")).toBeTruthy();
    expect((await detail(proof, "acme/shop", 231)).annotations).toMatchObject([{ assetId: null, anchor: { kind: "none" }, number: 1 }]);
  });

  it("sends the open comments back and switches to changes requested", async () => {
    const proof = await backend("demo");
    const slot = render(proof, "acme/shop/231");
    fireEvent.click(await slot.findByRole("button", { name: "Reject (3)" }));
    const dialog = await slot.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Reject" }));
    expect(await slot.findByText("3 comments sent to the implementer thread.")).toBeTruthy();
    expect(await slot.findByText(/Sent back for changes on .* \(round 1\)/)).toBeTruthy();
    expect(proof.sent.at(-1)!.text).toContain("The button briefly flashes white on submit.");
    expect(slot.queryByRole("button", { name: /Edit/ })).toBeNull();
  });

  it("approves the current head with a note", async () => {
    const proof = await backend("demo");
    const slot = render(proof, "acme/shop/231");
    fireEvent.click(await slot.findByRole("button", { name: "Approve" }));
    const dialog = await slot.findByRole("dialog");
    expect(within(dialog).getByText(/3 unsent comments go along as non-blocking remarks/)).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("Note (optional)"), { target: { value: "Looks good." } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Approve" }));
    expect(await slot.findByText(/Approved on .* for head 3333333/)).toBeTruthy();
    await waitFor(() => expect(slot.queryByRole("button", { name: "Approve" })).toBeNull());
  });

  it("refuses approval after the head moved and shows the proof as outdated", async () => {
    const proof = await backend("demo");
    const slot = render(proof, "acme/shop/231");
    proof.setPr("acme/shop", 231, { headSha: "e".repeat(40) });
    fireEvent.click(await slot.findByRole("button", { name: "Approve" }));
    fireEvent.click(within(await slot.findByRole("dialog")).getByRole("button", { name: "Approve" }));
    expect(await slot.findByText(/Not approved: The PR head moved to eeeeeee/)).toBeTruthy();
    expect(await slot.findByText("This proof is outdated and read-only.")).toBeTruthy();
  });

  it("shows an outdated head read-only with a link to the newest proof", async () => {
    const proof = await backend("demo");
    const { history } = await detail(proof, "acme/shop", 231);
    const old = history.find((set) => set.headSha === HEADS.oldShop)!;
    const slot = render(proof, `acme/shop/231/${old.id}`);
    expect(await slot.findByText("This proof is outdated and read-only.")).toBeTruthy();
    expect(slot.queryByRole("button", { name: /Reject/ })).toBeNull();
    expect(slot.queryByRole("button", { name: "Comment on whole image" })).toBeNull();
    expect((slot.getByLabelText("Head") as HTMLSelectElement).selectedOptions[0]!.textContent).toContain("outdated, sent back");
    fireEvent.click(slot.getByRole("button", { name: /Go to the newest set/ }));
    expect(slot.navigateCalls.at(-1)).toMatchObject({ method: "toPluginPanel", options: { subPath: expect.stringMatching(/^acme\/shop\/231\//) } });
  });
});

describe("review fixes", () => {
  it("marks a region with the keyboard only", async () => {
    const proof = await backend("review");
    const slot = render(proof, "acme/shop/231");
    fireEvent.click(await slot.findByRole("button", { name: "Mark area" }));
    const left = slot.getByLabelText("Left") as HTMLInputElement;
    expect(document.activeElement).toBe(left);
    expect(slot.getByRole("group", { name: "Area in % of the image" })).toBeTruthy();
    // Size first: moving keeps the size and never pushes the box past the image edge.
    fireEvent.change(slot.getByLabelText("Width"), { target: { value: "30" } });
    fireEvent.change(slot.getByLabelText("Height"), { target: { value: "10" } });
    fireEvent.change(left, { target: { value: "60" } });
    fireEvent.change(slot.getByLabelText("Top"), { target: { value: "73" } });
    // Growing past the edge stops at the image border.
    fireEvent.change(slot.getByLabelText("Width"), { target: { value: "90" } });
    fireEvent.change(slot.getByLabelText(/New comment/), { target: { value: "Button label cut off." } });
    fireEvent.click(slot.getByRole("button", { name: "Save" }));
    expect(await slot.findByText("Button label cut off.")).toBeTruthy();
    const [saved] = (await detail(proof, "acme/shop", 231)).annotations;
    expect(saved!.anchor).toEqual({ kind: "rect", x: 0.6, y: 0.73, w: 0.4, h: 0.1 });
  });

  it("cancels a keyboard region with Escape", async () => {
    const proof = await backend("review");
    const slot = render(proof, "acme/shop/231");
    fireEvent.click(await slot.findByRole("button", { name: "Mark area" }));
    fireEvent.keyDown(slot.getByLabelText("Left"), { key: "Escape" });
    await waitFor(() => expect(slot.queryByLabelText("Left")).toBeNull());
    expect((await detail(proof, "acme/shop", 231)).annotations).toEqual([]);
  });

  it("shows an undelivered send back and delivers it on retry", async () => {
    const proof = await backend("demo");
    proof.failSends("thread is archived");
    const slot = render(proof, "acme/shop/231");
    fireEvent.click(await slot.findByRole("button", { name: "Reject (3)" }));
    fireEvent.click(within(await slot.findByRole("dialog")).getByRole("button", { name: "Reject" }));
    const notice = await slot.findByRole("alert", { name: "Pending delivery" });
    expect(within(notice).getByText(/Send back not delivered/)).toBeTruthy();
    expect(slot.getAllByText("decided · message not delivered yet")).toHaveLength(3);
    proof.failSends(null);
    fireEvent.click(within(notice).getByRole("button", { name: "Deliver again now" }));
    expect(await slot.findByText("Pending items delivered.")).toBeTruthy();
    await waitFor(() => expect(slot.queryByRole("alert", { name: "Pending delivery" })).toBeNull());
    expect(proof.sent.filter((message) => message.text.includes("sent back"))).toHaveLength(3);
  });

  it("refuses an approval of a revision that changed after the panel loaded", async () => {
    const proof = await backend("demo");
    const slot = render(proof, "acme/shop/231");
    fireEvent.click(await slot.findByRole("button", { name: "Approve" }));
    const { set } = await detail(proof, "acme/shop", 231);
    await proof.rpc("proofs_annotation_add", { setId: set.id, assetId: null, anchor: { kind: "none" }, body: "New from elsewhere" });
    fireEvent.click(within(await slot.findByRole("dialog")).getByRole("button", { name: "Approve" }));
    expect(await slot.findByText(/Not approved: This proof changed since you opened it/)).toBeTruthy();
    expect(await slot.findByText("New from elsewhere")).toBeTruthy();
    expect((await detail(proof, "acme/shop", 231)).set.status).toBe("pending");
  });

  it("shows remarks of an approval without implementer thread as not delivered", async () => {
    const proof = await backend("no-thread");
    const slot = render(proof, "acme/plugins/15");
    expect(await slot.findByText("decided · no implementer thread, not delivered")).toBeTruthy();
    expect(slot.getByText(/No implementer thread known: the approval and its remarks were not delivered to anyone/)).toBeTruthy();
    expect(slot.queryByText(/sent · round/)).toBeNull();
  });
});

describe("inline zoom", () => {
  const SHOP = "acme/shop/231";
  // jsdom has no layout: the stage measures 800 × 600 and every proof image loads at 1600 × 1000, so fit is 50 %.
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0 } as DOMRect);
    HTMLElement.prototype.setPointerCapture ??= () => {};
  });
  afterEach(() => vi.restoreAllMocks());

  const loadImage = (viewer: HTMLElement) => {
    const image = viewer.querySelector("img")!;
    Object.defineProperty(image, "naturalWidth", { value: 1600 });
    Object.defineProperty(image, "naturalHeight", { value: 1000 });
    fireEvent.load(image);
  };
  const zoomLevel = (viewer: HTMLElement) => within(viewer).getByRole("status", { name: "Zoom level" }).textContent;
  const layer = (viewer: HTMLElement) => viewer.querySelector("img")!.parentElement!;

  async function openViewer(slot: ReturnType<typeof render>) {
    const stage = await slot.findByRole("group", { name: /^Image area/ });
    const viewer = stage.closest("section")!;
    loadImage(viewer);
    await waitFor(() => expect(zoomLevel(viewer)).toBe("50%"));
    return { viewer, stage };
  }

  it("mounts the zoom in the panel without an overlay, in a stage of fixed height", async () => {
    const slot = render(await backend("demo"), SHOP);
    const { viewer, stage } = await openViewer(slot);
    expect(slot.queryByRole("dialog")).toBeNull();
    expect(slot.queryByRole("button", { name: /^(Zoom|Full view|Close)$/ })).toBeNull();
    expect(viewer.getAttribute("aria-label")).toBe("File 1 of 4: Checkout – light, desktop");
    // The hint that the dialog description used to give is now the stage's description.
    expect(document.getElementById(stage.getAttribute("aria-describedby")!)!.textContent).toBe("+ / − zoom, 0 whole image, 1 actual size, ← / → switch files, ↑ / ↓ pan.");
    expect(stage.className).toContain("h-[60vh]");
    // Switching files keeps the same stage and toolbar; only the media inside changes.
    const toolbar = within(viewer).getByRole("button", { name: "Zoom in" }).parentElement!.parentElement!.textContent;
    for (let step = 0; step < 4; step += 1) {
      fireEvent.click(within(viewer).getByRole("button", { name: "Next file" }));
      expect(slot.getByRole("group", { name: /^Image area/ })).toBe(stage);
      expect(stage.className).toContain("h-[60vh]");
    }
    expect(viewer.getAttribute("aria-label")).toBe("File 1 of 4: Checkout – light, desktop");
    expect(within(viewer).getByRole("button", { name: "Zoom in" }).parentElement!.parentElement!.textContent).toBe(toolbar);
  });

  it("zooms by keys, buttons, wheel and drag and keeps the boxes on the image", async () => {
    const slot = render(await backend("demo"), SHOP);
    const { viewer, stage } = await openViewer(slot);
    expect((within(viewer).getByRole("button", { name: "Zoom out" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.keyDown(stage, { key: "+" });
    expect(zoomLevel(viewer)).toBe("63%");
    fireEvent.click(within(viewer).getByRole("button", { name: "Actual size 1:1" }));
    expect(zoomLevel(viewer)).toBe("100%");
    // At 1:1 the image is drawn at its pixel size; the boxes are percentages of it, so they cover the same pixels.
    expect(layer(viewer).style).toMatchObject({ width: "1600px", height: "1000px", transform: "translate(-400px, -200px)" });
    const boxes = [...layer(viewer).querySelectorAll<HTMLElement>(":scope > div")].map((box) => [box.style.left, box.style.top, box.style.width]);
    expect(boxes).toEqual([["60%", "73.5%", "30%"], ["4%", "30%", "50%"]]);

    // Pan mode: dragging moves the image with the pointer.
    expect(within(viewer).getByRole("button", { name: "Pan" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.pointerDown(stage, { pointerId: 1, button: 0, pointerType: "mouse", clientX: 400, clientY: 300 });
    fireEvent.pointerMove(stage, { pointerId: 1, pointerType: "mouse", clientX: 300, clientY: 250 });
    fireEvent.pointerUp(stage, { pointerId: 1, pointerType: "mouse", clientX: 300, clientY: 250 });
    expect(layer(viewer).style.transform).toBe("translate(-500px, -250px)");

    fireEvent.keyDown(stage, { key: "0" });
    expect(zoomLevel(viewer)).toBe("50%");
    stage.focus();
    fireEvent.wheel(stage, { deltaY: -100, clientX: 400, clientY: 300 });
    expect(zoomLevel(viewer)).toBe("61%");
    fireEvent.click(within(viewer).getByRole("button", { name: "Whole image" }));
    expect(zoomLevel(viewer)).toBe("50%");
  });

  it("leaves the plain wheel to the page until the stage has focus; Ctrl or pinch always zooms", async () => {
    const slot = render(await backend("demo"), SHOP);
    const { viewer, stage } = await openViewer(slot);
    const wheel = (init: WheelEventInit) => {
      const event = createEvent.wheel(stage, { deltaY: -100, clientX: 400, clientY: 300, ...init });
      fireEvent(stage, event);
      return event.defaultPrevented;
    };
    expect(wheel({})).toBe(false);
    expect(zoomLevel(viewer)).toBe("50%");
    expect(wheel({ ctrlKey: true })).toBe(true);
    expect(zoomLevel(viewer)).not.toBe("50%");
    fireEvent.keyDown(stage, { key: "0" });
    // A click into the image (pan mode, the start mode) marks nothing; the browser focuses the stage, then the wheel zooms.
    fireEvent.pointerDown(stage, { pointerId: 1, button: 0, pointerType: "mouse", clientX: 400, clientY: 300 });
    fireEvent.pointerUp(stage, { pointerId: 1, pointerType: "mouse", clientX: 400, clientY: 300 });
    stage.focus();
    expect(slot.queryByLabelText(/New comment/)).toBeNull();
    expect(wheel({})).toBe(true);
    expect(zoomLevel(viewer)).toBe("61%");
  });

  it("switches files with the arrow keys and fits each new file", async () => {
    const slot = render(await backend("demo"), SHOP);
    const { viewer, stage } = await openViewer(slot);
    fireEvent.keyDown(stage, { key: "1" });
    fireEvent.keyDown(stage, { key: "ArrowRight" });
    expect(within(viewer).getByText("2 / 4")).toBeTruthy();
    expect(viewer.getAttribute("aria-label")).toBe("File 2 of 4: Checkout – dark, desktop");
    loadImage(viewer);
    await waitFor(() => expect(zoomLevel(viewer)).toBe("50%"));
    // There is no "keep zoom" checkbox: every file starts fitted.
    expect(within(viewer).queryByRole("checkbox")).toBeNull();
    fireEvent.keyDown(stage, { key: "1" });
    fireEvent.keyDown(stage, { key: "ArrowLeft" });
    expect(within(viewer).getByText("1 / 4")).toBeTruthy();
    loadImage(viewer);
    await waitFor(() => expect(zoomLevel(viewer)).toBe("50%"));
  });

  it("marks a region while zoomed in and continues in the comment field", async () => {
    const proof = await backend("review");
    const slot = render(proof, SHOP);
    const { viewer, stage } = await openViewer(slot);
    fireEvent.keyDown(stage, { key: "1" });
    const mark = within(viewer).getByRole("button", { name: "Mark" });
    fireEvent.click(mark);
    expect(mark.getAttribute("aria-pressed")).toBe("true");
    // At 1:1 the stage centre (400, 300) shows the image centre; 160 × 100 screen pixels are 10 % of the image each way.
    fireEvent.pointerDown(stage, { pointerId: 1, button: 0, pointerType: "mouse", clientX: 400, clientY: 300 });
    fireEvent.pointerMove(stage, { pointerId: 1, pointerType: "mouse", clientX: 560, clientY: 400 });
    fireEvent.pointerUp(stage, { pointerId: 1, pointerType: "mouse", clientX: 560, clientY: 400 });
    const comment = await slot.findByLabelText(/New comment/);
    await waitFor(() => expect(document.activeElement).toBe(comment));
    expect(within(viewer).getByText("new")).toBeTruthy();
    expect(["Left", "Top", "Width", "Height"].map((label) => (slot.getByLabelText(label) as HTMLInputElement).value)).toEqual(["50", "50", "10", "10"]);
    fireEvent.change(comment, { target: { value: "Axis labels are too small." } });
    fireEvent.click(slot.getByRole("button", { name: "Save" }));
    expect(await slot.findByText("Axis labels are too small.")).toBeTruthy();
    const [saved] = (await detail(proof, "acme/shop", 231)).annotations;
    expect(saved!.anchor).toMatchObject({ kind: "rect", x: 0.5, y: 0.5 });
    expect((saved!.anchor as { w: number }).w).toBeCloseTo(0.1, 9);
  });

  it("drops a marking that is still in progress when the file changes", async () => {
    const proof = await backend("review");
    const slot = render(proof, SHOP);
    const { viewer, stage } = await openViewer(slot);
    fireEvent.click(within(viewer).getByRole("button", { name: "Mark" }));
    fireEvent.pointerDown(stage, { pointerId: 1, button: 0, pointerType: "mouse", clientX: 100, clientY: 100 });
    fireEvent.keyDown(stage, { key: "ArrowRight" });
    loadImage(viewer);
    await waitFor(() => expect(zoomLevel(viewer)).toBe("50%"));
    fireEvent.pointerMove(stage, { pointerId: 1, pointerType: "mouse", clientX: 500, clientY: 400 });
    fireEvent.pointerUp(stage, { pointerId: 1, pointerType: "mouse", clientX: 500, clientY: 400 });
    expect(within(viewer).queryByText("new")).toBeNull();
    expect(slot.queryByLabelText(/New comment/)).toBeNull();
  });

  it("pinches with two touches around the moving midpoint and clamps once", async () => {
    const slot = render(await backend("demo"), SHOP);
    const { viewer, stage } = await openViewer(slot);
    fireEvent.keyDown(stage, { key: "1" });
    // From 1:1 at x = -400, drag right to x = -100.
    fireEvent.pointerDown(stage, { pointerId: 1, button: 0, pointerType: "mouse", clientX: 100, clientY: 300 });
    fireEvent.pointerMove(stage, { pointerId: 1, pointerType: "mouse", clientX: 400, clientY: 300 });
    fireEvent.pointerUp(stage, { pointerId: 1, pointerType: "mouse", clientX: 400, clientY: 300 });
    expect(layer(viewer).style.transform).toBe("translate(-100px, -200px)");
    // Midpoint 700 → 550, distance 200 → 150: scale 0.75. Zooming around 700 alone would hit the left edge (x = 0)
    // before the midpoint moves; together the image point stays under the fingers at x = 550 - 800 × 0.75 = -50.
    fireEvent.pointerDown(stage, { pointerId: 11, button: 0, pointerType: "touch", clientX: 600, clientY: 300 });
    fireEvent.pointerDown(stage, { pointerId: 12, button: 0, pointerType: "touch", clientX: 800, clientY: 300 });
    fireEvent.pointerMove(stage, { pointerId: 11, pointerType: "touch", clientX: 475, clientY: 300 });
    fireEvent.pointerMove(stage, { pointerId: 12, pointerType: "touch", clientX: 625, clientY: 300 });
    expect(zoomLevel(viewer)).toBe("75%");
    expect(layer(viewer).style.transform).toBe("translate(-50px, -75px)");
    fireEvent.pointerUp(stage, { pointerId: 11, pointerType: "touch", clientX: 475, clientY: 300 });
    fireEvent.pointerUp(stage, { pointerId: 12, pointerType: "touch", clientX: 625, clientY: 300 });
  });

  it("leaves arrow keys to a focused video", async () => {
    const slot = render(await backend("demo"), SHOP);
    const { viewer, stage } = await openViewer(slot);
    fireEvent.keyDown(stage, { key: "ArrowLeft" });
    expect(within(viewer).getByText("4 / 4")).toBeTruthy();
    const video = viewer.querySelector("video")!;
    for (const key of ["ArrowRight", "ArrowLeft", "ArrowUp", "+", "0"]) {
      const event = createEvent.keyDown(video, { key });
      fireEvent(video, event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(within(viewer).getByText("4 / 4")).toBeTruthy();
    expect(viewer.querySelector("video")).toBe(video);
    // The video in the stage is the one "Comment at current time" reads.
    fireEvent.click(slot.getByRole("button", { name: "Comment at current time" }));
    expect(await slot.findByLabelText(/New comment · .* · at 0:00/)).toBeTruthy();
    // The stage still switches files.
    fireEvent.keyDown(stage, { key: "ArrowRight" });
    expect(within(viewer).getByText("1 / 4")).toBeTruthy();
  });

  it("zooms a read-only image without the marking mode", async () => {
    const slot = render(await backend("no-thread"), "acme/plugins/15");
    await slot.findByText(/Approved on/);
    const { viewer, stage } = await openViewer(slot);
    expect(within(viewer).queryByRole("group", { name: "Mode" })).toBeNull();
    fireEvent.keyDown(stage, { key: "+" });
    expect(zoomLevel(viewer)).toBe("63%");
  });
});

describe("language", () => {
  afterEach(() => vi.restoreAllMocks());

  it("resolves the setting first, then the browser and page languages, else English", () => {
    expect(resolveLocale("de", ["en-US"])).toBe("de");
    expect(resolveLocale("en", ["de-DE"])).toBe("en");
    expect(resolveLocale("auto", ["fr-FR", "de-AT", "en"])).toBe("de");
    expect(resolveLocale(undefined, [undefined, "", "EN-gb"])).toBe("en");
    expect(resolveLocale("auto", ["fr", "it"])).toBe("en");
    expect(resolveLocale("xx", [])).toBe("en");
  });

  it("formats numbers and dates in the panel language", () => {
    expect(formatBytes(1.5 * 1024 * 1024, "de")).toBe("1,5 MB");
    expect(formatBytes(1.5 * 1024 * 1024, "en")).toBe("1.5 MB");
    expect(formatDate("2026-10-05T12:00:00Z", "de")).toBe("05.10.2026");
    expect(formatDate("2026-10-05T12:00:00Z", "en")).toBe("Oct 5, 2026");
  });

  it("follows the browser language when the setting is auto", async () => {
    vi.spyOn(navigator, "languages", "get").mockReturnValue(["de-DE", "en"]);
    const slot = render(await backend("empty"), "", { language: "auto" });
    expect(await slot.findByText("Keine offenen Nachweise.")).toBeTruthy();
    expect(slot.container.querySelector("[lang]")!.getAttribute("lang")).toBe("de");
  });

  it("shows English when the browser prefers it, and the setting overrides the browser", async () => {
    vi.spyOn(navigator, "languages", "get").mockReturnValue(["en-US"]);
    const english = render(await backend("demo"), "acme/shop/231", {});
    expect(await english.findByRole("button", { name: "Approve" })).toBeTruthy();
    expect(english.getByRole("group", { name: /^Image area/ })).toBeTruthy();
    expect(english.getByRole("heading", { name: "Comments (3)" })).toBeTruthy();
    expect(english.getByRole("button", { name: "Whole image" })).toBeTruthy();
    expect(english.container.querySelector("[lang]")!.getAttribute("lang")).toBe("en");
    cleanup();

    const german = render(await backend("demo"), "acme/shop/231", { language: "de" });
    expect(await german.findByRole("heading", { name: "Kommentare (3)" })).toBeTruthy();
  });

  it("translates known server refusals into German", async () => {
    const proof = await backend("demo");
    const slot = render(proof, "acme/shop/231", { language: "de" });
    proof.setPr("acme/shop", 231, { headSha: "e".repeat(40) });
    fireEvent.click(await slot.findByRole("button", { name: "Approve" }));
    fireEvent.click(within(await slot.findByRole("dialog")).getByRole("button", { name: "Approve" }));
    expect(await slot.findByText(/Nicht freigegeben: Der PR steht inzwischen auf eeeeeee/)).toBeTruthy();
  });
});
