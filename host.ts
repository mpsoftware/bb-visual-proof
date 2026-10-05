// Runs on a connected BB machine and talks to GitHub through the machine's authenticated `gh`.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "./src/host-contract.js";

const execFileAsync = promisify(execFile);

async function gh(args: string[], signal: AbortSignal): Promise<string> {
  try {
    const { stdout } = await execFileAsync("gh", args, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024, timeout: 25_000, signal });
    return stdout;
  } catch (cause) {
    const error = cause as Error & { stderr?: string };
    throw new Error(`gh failed: ${(error.stderr?.trim() || error.message).slice(0, 400)}`);
  }
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    async prHead({ repository, number }, context) {
      const view = JSON.parse(await gh(["pr", "view", String(number), "--repo", repository, "--json", "headRefOid,title,url,state"], context.signal)) as
        { headRefOid: string; title: string; url: string; state: "OPEN" | "CLOSED" | "MERGED" };
      return { headSha: view.headRefOid.toLowerCase(), title: view.title, url: view.url, state: view.state };
    },
    async upsertComment({ repository, number, marker, body }, context) {
      // One page per line of output; the marker identifies the comment this plugin owns.
      const found = (await gh([
        "api", "--paginate", `repos/${repository}/issues/${number}/comments`,
        "--jq", `.[] | select(.body | contains(${JSON.stringify(marker)})) | .id`,
      ], context.signal)).split("\n").map((line) => line.trim()).filter(Boolean);
      if (found.length > 0) {
        const updated = JSON.parse(await gh(["api", "--method", "PATCH", `repos/${repository}/issues/comments/${found[0]}`, "-f", `body=${body}`], context.signal)) as { html_url: string };
        return { url: updated.html_url, created: false };
      }
      const created = JSON.parse(await gh(["api", "--method", "POST", `repos/${repository}/issues/${number}/comments`, "-f", `body=${body}`], context.signal)) as { html_url: string };
      return { url: created.html_url, created: true };
    },
    async postStatus({ repository, sha, context: statusContext, state, description, targetUrl }, context) {
      await gh([
        "api", "--method", "POST", `repos/${repository}/statuses/${sha}`,
        "-f", `state=${state}`, "-f", `context=${statusContext}`, "-f", `description=${description}`,
        ...(targetUrl ? ["-f", `target_url=${targetUrl}`] : []),
      ], context.signal);
      return { ok: true as const };
    },
  },
});
