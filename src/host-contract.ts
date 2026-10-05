import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const repository = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
const number = z.number().int().positive();
const sha = z.string().regex(/^[0-9a-f]{40}$/);

export const hostContract = defineRpcContract({
  prHead: {
    input: z.object({ repository, number }).strict(),
    output: z.object({
      headSha: sha, title: z.string(), url: z.string().url(), state: z.enum(["OPEN", "CLOSED", "MERGED"]),
    }).strict(),
  },
  upsertComment: {
    input: z.object({ repository, number, marker: z.string().min(8), body: z.string().min(1).max(60_000) }).strict(),
    output: z.object({ url: z.string(), created: z.boolean() }).strict(),
  },
  postStatus: {
    input: z.object({
      repository, sha, context: z.string().min(1).max(100),
      state: z.enum(["success", "failure", "pending"]), description: z.string().max(140), targetUrl: z.string().url().nullable(),
    }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
});
