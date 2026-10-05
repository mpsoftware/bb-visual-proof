// Captures the panel screenshots, the sent-back message and a text-contrast report into a fresh temp directory.
// Usage (from the repository root, after `npm run build`):
//   PLAYWRIGHT_CORE=/path/to/playwright-core/index.mjs node tests/proof/shoot.mjs
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { renderDemoMedia } from "./media.mjs";

const { chromium } = await import(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
// PROOF_OUT_DIR picks the output directory; without it every run writes to a new temp directory, never into the repository.
const outDir = (process.env.PROOF_OUT_DIR || mkdtempSync(join(tmpdir(), "visual-proof-shots-"))).replace(/\/?$/, "/");
mkdirSync(outDir, { recursive: true });

const mediaDir = await renderDemoMedia(chromium);
const server = await createServer({ configFile: fileURLToPath(new URL("./vite.config.ts", import.meta.url)), server: { port: 0, watch: null } });
await server.listen();
const base = server.resolvedUrls.local[0];
const browser = await chromium.launch();
const contrast = [];
const shots = [];

const DESKTOP = { width: 1440, height: 900 };
const NARROW = { width: 390, height: 844 };
const SHOP = "acme/shop/231";

async function reset(scenario, settings) {
  const response = await fetch(`${base}__proof/reset`, { method: "POST", body: JSON.stringify({ scenario, mediaDir, settings }) });
  const body = await response.json();
  if (!body.ok) throw new Error(`reset ${scenario}: ${body.error}`);
}

async function rpc(method, input) {
  const response = await fetch(`${base}__proof/rpc/${method}`, { method: "POST", body: JSON.stringify(input) });
  const body = await response.json();
  if (!body.ok) throw new Error(`${method}: ${body.error}`);
  return body.result;
}

async function open({ theme = "light", viewport = DESKTOP, sub = "", query = "" } = {}) {
  const page = await browser.newPage({ viewport, colorScheme: theme });
  // The screenshots show the English panel; `lang=` in `query` overrides it.
  const language = /(^|&)lang=/.test(query) ? "" : "&lang=en";
  await page.goto(`${base}?theme=${theme}${language}${sub ? `&sub=${encodeURIComponent(sub)}` : ""}${query ? `&${query}` : ""}`);
  return page;
}

const post = (path, body) => fetch(`${base}__proof/${path}`, { method: "POST", body: JSON.stringify(body ?? {}) });

/** The panel makes thumbnails in the browser; wait until every file of a PR (or one set) has one. */
async function waitForThumbnails(repository, number, setId) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const { detail } = await rpc("proofs_detail", { repository, number, ...(setId ? { setId } : {}) });
    if (detail.assets.every((asset) => asset.hasThumbnail)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`No thumbnails for ${repository}#${number}`);
}

/** Waits until every visible image in the panel has loaded, so no screenshot shows half-decoded media. */
async function settle(page) {
  await page.mouse.move(0, 0);
  await page.waitForFunction(() => [...document.querySelectorAll("main img")].every((image) => image.complete));
  await page.waitForTimeout(450);
}

async function shot(page, file) {
  await settle(page);
  await page.screenshot({ path: `${outDir}${file}`, animations: "disabled" });
  shots.push(file);
  contrast.push({ file, ...(await measureContrast(page)) });
}

/**
 * Fails the run when an annotated image is blank: every pixel of a 32 × 32 reduction must not be near-black,
 * and the image must not be one flat colour, as a broken video frame would draw.
 */
