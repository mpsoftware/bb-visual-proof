// Renders the demo media the proof uploads: mock product screens as PNG and one recorded WebM flow.
// These stand in for an implementer's Playwright proof; they are generated, never committed.
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const css = (dark) => `
  * { box-sizing: border-box; margin: 0; }
  body { font: 15px/1.4 system-ui, sans-serif; background: ${dark ? "#14161a" : "#f6f7f9"}; color: ${dark ? "#e7e9ee" : "#1c2230"}; }
  header { height: 64px; display: flex; align-items: center; padding: 0 40px; background: ${dark ? "#1d2027" : "#fff"}; border-bottom: 1px solid ${dark ? "#2b2f38" : "#e3e6eb"}; font-weight: 700; font-size: 18px; }
  header span { color: #7c3aed; margin-right: 8px; }
  main { position: relative; height: calc(100vh - 64px); padding: 32px 40px; }
  h1 { font-size: 24px; margin-bottom: 20px; }
  .card { background: ${dark ? "#1d2027" : "#fff"}; border: 1px solid ${dark ? "#2b2f38" : "#e3e6eb"}; border-radius: 12px; padding: 20px; }
  label { display: block; font-size: 13px; color: ${dark ? "#a3a9b6" : "#5b6474"}; margin-bottom: 4px; }
  .field { height: 40px; border: 1px solid ${dark ? "#3a3f4a" : "#cfd4dc"}; border-radius: 8px; padding: 9px 12px; background: ${dark ? "#14161a" : "#fff"}; }
  .button { position: absolute; left: 62%; top: 75%; width: 26%; height: 7%; border-radius: 10px; background: #7c3aed; color: #fff;
    font-weight: 600; display: flex; align-items: center; justify-content: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding: 0 12px; font-size: 20px; }
  .button span { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px dashed ${dark ? "#2b2f38" : "#e3e6eb"}; }
`;

function checkout({ dark = false, summary = true } = {}) {
  const fields = [["Full name", "Jane Doe", 0], ["Email", "jane@example.com", 16], ["Street address", "1 Example Street", 24], ["City", "Springfield", 16]];
  const form = fields.map(([label, value, gap]) => `<div style="margin-top:${gap}px"><label>${label}</label><div class="field">${value}</div></div>`).join("");
  return `<!doctype html><html><head><style>${css(dark)}</style></head><body>
    <header><span>●</span>Acme Shop</header>
    <main>
      <h1>Checkout</h1>
      <div class="card" style="position:absolute;left:40px;top:92px;width:52%">${form}</div>
      ${summary ? `<div class="card" style="position:absolute;left:58%;top:92px;width:36%">
        <strong>Summary</strong>
        <div class="row" style="margin-top:12px"><span>Seaside holiday, 7 nights</span><span>$1,249.00</span></div>
        <div class="row"><span>Travel insurance</span><span>$59.00</span></div>
        <div class="row" style="border:0;font-weight:700"><span>Total</span><span>$1,308.00</span></div>
      </div>` : ""}
      <div class="button" id="submit"><span>Place order and continue to payment</span></div>
    </main></body></html>`;
}

function mobile() {
  return `<!doctype html><html><head><style>${css(false)} main { padding: 20px; } .button { position: static; width: 100%; height: 48px; margin-top: 20px; }</style></head><body>
    <header style="padding:0 20px"><span>●</span>Acme Shop</header>
    <main><h1>Checkout</h1>
      <div class="card"><label>Full name</label><div class="field">Jane Doe</div>
      <div style="margin-top:16px"><label>Email</label><div class="field">jane@example.com</div></div></div>
      <div class="card" style="margin-top:16px"><strong>Summary</strong>
        <div class="row" style="margin-top:8px"><span>Seaside holiday</span><span>$1,249.00</span></div>
        <div class="row" style="border:0;font-weight:700"><span>Total</span><span>$1,308.00</span></div></div>
      <div class="button">Place order</div>
    </main></body></html>`;
}

