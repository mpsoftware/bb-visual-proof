// Screenshot harness: serves the real panel against the real Visual proof server on the SDK fake host.
// Run through `node tests/proof/shoot.mjs`; it writes only to temp dirs (or to PROOF_OUT_DIR when set).
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { defineConfig, type ViteDevServer } from "vite";

type Backend = {
  rpc(method: string, input: unknown): Promise<unknown>;
  fetch(path: string, init?: RequestInit): Promise<Response>;
  dispose(): Promise<void>;
  signals(): Array<{ channel: string; payload: unknown }>;
  sent: Array<{ threadId: string; text: string; images: string[] }>;
  comments: Map<string, string>;
  uploads: Array<{ filename: string; data: Buffer }>;
  failSends(message: string | null): void;
  failStatus(message: string | null): void;
  db(): { prepare(sql: string): { run(...args: unknown[]): unknown } };
  host: { harness: { behavior: { runSchedule(name: string): Promise<void> } } };
};

async function readBody(request: IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

async function pipe(source: Response, response: ServerResponse) {
  response.statusCode = source.status;
  source.headers.forEach((value, key) => response.setHeader(key, value));
  response.end(Buffer.from(await source.arrayBuffer()));
}

function proofBackend() {
  let backend: Backend | undefined;
  return {
    name: "visual-proof-backend",
    configureServer(server: ViteDevServer) {
      const load = (path: string) => server.ssrLoadModule(fileURLToPath(new URL(path, import.meta.url)));
      server.middlewares.use(async (request, response, next) => {
        const url = new URL(request.url ?? "/", "http://proof");
        const send = (status: number, body: unknown) => {
          response.statusCode = status;
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify(body));
        };
        try {
          if (url.pathname.startsWith("/api/v1/plugins/visual-proof/http/")) {
            if (!backend) return send(409, { error: "reset first" });
            const range = request.headers.range;
            const path = url.pathname.slice("/api/v1/plugins/visual-proof/http".length) + url.search;
            return await pipe(await backend.fetch(path, range ? { headers: { range } } : undefined), response);
          }
          if (!url.pathname.startsWith("/__proof/")) return next();
          if (url.pathname === "/__proof/reset") {
            const { scenario, mediaDir, settings } = await readBody(request) as { scenario: string; mediaDir: string; settings?: Record<string, boolean> };
            await backend?.dispose();
            const { createBackend } = await load("../backend.ts");
            const { seed } = await load("./seed.ts");
            backend = await createBackend({ settings }) as Backend;
            await seed(backend, scenario, mediaDir);
            return send(200, { ok: true });
          }
          if (url.pathname === "/__proof/dispose") {
            // Removes the last backend's temp data directory when the run ends.
            await backend?.dispose();
            backend = undefined;
            return send(200, { ok: true });
          }
          if (!backend) return send(409, { ok: false, error: "Call /__proof/reset first." });
          if (url.pathname === "/__proof/fail") {
            const { what, message } = await readBody(request) as { what: "sends" | "status"; message: string | null };
            if (what === "sends") backend.failSends(message);
            else backend.failStatus(message);
            return send(200, { ok: true });
          }
          if (url.pathname === "/__proof/expire") {
            // Moves every decision and outdated mark 200 days back, then runs the real retention schedule.
            const past = new Date(Date.now() - 200 * 86_400_000).toISOString();
            backend.db().prepare("UPDATE proof_sets SET decided_at = ? WHERE status = 'approved'").run(past);
            backend.db().prepare("UPDATE proof_sets SET stale_at = ? WHERE stale_at IS NOT NULL").run(past);
            await backend.host.harness.behavior.runSchedule("retention");
            return send(200, { ok: true });
          }
          if (url.pathname === "/__proof/signals") {
            const signals = backend.signals();
            const since = Number(url.searchParams.get("since"));
            return send(200, { next: signals.length, signals: since >= 0 ? signals.slice(since) : [] });
          }
          if (url.pathname === "/__proof/sent") {
            return send(200, { sent: backend.sent, comments: [...backend.comments.values()], uploads: backend.uploads.map((upload) => ({ filename: upload.filename, base64: upload.data.toString("base64") })) });
          }
          const method = url.pathname.slice("/__proof/rpc/".length);
          return send(200, { ok: true, result: await backend.rpc(method, await readBody(request)) });
        } catch (error) {
          return send(200, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      });
    },
  };
}

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  logLevel: "warn",
  plugins: [proofBackend()],
  resolve: {
    alias: { "@get-bb/plugin-sdk/app": fileURLToPath(new URL("./fake-sdk-app.ts", import.meta.url)) },
  },
  server: { host: "127.0.0.1", fs: { allow: [fileURLToPath(new URL("../..", import.meta.url))] } },
});