async function assertNotBlank(base64, label, { greenButton = false } = {}) {
  const page = await browser.newPage();
  try {
    const stats = await page.evaluate(async (data) => {
      const image = new Image();
      image.src = `data:image/jpeg;base64,${data}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 32;
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0, 32, 32);
      const pixels = context.getImageData(0, 0, 32, 32).data;
      const light = [];
      for (let index = 0; index < pixels.length; index += 4) light.push((pixels[index] + pixels[index + 1] + pixels[index + 2]) / 3);
      const mean = light.reduce((sum, value) => sum + value, 0) / light.length;
      const spread = Math.sqrt(light.reduce((sum, value) => sum + (value - mean) ** 2, 0) / light.length);
      const dark = light.filter((value) => value < 16).length / light.length;
      // The fixture flow shows its green "Thank you!" button (#16a34a) from 0:02 on.
      let green = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        if (pixels[index + 1] > 120 && pixels[index + 1] - pixels[index] > 60 && pixels[index + 1] - pixels[index + 2] > 30) green += 1;
      }
      return { mean, spread, dark, green };
    }, base64);
    if (stats.dark > 0.9 || stats.spread < 4) throw new Error(`${label} looks blank: ${JSON.stringify(stats)}`);
    if (greenButton && stats.green < 2) throw new Error(`${label} does not show the fixture frame at 0:02: ${JSON.stringify(stats)}`);
  } finally {
    await page.close();
  }
}

/** Screenshots the panel's scroll container at a scroll position, for narrow layouts taller than the viewport. */
async function scrollTo(page, locator) {
  await locator.scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);
}

/** WCAG contrast of every visible text leaf in the panel and open dialogs, against its composited background. */
function measureContrast(page) {
  return page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const rgba = (color) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = "#000";
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    };
    const over = (top, bottom) => top.slice(0, 3).map((channel, index) => channel * top[3] + bottom[index] * (1 - top[3])).concat(1);
    const background = (element) => {
      const layers = [];
      for (let node = element; node; node = node.parentElement) {
        const color = rgba(getComputedStyle(node).backgroundColor);
        if (color[3] > 0) layers.push(color);
        if (color[3] >= 1) break;
      }
      let result = rgba(getComputedStyle(document.body).backgroundColor);
      for (const layer of layers.reverse()) result = over(layer, result);
      return result;
    };
    const luminance = ([r, g, b]) => [r, g, b].map((value) => {
      const channel = value / 255;
      return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
    const roots = [...document.querySelectorAll("main .body, [role=dialog], [data-testid=sidebar-proof] .accessory")];
    const failures = [];
    let checked = 0;
    let minimum = Infinity;
    for (const root of roots) {
      for (const element of root.querySelectorAll("*")) {
        const text = [...element.childNodes].filter((node) => node.nodeType === 3).map((node) => node.textContent.trim()).join("");
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        if (!text || box.width === 0 || style.visibility === "hidden" || element.closest(".sr-only, [aria-hidden=true]")) continue;
        if (element.closest(":disabled, [disabled]")) continue; // WCAG 1.4.3 exempts inactive controls.
        const backdrop = background(element);
        const foreground = over(rgba(style.color), backdrop);
        const [light, dark] = [luminance(foreground), luminance(backdrop)].sort((a, b) => b - a);
        const ratio = (light + 0.05) / (dark + 0.05);
        const size = parseFloat(style.fontSize);
        const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
        checked += 1;
        minimum = Math.min(minimum, ratio);
        if (ratio < (large ? 3 : 4.5)) failures.push({ text: text.slice(0, 60), ratio: Number(ratio.toFixed(2)) });
      }
    }
    return { checked, minimum: Number(minimum.toFixed(2)), failures };
  });
}

const card = (page, title) => page.getByRole("article", { name: title });
const notice = (page) => page.getByRole("status").filter({ hasText: /./ }).first();

try {
  // 01 Empty.
  await reset("empty");
  for (const theme of ["light", "dark"]) {
    const page = await open({ theme, viewport: { width: 1440, height: 560 } });
    await page.getByText("No open proofs.").waitFor();
    await shot(page, `01-empty-${theme}.png`);
    await page.close();
  }
  {
    const page = await open({ viewport: NARROW });
    await page.getByText("No open proofs.").waitFor();
    await shot(page, "01-empty-narrow.png");
    await page.close();
  }

  // 02 List with one PR per state; the done tab.
  await reset("demo");
  for (const theme of ["light", "dark"]) {
    const page = await open({ theme });
    await card(page, "Checkout form: new layout with summary").waitFor();
    await shot(page, `02-list-${theme}.png`);
    if (theme === "light") {
      await page.getByRole("button", { name: /^Approved/ }).click();
      await card(page, "Settings: plugin overview").waitFor();
      await shot(page, "02b-list-done-light.png");
    }
    await page.close();
  }
  {
    const page = await open({ viewport: NARROW });
    await card(page, "Checkout form: new layout with summary").waitFor();
    await shot(page, "02-list-narrow.png");
    await page.close();
  }

  // 03 A set under review: boxes on the screenshot, comments column, decision buttons.
  for (const theme of ["light", "dark"]) {
    const page = await open({ theme, sub: SHOP });
    await page.getByRole("heading", { name: "Comments (3)" }).waitFor();
    await page.getByRole("button", { name: /Show comment 1/ }).click();
    await shot(page, `03-set-review-${theme}.png`);
    if (theme === "light") {
      // The screencast with its time comment.
      await page.getByRole("button", { name: /Show comment 3/ }).click();
      await page.locator("video").evaluate((video) => new Promise((resolve) => {
        if (video.readyState >= 2) resolve(undefined); else video.addEventListener("loadeddata", () => resolve(undefined), { once: true });
      }));
      await page.waitForTimeout(400);
      await shot(page, "03b-set-screencast-light.png");
    }
    await page.close();
  }
  {
    const page = await open({ viewport: NARROW, sub: SHOP });
    await page.getByRole("heading", { name: "Comments (3)" }).waitFor();
    await shot(page, "03-set-review-narrow.png");
    await scrollTo(page, page.getByRole("button", { name: "Approve" }));
    await shot(page, "03c-set-review-narrow-comments.png");
    await page.close();
  }

  // 04 Annotating: drag a box on the image, write the comment, save.
  await reset("review");
  {
    const page = await open({ sub: SHOP });
    const image = page.locator("main img").first();
    await image.waitFor();
    await settle(page);
    // The viewer starts in "Pan"; marking is one click away.
    await page.getByRole("button", { name: "Mark", exact: true }).click();
    const box = await image.boundingBox();
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.73);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.84, { steps: 6 });
    await page.mouse.up();
    await page.getByLabel(/New comment/).fill("Button label is cut off. Please wrap or shorten it.");
    await shot(page, "04a-annotate-draft-light.png");
    await page.getByRole("button", { name: "Save" }).click();
    await notice(page).getByText("Comment 1 saved.").waitFor();
    await shot(page, "04b-annotate-saved-light.png");
    await page.close();
  }

  // 05 Send back: dialog, then the changes-requested state; keep the message and the annotated images.
  await reset("demo");
  {
    const page = await open({ sub: SHOP });
    await page.getByRole("heading", { name: "Comments (3)" }).waitFor();
    await page.getByRole("button", { name: "Reject (3)" }).click();
    await page.getByRole("dialog").waitFor();
    await shot(page, "05a-send-back-dialog-light.png");
    await page.getByRole("dialog").getByRole("button", { name: "Reject" }).click();
    await notice(page).getByText(/sent to the implementer thread/).waitFor({ timeout: 20_000 });
    await page.getByText(/Sent back for changes/).waitFor();
    await shot(page, "05b-sent-back-light.png");
    await page.close();

    const narrow = await open({ viewport: NARROW, sub: SHOP });
    await narrow.getByText(/Sent back for changes/).waitFor();
    await shot(narrow, "05c-sent-back-narrow.png");
    await narrow.close();

    const { sent, comments, uploads } = await (await fetch(`${base}__proof/sent`)).json();
    const message = sent.at(-1);
    if (message.images.length !== 2) throw new Error(`Expected 2 annotated images, got ${message.images.length}.`);
    const renders = uploads.slice(-2);
    for (const [index, upload] of renders.entries()) {
      // Image 2 is the screencast frame at 0:02 of the fixture flow.
      await assertNotBlank(upload.base64, `annotated image ${index + 1}`, { greenButton: index === 1 });
      writeFileSync(`${outDir}05d-sent-image-${index + 1}.jpg`, Buffer.from(upload.base64, "base64"));
    }
    writeFileSync(`${outDir}05-sent-back-message.md`, [
      "# Message to the implementer thread (send back)",
      "",
      `Recipient: \`${message.threadId}\` · attached images: ${message.images.length}`,
      "",
      "```text",
      message.text,
      "```",
      "",
      ...renders.map((_, index) => `![Marked image ${index + 1}](05d-sent-image-${index + 1}.jpg)`),
      "",
      "# Maintained PR comment afterwards",
      "",
      "```markdown",
      comments.find((comment) => comment.includes("acme/shop")) ?? comments.at(-1),
      "```",
      "",
    ].join("\n"));
  }

  // 06 Approve: dialog with the remark notice, then the approved state.
  await reset("demo");
  {
    const page = await open({ sub: SHOP });
    await page.getByRole("heading", { name: "Comments (3)" }).waitFor();
    await page.getByRole("button", { name: "Approve" }).click();
    await page.getByRole("dialog").getByLabel("Note (optional)").fill("Looks good; the remarks can go into the next PR.");
    await shot(page, "06a-approve-dialog-light.png");
    await page.getByRole("dialog").getByRole("button", { name: "Approve" }).click();
    await notice(page).getByText(/Approved for head/).waitFor();
    await shot(page, "06b-approved-light.png");
    await page.close();
    for (const theme of ["dark"]) {
      const dark = await open({ theme, sub: SHOP });
      await dark.getByText(/Approved on/).waitFor();
      await shot(dark, `06b-approved-${theme}.png`);
      await dark.close();
    }
    const narrow = await open({ viewport: NARROW, sub: SHOP });
    await narrow.getByText(/Approved on/).waitFor();
    await shot(narrow, "06c-approved-narrow.png");
    await narrow.close();
  }

  // 07 Stale: the superseded head (read-only, history) and a PR whose head moved without new proof.
  await reset("demo");
  {
    const { detail } = await rpc("proofs_detail", { repository: "acme/shop", number: 231 });
    const oldSet = detail.history[1];
    for (const [viewport, suffix] of [[DESKTOP, "light"], [NARROW, "narrow"]]) {
      const page = await open({ viewport, sub: `${SHOP}/${oldSet.id}` });
      await page.getByText("This proof is outdated and read-only.").waitFor();
      await shot(page, `07a-stale-superseded-${suffix}.png`);
      await page.close();
    }
    const moved = await open({ sub: "acme/charts/812" });
    await moved.getByText(/The PR is now at ddddddd/).waitFor();
    await shot(moved, "07b-stale-head-moved-light.png");
    await moved.close();
  }

  // 08 Loading, load failure with retry, action failures.
  await reset("demo");
  {
    let page = await open({ query: "rpc=hang", viewport: { width: 1440, height: 620 } });
    await page.locator("[role=status][aria-busy=true]").waitFor();
    await shot(page, "08a-loading-list-light.png");
    await page.close();
    page = await open({ sub: SHOP, query: "rpc=hang", viewport: { width: 1440, height: 620 } });
    await page.locator("[role=status][aria-busy=true]").waitFor();
    await shot(page, "08b-loading-detail-light.png");
    await page.close();
    for (const theme of ["light", "dark"]) {
      page = await open({ theme, query: "rpc=fail-once", viewport: { width: 1440, height: 560 } });
      await page.getByText("The proofs could not be loaded.").waitFor();
      await shot(page, `08c-error-list-${theme}.png`);
      await page.close();
    }
    for (const [viewport, suffix] of [[{ width: 1440, height: 560 }, "light"], [NARROW, "narrow"]]) {
      page = await open({ viewport, sub: SHOP, query: "rpc=fail-once" });
      await page.getByText("The proof could not be loaded.").waitFor();
      await shot(page, `08d-error-detail-${suffix}.png`);
      if (suffix === "light") {
        await page.getByRole("button", { name: "Try again" }).click();
        await page.getByRole("heading", { name: "Comments (3)" }).waitFor();
        await shot(page, "08e-error-recovered-light.png");
      }
      await page.close();
    }
    // A send back that fails before anything is stored: the error stays in the dialog, nothing changed.
    page = await open({ sub: SHOP, query: "fail=proofs_send_back" });
    await page.getByRole("button", { name: "Reject (3)" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Reject" }).click();
    await page.getByRole("dialog").getByRole("alert").waitFor();
    await shot(page, "08f-send-back-failed-dialog-light.png");
    await page.close();
    // An approval refused because the proof changed after the panel loaded. Without realtime the panel cannot pick up
    // the new comment before the click, which would make this step flaky.
    page = await open({ sub: SHOP, query: "realtime=off" });
    await page.getByRole("heading", { name: "Comments (3)" }).waitFor();
    await page.getByRole("button", { name: "Approve" }).click();
    const { detail } = await rpc("proofs_detail", { repository: "acme/shop", number: 231 });
    await rpc("proofs_annotation_add", { setId: detail.set.id, assetId: null, anchor: { kind: "none" }, body: "Please also show the error state." });
    await page.getByRole("dialog").getByRole("button", { name: "Approve" }).click();
    await notice(page).getByText(/Not approved/).waitFor();
    await page.getByText("Please also show the error state.").waitFor();
    await shot(page, "08g-approve-refused-changed-light.png");
    await page.close();
  }

  // 09 A decision whose message or GitHub status could not be delivered, then the retry.
  await reset("demo");
  {
    await post("fail", { what: "sends", message: "Thread is archived." });
    const page = await open({ sub: SHOP });
    await page.getByRole("button", { name: "Reject (3)" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Reject" }).click();
    await page.getByRole("alert", { name: "Pending delivery" }).waitFor({ timeout: 20_000 });
    await shot(page, "09a-delivery-failed-light.png");
    const narrow = await open({ viewport: NARROW, sub: SHOP });
    await narrow.getByRole("alert", { name: "Pending delivery" }).waitFor();
    await scrollTo(narrow, narrow.getByRole("alert", { name: "Pending delivery" }));
    await shot(narrow, "09b-delivery-failed-narrow.png");
    await narrow.close();
    await post("fail", { what: "sends", message: null });
    await page.getByRole("button", { name: "Deliver again now" }).click();
    await notice(page).getByText("Pending items delivered.").waitFor();
    await shot(page, "09c-delivery-retried-light.png");
    await page.close();
  }
  await reset("demo", { postCommitStatus: true });
  {
    await post("fail", { what: "status", message: "GitHub responds with 502." });
    const page = await open({ sub: SHOP });
    await page.getByRole("button", { name: "Approve" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Approve" }).click();
    await page.getByRole("alert", { name: "Pending delivery" }).waitFor();
    await shot(page, "09d-status-failed-light.png");
    await page.close();
  }

  // 10 Marking a region with the keyboard only.
  await reset("review");
  for (const [viewport, suffix] of [[DESKTOP, "light"], [NARROW, "narrow"]]) {
    const page = await open({ viewport, sub: SHOP });
    await page.locator("main img").first().waitFor();
    await page.getByRole("button", { name: "Mark area" }).focus();
    await page.keyboard.press("Enter");
    for (const [label, value] of [["Width", "30"], ["Height", "10"], ["Left", "60"], ["Top", "73"]]) {
      await page.getByLabel(label, { exact: true }).focus();
      await page.keyboard.press("Control+A");
      await page.keyboard.type(value);
    }
    await page.getByLabel(/New comment/).focus();
    await page.keyboard.type("Button label is cut off.");
    await page.getByLabel("Left", { exact: true }).focus();
    if (suffix === "narrow") await scrollTo(page, page.getByRole("group", { name: "Area in % of the image" }));
    await shot(page, `10-keyboard-region-${suffix}.png`);
    await page.close();
  }

  // 11 Deleting media by hand: confirmation, then the retained thumbnails.
  await reset("demo");
  {
    const sub = "acme/plugins/14";
    const page = await open({ sub });
    await page.getByText(/Approved on/).waitFor();
    await waitForThumbnails("acme/plugins", 14);
    const narrow = await open({ viewport: NARROW, sub });
    await narrow.getByRole("button", { name: "Delete media now" }).click();
    await narrow.getByRole("dialog").waitFor();
    await shot(narrow, "11c-delete-media-dialog-narrow.png");
    await narrow.close();
    await page.getByRole("button", { name: "Delete media now" }).click();
    await page.getByRole("dialog").waitFor();
    await shot(page, "11a-delete-media-dialog-light.png");
    await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
    await notice(page).getByText(/Media deleted/).waitFor();
    await page.getByText("The media has expired. Comments and preview are kept.").waitFor();
    await shot(page, "11b-media-deleted-light.png");
    await page.close();
  }

  // 12 Media expired by retention; thumbnails, comments and history remain.
  await reset("demo");
  {
    const { detail } = await rpc("proofs_detail", { repository: "acme/shop", number: 231 });
    const oldSet = detail.history[1];
    let page = await open();
    await card(page, "Chart legend with scenario colours").waitFor();
    await waitForThumbnails("acme/charts", 812);
    await page.close();
    page = await open({ sub: `${SHOP}/${oldSet.id}` });
    await page.getByText("This proof is outdated and read-only.").waitFor();
    await waitForThumbnails("acme/shop", 231, oldSet.id);
    await page.close();
    await post("expire");
    for (const [viewport, theme, suffix] of [[DESKTOP, "light", "light"], [DESKTOP, "dark", "dark"], [NARROW, "light", "narrow"]]) {
      page = await open({ viewport, theme, sub: `${SHOP}/${oldSet.id}` });
      await page.getByText("The media has expired. Comments and preview are kept.").waitFor();
      await shot(page, `12a-expired-${suffix}.png`);
      await page.close();
    }
    page = await open();
    await card(page, "Chart legend with scenario colours").waitFor();
    await shot(page, "12b-expired-list-light.png");
    await page.close();
  }

  // 13 Approved without an implementer thread: remarks are decided but reached nobody.
  await reset("no-thread");
  for (const [viewport, suffix] of [[DESKTOP, "light"], [NARROW, "narrow"]]) {
    const page = await open({ viewport, sub: "acme/plugins/15" });
    await page.getByText("decided · no implementer thread, not delivered").waitFor();
    if (suffix === "narrow") await scrollTo(page, page.getByText("decided · no implementer thread, not delivered"));
    await shot(page, `13-approved-no-thread-${suffix}.png`);
    await page.close();
  }

  // 14 Inline viewer: fixed stage, wheel zoom after a click, 1:1, keyboard, marking while zoomed, read-only, video, load error.
  {
    const VIEWER = { width: 1024, height: 720 };
    const stage = (page) => page.getByRole("group", { name: /^Image area/ });
    const viewerReady = (page) => page.waitForFunction(() => {
      const images = [...document.querySelectorAll("[role=group][aria-label] img")];
      return images.length > 0 && images.every((image) => image.complete && image.naturalWidth > 0);
    });
    const zoomLevel = (page, text) => page.getByRole("status", { name: "Zoom level" }).getByText(text).waitFor();
    /** A screenshot without `settle`, which would move the mouse in the middle of a drag. */
    const capture = async (page, file) => {
      await page.screenshot({ path: `${outDir}${file}`, animations: "disabled" });
      shots.push(file);
      contrast.push({ file, ...(await measureContrast(page)) });
    };
    /** A click into the image focuses the stage (start mode "Pan"), after which the plain wheel zooms there. */
    const wheelAt = async (page, x, y, steps) => {
      const box = await stage(page).locator("img").boundingBox();
      await page.mouse.click(box.x + box.width * x, box.y + box.height * y);
      for (let step = 0; step < steps; step += 1) await page.mouse.wheel(0, -200);
    };
    const openReview = async (options) => {
      const page = await open({ viewport: VIEWER, sub: SHOP, ...options });
      await page.getByRole("heading", { name: "Comments (3)" }).waitFor();
      await viewerReady(page);
      return page;
    };

    await reset("demo");
    let page = await openReview();
    await shot(page, "14a-viewer-fit-light.png");
    // Portrait file in the same stage: nothing below or around it moves.
    await page.getByRole("button", { name: "Next file" }).click();
    await page.getByRole("button", { name: "Next file" }).click();
    await viewerReady(page);
    await shot(page, "14b-viewer-portrait-same-box-light.png");
    await page.getByRole("button", { name: "Previous file" }).click();
    await page.getByRole("button", { name: "Previous file" }).click();
    await viewerReady(page);
    // Zoom with the wheel onto comment 1, the cut-off button.
    await wheelAt(page, 0.75, 0.79, 3);
    await page.waitForFunction(() => parseInt(document.querySelector("output[aria-label]")?.textContent ?? "0", 10) >= 60);
    await shot(page, "14c-viewer-zoomed-annotations-light.png");
    await page.keyboard.press("1");
    await zoomLevel(page, "100%");
    await shot(page, "14d-viewer-1to1-light.png");
    // Marking while zoomed in: the box follows the pointer, then the comment form takes over.
    await page.keyboard.press("+");
    await page.getByRole("button", { name: "Mark", exact: true }).click();
    const stageBox = await stage(page).boundingBox();
    const centre = { x: stageBox.x + stageBox.width / 2, y: stageBox.y + stageBox.height / 2 };
    await page.mouse.move(centre.x - 160, centre.y - 60);
    await page.mouse.down();
    await page.mouse.move(centre.x + 120, centre.y + 40, { steps: 6 });
    await capture(page, "14e-viewer-marking-light.png");
    await page.mouse.up();
    await page.getByLabel(/New comment/).fill("Summary: right-align the amounts.");
    await shot(page, "14f-viewer-marked-draft-light.png");
    await page.close();

    // Keyboard only: Tab to the stage, zoom and pan with keys, then Tab on to the toolbar's next control.
    page = await openReview();
    await stage(page).focus();
    for (const key of ["+", "+", "+", "Shift+ArrowRight", "Shift+ArrowRight", "ArrowDown"]) await page.keyboard.press(key);
    await shot(page, "14g-viewer-keyboard-stage-focus-light.png");
    await page.getByRole("button", { name: "Whole image", exact: true }).focus();
    await shot(page, "14h-viewer-keyboard-toolbar-focus-light.png");
    await page.close();

    for (const [theme, viewport, suffix] of [["dark", VIEWER, "dark"], ["light", NARROW, "narrow"]]) {
      page = await open({ theme, viewport, sub: SHOP });
      await page.getByRole("heading", { name: "Comments (3)" }).waitFor();
      await viewerReady(page);
      await wheelAt(page, 0.75, 0.79, 3);
      await shot(page, `14k-viewer-zoomed-${suffix}.png`);
      await page.close();
    }

    // A read-only proof zooms the same way; here the chart legend.
    page = await open({ viewport: VIEWER, sub: "acme/charts/812" });
    await page.getByText(/The PR is now at ddddddd/).waitFor();
    await viewerReady(page);
    await wheelAt(page, 0.9, 0.2, 4);
    for (let step = 0; step < 3; step += 1) await page.keyboard.press("Shift+ArrowRight");
    await shot(page, "14l-viewer-readonly-chart-zoomed-light.png");
    await page.close();

    // The screencast in the stage: played, not zoomed.
    page = await openReview();
    await page.getByRole("button", { name: /Show comment 3/ }).click();
    await stage(page).locator("video").evaluate((video) => new Promise((resolve) => {
      video.addEventListener("seeked", () => resolve(undefined), { once: true });
      video.currentTime = 2;
    }));
    await shot(page, "14m-viewer-video-light.png");
    await page.close();

    // Touch pinch near the left edge: zoom and midpoint move are clamped together.
    page = await browser.newPage({ viewport: VIEWER, colorScheme: "light", hasTouch: true });
    await page.goto(`${base}?theme=light&lang=en&sub=${encodeURIComponent(SHOP)}`);
    await page.getByRole("heading", { name: "Comments (3)" }).waitFor();
    await viewerReady(page);
    await stage(page).focus();
    await page.keyboard.press("1");
    for (let step = 0; step < 10; step += 1) await page.keyboard.press("Shift+ArrowLeft");
    await page.keyboard.press("Shift+ArrowRight");
    await zoomLevel(page, "100%");
    await page.waitForTimeout(250);
    {
      // Both contacts start and stay inside the stage, whatever its width: 0.8 × stage apart, then 0.64 × (ratio 0.8),
      // the midpoint moving left towards the edge. A pinch that misses the stage leaves 100 % and fails below.
      const box = await stage(page).boundingBox();
      const at = (fraction) => box.x + box.width * fraction;
      const y = box.y + box.height / 2;
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ id: 1, x: at(0.1), y }, { id: 2, x: at(0.9), y }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ id: 1, x: at(0.06), y }, { id: 2, x: at(0.7), y }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await zoomLevel(page, "80%");
      // Clamped once, together: the zoomed image is wider than the stage and leaves no gap at either edge.
      const image = await stage(page).locator("img").boundingBox();
      if (image.x > box.x + 0.5 || image.x + image.width < box.x + box.width - 0.5) {
        throw new Error(`Pinch left a gap: image ${JSON.stringify(image)}, stage ${JSON.stringify(box)}`);
      }
    }
    await shot(page, "14o-viewer-pinch-edge-light.png");
    await page.close();

    // Arrow keys on the focused video seek natively instead of switching files.
    page = await openReview();
    await page.getByRole("button", { name: /Show comment 3/ }).click();
    {
      const video = stage(page).locator("video");
      await video.evaluate((element) => new Promise((resolve) => {
        if (element.readyState >= 1) resolve(undefined); else element.addEventListener("loadedmetadata", () => resolve(undefined), { once: true });
      }));
      await video.focus();
      await page.keyboard.press("ArrowRight");
      await page.getByText("4 / 4").waitFor();
      await video.evaluate((element) => new Promise((resolve) => (element.seeking ? element.addEventListener("seeked", () => resolve(undefined), { once: true }) : resolve(undefined))));
    }
    await shot(page, "14p-viewer-video-arrow-key-light.png");
    await page.close();

    // Media that fails to load: the stage says so instead of staying empty.
    page = await browser.newPage({ viewport: VIEWER, colorScheme: "light" });
    await page.route((url) => url.pathname.endsWith("/http/media"), (route) => route.abort());
    await page.goto(`${base}?theme=light&lang=en&sub=${encodeURIComponent(SHOP)}`);
    await page.getByRole("heading", { name: "Comments (3)" }).waitFor();
    await stage(page).getByRole("alert").waitFor();
    await shot(page, "14n-viewer-load-error-light.png");
    await page.close();

    // 15 Panel language: German from the setting, same layout.
    page = await open({ viewport: VIEWER, sub: SHOP, query: "lang=de" });
    await page.getByRole("heading", { name: "Kommentare (3)" }).waitFor();
    await viewerReady(page);
    await shot(page, "15a-viewer-german-light.png");
    await page.close();
  }

  const failing = contrast.filter((entry) => entry.failures.length > 0);
  writeFileSync(`${outDir}contrast.md`, [
    "# Text contrast (WCAG 2.2, 1.4.3)",
    "",
    "Measured in the harness: every visible text element in the panel and in open dialogs against its composited background.",
    "Disabled controls are exempt under WCAG. Text inside screenshots/media is not measured.",
    "",
    "| Screenshot | Checked | Minimum | Below threshold |",
    "| --- | ---: | ---: | --- |",
    ...contrast.map((entry) => `| ${entry.file} | ${entry.checked} | ${entry.minimum} | ${entry.failures.map((failure) => `${failure.text} (${failure.ratio})`).join("; ") || "–"} |`),
    "",
  ].join("\n"));
  console.log(`${shots.length} screenshots; contrast failures in ${failing.length}.`);
  console.log(`Output: ${outDir}`);
  for (const entry of failing) console.log(entry.file, JSON.stringify(entry.failures));
} finally {
  await browser.close();
  await post("dispose");
  await server.close();
  rmSync(mediaDir, { recursive: true, force: true });
}