function dashboard() {
  const tile = (label, value, color) => `<div class="card" style="flex:1"><label>${label}</label><div style="font-size:30px;font-weight:700;color:${color}">${value}</div></div>`;
  return `<!doctype html><html><head><style>${css(false)}</style></head><body>
    <header><span style="color:#0ea5e9">●</span>Acme Billing</header>
    <main><h1>Overview</h1>
      <div style="display:flex;gap:16px">${tile("Open invoices", "42", "#0ea5e9")}${tile("Paid (30 days)", "$18,420", "#16a34a")}${tile("Rate", "87%", "#7c3aed")}</div>
      <div class="card" style="margin-top:16px;height:320px"><label>Trend</label>
        <svg viewBox="0 0 800 240" width="100%" height="260"><polyline fill="none" stroke="#0ea5e9" stroke-width="4" points="0,200 100,170 200,180 300,120 400,140 500,90 600,100 700,60 800,70"/></svg></div>
    </main></body></html>`;
}

function chart() {
  return `<!doctype html><html><head><style>${css(true)}</style></head><body>
    <header><span style="color:#f59e0b">●</span>Acme Charts</header>
    <main><h1>Sample series · scenarios</h1>
      <div class="card" style="height:520px;position:relative">
        <svg viewBox="0 0 1000 440" width="100%" height="440">
          <polyline fill="none" stroke="#22c55e" stroke-width="3" points="0,300 120,260 240,280 360,200 480,230 600,150 720,170 840,110 1000,130"/>
          <polyline fill="none" stroke="#ef4444" stroke-width="3" stroke-dasharray="8 6" points="600,150 720,220 840,260 1000,300"/>
        </svg>
        <div style="position:absolute;right:24px;top:20px;font-size:13px"><div>▬ <span style="color:#22c55e">Upside</span></div><div>▬ <span style="color:#ef4444">Downside</span></div></div>
      </div></main></body></html>`;
}

function settings() {
  const row = (name, state) => `<div class="row"><span>${name}</span><span style="color:${state === "enabled" ? "#16a34a" : "#5b6474"}">${state}</span></div>`;
  return `<!doctype html><html><head><style>${css(false)}</style></head><body>
    <header><span>●</span>BB settings</header>
    <main><h1>Plugins</h1><div class="card" style="max-width:720px">
      ${row("Tasks", "enabled")}${row("Pull requests", "enabled")}${row("Visual proof", "enabled")}${row("Docs", "disabled")}
    </div></main></body></html>`;
}

export async function renderDemoMedia(chromium) {
  const dir = mkdtempSync(join(tmpdir(), "visual-proof-media-"));
  const browser = await chromium.launch();
  const shoot = async (name, html, viewport) => {
    const page = await browser.newPage({ viewport });
    await page.setContent(html);
    await page.screenshot({ path: join(dir, name) });
    await page.close();
  };
  const desktop = { width: 1280, height: 800 };
  await shoot("checkout-light.png", checkout(), desktop);
  await shoot("checkout-dark.png", checkout({ dark: true }), desktop);
  await shoot("checkout-old.png", checkout({ summary: false }), desktop);
  await shoot("checkout-mobile.png", mobile(), { width: 390, height: 780 });
  await shoot("dashboard.png", dashboard(), desktop);
  await shoot("chart.png", chart(), desktop);
  await shoot("settings.png", settings(), desktop);

  // A short recorded flow: fields fill in, the button flickers on submit.
  const videoDir = join(dir, "video");
  mkdirSync(videoDir);
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } } });
  const page = await context.newPage();
  await page.setContent(checkout());
  await page.waitForTimeout(900);
  await page.evaluate(() => { document.querySelectorAll(".field")[0].style.outline = "2px solid #7c3aed"; });
  await page.waitForTimeout(700);
  await page.evaluate(() => { document.getElementById("submit").style.background = "#fff"; document.getElementById("submit").style.color = "#7c3aed"; });
  await page.waitForTimeout(250);
  await page.evaluate(() => { document.getElementById("submit").style.background = "#16a34a"; document.getElementById("submit").style.color = "#fff"; document.getElementById("submit").textContent = "Thank you!"; });
  await page.waitForTimeout(1600);
  const video = page.video();
  await context.close();
  copyFileSync(await video.path(), join(dir, "checkout-flow.webm"));
  await browser.close();
  return dir;
}
