import { z } from "zod";

/** Commit status context posted on the proof head when the option is on. Stable contract for merge guards that read it. */
export const STATUS_CONTEXT = "visual-proof";
/** Marker that identifies the single PR comment this plugin maintains. */
export const COMMENT_MARKER = "<!-- bb-visual-proof -->";
export const PANEL_PATH = "proofs";

export const LIMITS = {
  imageBytes: 10 * 1024 * 1024,
  videoBytes: 25 * 1024 * 1024,
  setFiles: 60,
  setBytes: 200 * 1024 * 1024,
  thumbnailBytes: 96 * 1024,
  renderBytes: 2 * 1024 * 1024,
  rendersPerSendBack: 10,
  captionChars: 200,
  commentChars: 4000,
} as const;

export const repositorySchema = z.string().trim().toLowerCase().regex(/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/, "Expected owner/name.");
export const prNumberSchema = z.number().int().positive();
export const shaSchema = z.string().trim().toLowerCase().regex(/^[0-9a-f]{40}$/, "Expected a full 40-character commit SHA.");
export const idSchema = z.string().trim().min(1).max(80);

export const setStatusSchema = z.enum(["pending", "changes_requested", "approved"]);
export const staleReasonSchema = z.enum(["superseded", "head_moved"]);
export const mediaKindSchema = z.enum(["image", "video"]);
export type SetStatus = z.infer<typeof setStatusSchema>;
export type MediaKind = z.infer<typeof mediaKindSchema>;

export const anchorSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("rect"),
    x: z.number().min(0).max(1), y: z.number().min(0).max(1),
    w: z.number().min(0).max(1), h: z.number().min(0).max(1),
  }).strict().refine((rect) => rect.x + rect.w <= 1.0001 && rect.y + rect.h <= 1.0001, "Box must stay inside the image."),
  z.object({ kind: z.literal("time"), ms: z.number().int().min(0).max(24 * 3600 * 1000) }).strict(),
  z.object({ kind: z.literal("none") }).strict(),
]);
export type Anchor = z.infer<typeof anchorSchema>;

export const annotationSchema = z.object({
  id: z.string(),
  setId: z.string(),
  assetId: z.string().nullable(),
  number: z.number().int().positive(),
  anchor: anchorSchema,
  body: z.string(),
  round: z.number().int().positive(),
  /** Part of a stored decision and immutable. */
  locked: z.boolean(),
  /** The decision's message reached the implementer thread. */
  sent: z.boolean(),
  /** Delivery of the decision that locked it: `no_recipient` when no implementer thread was known; `null` while open. */
  delivery: z.enum(["pending", "sent", "failed", "no_recipient"]).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict();
export type Annotation = z.infer<typeof annotationSchema>;

export const assetSchema = z.object({
  id: z.string(),
  setId: z.string(),
  sha256: z.string(),
  kind: mediaKindSchema,
  mime: z.string(),
  bytes: z.number().int().nonnegative(),
  caption: z.string(),
  filename: z.string(),
  position: z.number().int().nonnegative(),
  hasThumbnail: z.boolean(),
  expired: z.boolean(),
  createdAt: z.string(),
}).strict();
export type Asset = z.infer<typeof assetSchema>;

export const deliverySchema = z.object({
  id: z.string(),
  setId: z.string(),
  kind: z.enum(["send_back", "approval"]),
  revision: z.number().int().positive(),
  status: z.enum(["pending", "sent", "failed"]),
  error: z.string().nullable(),
  createdAt: z.string(),
  sentAt: z.string().nullable(),
}).strict();
export type Delivery = z.infer<typeof deliverySchema>;

export const eventSchema = z.object({
  id: z.number().int(),
  kind: z.enum(["uploaded", "sent_back", "approved", "reopened", "stale", "media_expired", "media_deleted"]),
  detail: z.string(),
  createdAt: z.string(),
}).strict();
export type ProofEvent = z.infer<typeof eventSchema>;

export const proofSetSchema = z.object({
  id: z.string(),
  repository: z.string(),
  number: z.number().int().positive(),
  headSha: z.string(),
  prTitle: z.string(),
  prUrl: z.string(),
  threadId: z.string().nullable(),
  hostId: z.string().nullable(),
  status: setStatusSchema,
  stale: z.boolean(),
  staleReason: staleReasonSchema.nullable(),
  staleAt: z.string().nullable(),
  currentHeadSha: z.string().nullable(),
  round: z.number().int().positive(),
  /** Increases with every change a decision covers; decisions name the revision they were made on. */
  revision: z.number().int().positive(),
  /** Commit status this set should show on GitHub, the last posted one, and the last posting error. */
  githubStatus: z.object({
    wanted: z.enum(["success", "failure", "pending"]), posted: z.string().nullable(), error: z.string().nullable(),
  }).strict().nullable(),
  decidedAt: z.string().nullable(),
  decisionNote: z.string(),
  mediaExpiresAt: z.string().nullable(),
  imageCount: z.number().int().nonnegative(),
  videoCount: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict();
export type ProofSet = z.infer<typeof proofSetSchema>;

export const setSummarySchema = proofSetSchema.extend({
  previews: z.array(assetSchema),
  openAnnotationCount: z.number().int().nonnegative(),
}).strict();
export type SetSummary = z.infer<typeof setSummarySchema>;

export const setDetailSchema = z.object({
  set: proofSetSchema,
  assets: z.array(assetSchema),
  annotations: z.array(annotationSchema),
  events: z.array(eventSchema),
  deliveries: z.array(deliverySchema),
  history: z.array(proofSetSchema),
}).strict();
export type SetDetail = z.infer<typeof setDetailSchema>;

export const usageSchema = z.object({ bytes: z.number(), quotaBytes: z.number() }).strict();

export const annotationInputSchema = z.object({
  setId: idSchema,
  assetId: idSchema.nullable(),
  anchor: anchorSchema,
  body: z.string().trim().min(1, "Write a comment.").max(LIMITS.commentChars),
}).strict();
export type AnnotationInput = z.infer<typeof annotationInputSchema>;

/** Outcome of the best-effort GitHub side effects after a decision; the decision itself is already stored. */
export const sideEffectsSchema = z.object({ warnings: z.array(z.string()) }).strict();
