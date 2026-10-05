import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type Database from "better-sqlite3";
import {
  LIMITS,
  anchorSchema,
  type Anchor,
  type Annotation,
  type AnnotationInput,
  type Asset,
  type Delivery,
  type MediaKind,
  type ProofEvent,
  type ProofSet,
  type SetDetail,
  type SetStatus,
  type SetSummary,
} from "./contract.js";
import { formatBytes } from "./media.js";

export const migrations = [
  `CREATE TABLE proof_sets (
    id TEXT PRIMARY KEY,
    repository TEXT NOT NULL,
    number INTEGER NOT NULL,
    head_sha TEXT NOT NULL,
    pr_title TEXT NOT NULL,
    pr_url TEXT NOT NULL,
    thread_id TEXT,
    host_id TEXT,
    status TEXT NOT NULL CHECK(status IN ('pending', 'changes_requested', 'approved')),
    stale_reason TEXT CHECK(stale_reason IN ('superseded', 'head_moved')),
    stale_at TEXT,
    current_head_sha TEXT,
    round INTEGER NOT NULL DEFAULT 1,
    decided_at TEXT,
    decision_note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(repository, number, head_sha)
  )`,
  "CREATE INDEX proof_sets_pr ON proof_sets(repository, number, created_at DESC)",
  // A media row exists exactly while its file exists under media/<sha256>.
  "CREATE TABLE media (sha256 TEXT PRIMARY KEY, mime TEXT NOT NULL, bytes INTEGER NOT NULL, created_at TEXT NOT NULL)",
  // Thumbnails are small and kept permanently for the audit trail, after the media expired.
  "CREATE TABLE thumbnails (sha256 TEXT PRIMARY KEY, mime TEXT NOT NULL, data BLOB NOT NULL, created_at TEXT NOT NULL)",
  `CREATE TABLE assets (
    id TEXT PRIMARY KEY,
    set_id TEXT NOT NULL REFERENCES proof_sets(id),
    sha256 TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('image', 'video')),
    mime TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    caption TEXT NOT NULL,
    filename TEXT NOT NULL,
    position INTEGER NOT NULL,
    expired_at TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(set_id, sha256)
  )`,
  "CREATE INDEX assets_sha ON assets(sha256)",
  `CREATE TABLE annotations (
    id TEXT PRIMARY KEY,
    set_id TEXT NOT NULL REFERENCES proof_sets(id),
    asset_id TEXT REFERENCES assets(id),
    number INTEGER NOT NULL,
    anchor_json TEXT NOT NULL,
    body TEXT NOT NULL,
    round INTEGER NOT NULL,
    sent_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(set_id, number)
  )`,
  `CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    set_id TEXT NOT NULL REFERENCES proof_sets(id),
    kind TEXT NOT NULL,
    detail TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  "CREATE INDEX events_set ON events(set_id, id)",
  // Every mutation that a decision covers bumps the revision; a decision commits only for the revision it saw.
  "ALTER TABLE proof_sets ADD COLUMN revision INTEGER NOT NULL DEFAULT 1",
  // The GitHub commit status the set should show, what was last posted, and why posting last failed.
  "ALTER TABLE proof_sets ADD COLUMN github_status_wanted TEXT CHECK(github_status_wanted IN ('success', 'failure', 'pending'))",
  "ALTER TABLE proof_sets ADD COLUMN github_status_posted TEXT",
  "ALTER TABLE proof_sets ADD COLUMN github_status_error TEXT",
  // A decision's message, frozen when the decision is stored, so retries resend exactly what was decided.
  `CREATE TABLE deliveries (
    id TEXT PRIMARY KEY,
    set_id TEXT NOT NULL REFERENCES proof_sets(id),
    kind TEXT NOT NULL CHECK(kind IN ('send_back', 'approval')),
    revision INTEGER NOT NULL,
    thread_id TEXT NOT NULL,
    text TEXT NOT NULL,
    images_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending', 'sent', 'failed')),
    error TEXT,
    created_at TEXT NOT NULL,
    sent_at TEXT
  )`,
  "CREATE INDEX deliveries_set ON deliveries(set_id, created_at)",
  "ALTER TABLE annotations ADD COLUMN delivery_id TEXT REFERENCES deliveries(id)",
  // Locked by a decision that had no implementer thread to deliver to: decided, but never sent.
  "ALTER TABLE annotations ADD COLUMN no_recipient INTEGER NOT NULL DEFAULT 0",
  // Upgrade from the first release: an approval without implementer thread locked its remarks with sent_at although
  // nothing was sent. Only send backs and approvals with a thread ever reached anyone.
  `UPDATE annotations SET no_recipient = 1 WHERE sent_at IS NOT NULL AND delivery_id IS NULL
    AND set_id IN (SELECT id FROM proof_sets WHERE thread_id IS NULL)`,
];

type SetRow = {
  id: string; repository: string; number: number; head_sha: string; pr_title: string; pr_url: string;
  thread_id: string | null; host_id: string | null; status: SetStatus; stale_reason: "superseded" | "head_moved" | null;
  stale_at: string | null; current_head_sha: string | null; round: number; decided_at: string | null;
  decision_note: string; created_at: string; updated_at: string; revision: number;
  github_status_wanted: GithubStatus | null; github_status_posted: string | null; github_status_error: string | null;
};
type AssetRow = {
  id: string; set_id: string; sha256: string; kind: MediaKind; mime: string; bytes: number; caption: string;
  filename: string; position: number; expired_at: string | null; created_at: string; has_thumbnail: number;
};
type AnnotationRow = {
  id: string; set_id: string; asset_id: string | null; number: number; anchor_json: string; body: string;
  round: number; sent_at: string | null; created_at: string; updated_at: string;
  delivery_id: string | null; delivery_status: Delivery["status"] | null; no_recipient: number;
};
type DeliveryRow = {
  id: string; set_id: string; kind: Delivery["kind"]; revision: number; thread_id: string; text: string; images_json: string;
  status: Delivery["status"]; error: string | null; created_at: string; sent_at: string | null;
};

export type Retention = { approvedDays: number; staleDays: number; quotaBytes: number };
export type UploadFile = { bytes: Uint8Array; sha256: string; mime: string; kind: MediaKind; filename: string; caption: string };
export type UploadTarget = {
  repository: string; number: number; headSha: string; prTitle: string; prUrl: string;
  threadId: string | null; hostId: string | null;
};
export type UploadResult = { set: ProofSet; added: Asset[]; duplicates: string[]; superseded: ProofSet[]; reopenedFrom: SetStatus | null };
export type GithubStatus = "success" | "failure" | "pending";
/** The frozen message of a decision; `images` are project attachment paths. */
export type DeliveryDraft = { id: string; threadId: string; text: string; images: string[] };
export type StoredDelivery = Delivery & { threadId: string; text: string; images: string[] };

const DAY_MS = 86_400_000;
const nowIso = () => new Date().toISOString();

export class ProofStore {
  readonly mediaDir: string;
  retention: Retention = { approvedDays: 90, staleDays: 14, quotaBytes: 2 * 1024 * 1024 * 1024 };

  constructor(private db: Database.Database, migrate: (db: Database.Database, statements: string[]) => void, mediaDir?: string) {
    migrate(db, migrations);
    // The plugin's own data directory holds data.db; media files live beside it.
    this.mediaDir = mediaDir ?? join(dirname(db.name), "media");
    mkdirSync(this.mediaDir, { recursive: true });
  }

  transaction<T>(run: () => T): T {
    return this.db.transaction(run)();
  }

  mediaPath(sha256: string): string {
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("Invalid media id.");
    return join(this.mediaDir, sha256);
  }

  // ---- reading ----

  private expiresAt(row: SetRow): string | null {
    if (row.stale_at) return new Date(Date.parse(row.stale_at) + this.retention.staleDays * DAY_MS).toISOString();
    if (row.status === "approved" && row.decided_at) {
      return new Date(Date.parse(row.decided_at) + this.retention.approvedDays * DAY_MS).toISOString();
    }
    return null;
  }

  private toSet(row: SetRow): ProofSet {
    const counts = this.db.prepare(`SELECT
        SUM(kind = 'image') AS images, SUM(kind = 'video') AS videos,
        COALESCE(SUM(CASE WHEN expired_at IS NULL THEN bytes END), 0) AS bytes
      FROM assets WHERE set_id = ?`).get(row.id) as { images: number | null; videos: number | null; bytes: number };
    return {
      id: row.id,
      repository: row.repository,
      number: row.number,
      headSha: row.head_sha,
      prTitle: row.pr_title,
      prUrl: row.pr_url,
      threadId: row.thread_id,
      hostId: row.host_id,
      status: row.status,
      stale: row.stale_reason !== null,
      staleReason: row.stale_reason,
      staleAt: row.stale_at,
      currentHeadSha: row.current_head_sha,
      round: row.round,
      decidedAt: row.decided_at,
      decisionNote: row.decision_note,
      mediaExpiresAt: this.expiresAt(row),
      revision: row.revision,
      githubStatus: row.github_status_wanted
        ? { wanted: row.github_status_wanted, posted: row.github_status_posted, error: row.github_status_error }
        : null,
      imageCount: counts.images ?? 0,
      videoCount: counts.videos ?? 0,
      bytes: counts.bytes,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private toAsset(row: AssetRow): Asset {
    return {
      id: row.id, setId: row.set_id, sha256: row.sha256, kind: row.kind, mime: row.mime, bytes: row.bytes,
      caption: row.caption, filename: row.filename, position: row.position, hasThumbnail: row.has_thumbnail === 1,
      expired: row.expired_at !== null, createdAt: row.created_at,
    };
  }

  private toAnnotation(row: AnnotationRow): Annotation {
    return {
      id: row.id, setId: row.set_id, assetId: row.asset_id, number: row.number,
      anchor: anchorSchema.parse(JSON.parse(row.anchor_json)), body: row.body, round: row.round,
      // Locked once a decision includes it; sent once that decision's message was delivered.
      locked: row.sent_at !== null || row.delivery_id !== null,
      sent: this.annotationDelivery(row) === "sent",
      delivery: this.annotationDelivery(row),
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  private setRow(id: string): SetRow | undefined {
    return this.db.prepare("SELECT * FROM proof_sets WHERE id = ?").get(id) as SetRow | undefined;
  }

  private requireSetRow(id: string): SetRow {
    const row = this.setRow(id);
    if (!row) throw new Error(`Proof set ${id} does not exist.`);
    return row;
  }

  getSet(id: string): ProofSet | undefined {
    const row = this.setRow(id);
    return row ? this.toSet(row) : undefined;
  }

  requireSet(id: string): ProofSet {
    return this.toSet(this.requireSetRow(id));
  }

  latestSet(repository: string, number: number): ProofSet | undefined {
    const row = this.db.prepare("SELECT * FROM proof_sets WHERE repository = ? AND number = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(repository, number) as SetRow | undefined;
    return row ? this.toSet(row) : undefined;
  }

  assets(setId: string): Asset[] {
    return (this.db.prepare(`SELECT a.*, (t.sha256 IS NOT NULL) AS has_thumbnail FROM assets a
      LEFT JOIN thumbnails t ON t.sha256 = a.sha256 WHERE a.set_id = ? ORDER BY a.position`).all(setId) as AssetRow[])
      .map((row) => this.toAsset(row));
  }

  getAsset(id: string): Asset | undefined {
    const row = this.db.prepare(`SELECT a.*, (t.sha256 IS NOT NULL) AS has_thumbnail FROM assets a
      LEFT JOIN thumbnails t ON t.sha256 = a.sha256 WHERE a.id = ?`).get(id) as AssetRow | undefined;
    return row ? this.toAsset(row) : undefined;
  }

  annotations(setId: string): Annotation[] {
    return (this.db.prepare(`SELECT a.*, d.status AS delivery_status FROM annotations a
      LEFT JOIN deliveries d ON d.id = a.delivery_id WHERE a.set_id = ? ORDER BY a.number`).all(setId) as AnnotationRow[])
      .map((row) => this.toAnnotation(row));
  }

  /** Where a locked comment's message stands; `null` while the comment is still open. */
  private annotationDelivery(row: AnnotationRow): Annotation["delivery"] {
    if (row.delivery_id !== null) return row.delivery_status ?? "pending";
    if (row.sent_at === null) return null;
    // Before deliveries existed, a comment was locked only after its message was sent.
    return row.no_recipient === 1 ? "no_recipient" : "sent";
  }

  private annotation(id: string): Annotation {
    return this.toAnnotation(this.db.prepare(`SELECT a.*, d.status AS delivery_status FROM annotations a
      LEFT JOIN deliveries d ON d.id = a.delivery_id WHERE a.id = ?`).get(id) as AnnotationRow);
  }

  private toDelivery(row: DeliveryRow): StoredDelivery {
    return {
      id: row.id, setId: row.set_id, kind: row.kind, revision: row.revision, status: row.status, error: row.error,
      createdAt: row.created_at, sentAt: row.sent_at, threadId: row.thread_id, text: row.text, images: JSON.parse(row.images_json) as string[],
    };
  }

  getDelivery(id: string): StoredDelivery | undefined {
    const row = this.db.prepare("SELECT * FROM deliveries WHERE id = ?").get(id) as DeliveryRow | undefined;
    return row ? this.toDelivery(row) : undefined;
  }

  deliveries(setId: string): Delivery[] {
    return (this.db.prepare("SELECT * FROM deliveries WHERE set_id = ? ORDER BY created_at DESC, rowid DESC").all(setId) as DeliveryRow[])
      .map((row) => {
        const { threadId: _threadId, text: _text, images: _images, ...delivery } = this.toDelivery(row);
        return delivery;
      });
  }

  /** Deliveries still owed to a thread: failed ones, and pending ones older than `minAgeMs` (a crash mid-send). */
  undeliveredIds(minAgeMs: number, now = Date.now()): string[] {
    const cutoff = new Date(now - minAgeMs).toISOString();
    return (this.db.prepare("SELECT id FROM deliveries WHERE status = 'failed' OR (status = 'pending' AND created_at <= ?) ORDER BY created_at")
      .all(cutoff) as Array<{ id: string }>).map((row) => row.id);
  }

  markDelivery(id: string, status: "sent" | "failed", error: string | null = null): void {
    this.db.prepare("UPDATE deliveries SET status = ?, error = ?, sent_at = ? WHERE id = ? AND status <> 'sent'")
      .run(status, error, status === "sent" ? nowIso() : null, id);
  }

  /** Current sets whose GitHub status differs from what was last posted. */
  statusesToSync(): ProofSet[] {
    return (this.db.prepare(`SELECT * FROM proof_sets WHERE stale_reason IS NULL AND github_status_wanted IS NOT NULL
      AND (github_status_posted IS NULL OR github_status_posted <> github_status_wanted)`).all() as SetRow[]).map((row) => this.toSet(row));
  }

  /** Records what GitHub now shows. If the wish changed meanwhile, `statusesToSync` still lists the set. */
  recordStatusPosted(setId: string, state: GithubStatus): void {
    this.db.prepare(`UPDATE proof_sets SET github_status_posted = ?,
      github_status_error = CASE WHEN github_status_wanted = ? THEN NULL ELSE github_status_error END WHERE id = ?`).run(state, state, setId);
  }

  recordStatusError(setId: string, error: string): void {
    this.db.prepare("UPDATE proof_sets SET github_status_error = ? WHERE id = ?").run(error, setId);
  }

  events(setId: string): ProofEvent[] {
    return (this.db.prepare("SELECT id, kind, detail, created_at FROM events WHERE set_id = ? ORDER BY id DESC LIMIT 50").all(setId) as
      Array<{ id: number; kind: ProofEvent["kind"]; detail: string; created_at: string }>)
      .map((row) => ({ id: row.id, kind: row.kind, detail: row.detail, createdAt: row.created_at }));
  }

  history(repository: string, number: number): ProofSet[] {
    return (this.db.prepare("SELECT * FROM proof_sets WHERE repository = ? AND number = ? ORDER BY created_at DESC, rowid DESC")
      .all(repository, number) as SetRow[]).map((row) => this.toSet(row));
  }

  detail(repository: string, number: number, setId?: string): SetDetail | undefined {
    const set = setId ? this.getSet(setId) : this.latestSet(repository, number);
    if (!set || set.repository !== repository || set.number !== number) return undefined;
    return {
      set, assets: this.assets(set.id), annotations: this.annotations(set.id), events: this.events(set.id),
      deliveries: this.deliveries(set.id), history: this.history(repository, number),
    };
  }

  /** The newest set of every PR, most urgent first. `done` lists PRs whose newest set is approved and current. */
  listLatest(filter: { repository?: string; view: "open" | "done" }, limit = 100): { sets: SetSummary[]; openCount: number; doneCount: number } {
    const rows = this.db.prepare(`SELECT s.* FROM proof_sets s
      WHERE s.rowid = (SELECT s2.rowid FROM proof_sets s2 WHERE s2.repository = s.repository AND s2.number = s.number
                       ORDER BY s2.created_at DESC, s2.rowid DESC LIMIT 1)
        AND (? IS NULL OR s.repository = ?)
      ORDER BY s.updated_at DESC`).all(filter.repository ?? null, filter.repository ?? null) as SetRow[];
    const isDone = (row: SetRow) => row.status === "approved" && row.stale_reason === null;
    const priority = (row: SetRow) => row.stale_reason ? 2 : row.status === "pending" ? 0 : row.status === "changes_requested" ? 1 : 3;
    const selected = rows.filter((row) => (filter.view === "done") === isDone(row))
      .sort((a, b) => priority(a) - priority(b) || b.updated_at.localeCompare(a.updated_at))
      .slice(0, limit);
    return {
      sets: selected.map((row) => {
        const assets = this.assets(row.id);
        const open = this.db.prepare("SELECT COUNT(*) AS n FROM annotations WHERE set_id = ? AND sent_at IS NULL").get(row.id) as { n: number };
        return { ...this.toSet(row), previews: assets.slice(0, 5), openAnnotationCount: open.n };
      }),
      openCount: rows.filter((row) => !isDone(row)).length,
      doneCount: rows.filter(isDone).length,
    };
  }

  /** Newest sets that wait for the reviewer: current head, not decided. Drives the sidebar badge. */
  pendingCount(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM proof_sets s WHERE s.status = 'pending' AND s.stale_reason IS NULL`).get() as { n: number }).n;
  }

  repositories(): string[] {
    return (this.db.prepare("SELECT repository, MAX(updated_at) AS latest FROM proof_sets GROUP BY repository ORDER BY latest DESC").all() as
      Array<{ repository: string }>).map((row) => row.repository);
  }

  usage(): { bytes: number; quotaBytes: number } {
    const row = this.db.prepare("SELECT COALESCE(SUM(bytes), 0) AS bytes FROM media").get() as { bytes: number };
    return { bytes: row.bytes, quotaBytes: this.retention.quotaBytes };
  }

  hasMedia(sha256: string): { mime: string; bytes: number } | undefined {
    return this.db.prepare("SELECT mime, bytes FROM media WHERE sha256 = ?").get(sha256) as { mime: string; bytes: number } | undefined;
  }

  thumbnail(sha256: string): { mime: string; data: Buffer } | undefined {
    return this.db.prepare("SELECT mime, data FROM thumbnails WHERE sha256 = ?").get(sha256) as { mime: string; data: Buffer } | undefined;
  }

  // ---- writing ----

  private event(setId: string, kind: ProofEvent["kind"], detail: string, at = nowIso()): void {
    this.db.prepare("INSERT INTO events (set_id, kind, detail, created_at) VALUES (?, ?, ?, ?)").run(setId, kind, detail, at);
  }

  /** Marks a change a decision must see: the revision goes up with every mutation of files, comments or state. */
  private touch(setId: string, at = nowIso()): void {
    this.db.prepare("UPDATE proof_sets SET updated_at = ?, revision = revision + 1 WHERE id = ?").run(at, setId);
  }

  /**
   * Validates everything first, then writes new files (content-addressed, atomic rename) and records them in one
   * transaction. A refused upload leaves neither rows nor files behind; files it created are removed at once.
   * Everything here is synchronous, so no other store call interleaves between the checks and the writes.
   */
  addAssets(target: UploadTarget, files: UploadFile[]): UploadResult {
    const plan = () => {
      const row = this.db.prepare("SELECT * FROM proof_sets WHERE repository = ? AND number = ? AND head_sha = ?")
        .get(target.repository, target.number, target.headSha) as SetRow | undefined;
      if (row?.stale_reason) {
        throw new Error(`Head ${target.headSha.slice(0, 7)} is outdated for ${target.repository}#${target.number}. Push and upload for the current head.`);
      }
      const existing = row ? this.assets(row.id) : [];
      const existingShas = new Set(existing.map((asset) => asset.sha256));
      const fresh = files.filter((file, index) => !existingShas.has(file.sha256) && files.findIndex((other) => other.sha256 === file.sha256) === index);
      const duplicates = files.filter((file) => !fresh.includes(file)).map((file) => file.filename);
      if (existing.length + fresh.length > LIMITS.setFiles) throw new Error(`A proof set holds at most ${LIMITS.setFiles} files.`);
      const setBytes = existing.reduce((sum, asset) => sum + (asset.expired ? 0 : asset.bytes), 0) + fresh.reduce((sum, file) => sum + file.bytes.length, 0);
      if (setBytes > LIMITS.setBytes) throw new Error(`A proof set holds at most ${formatBytes(LIMITS.setBytes)}; this upload would make it ${formatBytes(setBytes)}.`);
      const newBytes = fresh.filter((file) => !this.hasMedia(file.sha256)).reduce((sum, file) => sum + file.bytes.length, 0);
      const usage = this.usage();
      if (usage.bytes + newBytes > usage.quotaBytes) {
        throw new Error(`Visual proof storage is full: ${formatBytes(usage.bytes)} of ${formatBytes(usage.quotaBytes)} used; this upload needs ${formatBytes(newBytes)}.`);
      }
      return { row, existing, fresh, duplicates };
    };
    const { fresh } = plan();

    const created: string[] = [];
    try {
      for (const file of fresh) {
        const path = this.mediaPath(file.sha256);
        if (this.hasMedia(file.sha256) || existsSync(path)) continue;
        const temporary = `${path}.${randomUUID()}.tmp`;
        try {
          writeFileSync(temporary, file.bytes);
          renameSync(temporary, path);
        } finally {
          rmSync(temporary, { force: true });
        }
        created.push(path);
      }
      return this.transaction(() => this.recordUpload(target, plan()));
    } catch (error) {
      for (const path of created) rmSync(path, { force: true });
      throw error;
    }
  }

  private recordUpload(target: UploadTarget, { row: found, existing, fresh, duplicates }: {
    row: SetRow | undefined; existing: Asset[]; fresh: UploadFile[]; duplicates: string[];
  }): UploadResult {
    const at = nowIso();
    let row = found;
    const superseded: ProofSet[] = [];
    if (!row) {
      const id = randomUUID();
      this.db.prepare(`INSERT INTO proof_sets (id, repository, number, head_sha, pr_title, pr_url, thread_id, host_id, status,
          current_head_sha, round, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 1, ?, ?)`)
        .run(id, target.repository, target.number, target.headSha, target.prTitle, target.prUrl, target.threadId, target.hostId, target.headSha, at, at);
      for (const older of this.db.prepare("SELECT * FROM proof_sets WHERE repository = ? AND number = ? AND id <> ? AND stale_reason IS NULL")
        .all(target.repository, target.number, id) as SetRow[]) {
        this.db.prepare("UPDATE proof_sets SET stale_reason = 'superseded', stale_at = ? WHERE id = ?").run(at, older.id);
        this.touch(older.id, at);
        this.event(older.id, "stale", `Superseded by head ${target.headSha.slice(0, 7)}.`, at);
        superseded.push(this.requireSet(older.id));
      }
      this.db.prepare("UPDATE proof_sets SET current_head_sha = ? WHERE repository = ? AND number = ?").run(target.headSha, target.repository, target.number);
      row = this.requireSetRow(id);
    } else {
      this.db.prepare(`UPDATE proof_sets SET pr_title = ?, pr_url = ?, thread_id = COALESCE(?, thread_id), host_id = COALESCE(?, host_id)
        WHERE id = ?`).run(target.prTitle, target.prUrl, target.threadId, target.hostId, row.id);
    }

    const setId = row.id;
    let position = existing.reduce((max, asset) => Math.max(max, asset.position + 1), 0);
    const added: Asset[] = [];
    for (const file of fresh) {
      this.db.prepare("INSERT OR IGNORE INTO media (sha256, mime, bytes, created_at) VALUES (?, ?, ?, ?)").run(file.sha256, file.mime, file.bytes.length, at);
      const id = randomUUID();
      this.db.prepare(`INSERT INTO assets (id, set_id, sha256, kind, mime, bytes, caption, filename, position, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, setId, file.sha256, file.kind, file.mime, file.bytes.length, file.caption, file.filename, position++, at);
      added.push(this.getAsset(id)!);
    }
    let reopenedFrom: SetStatus | null = null;
    if (added.length > 0) {
      this.event(setId, "uploaded", `${added.length} file(s): ${added.map((asset) => asset.filename).join(", ")}`.slice(0, 500), at);
      if (row.status !== "pending") {
        reopenedFrom = row.status;
        // A decision about other files no longer holds; GitHub must stop showing it.
        this.db.prepare("UPDATE proof_sets SET status = 'pending', decided_at = NULL, decision_note = '', github_status_wanted = 'pending' WHERE id = ?").run(setId);
        this.event(setId, "reopened", `New files after ${row.status === "approved" ? "approval" : "send back"}; review again.`, at);
      }
    }
    this.touch(setId, at);
    return { set: this.requireSet(setId), added, duplicates, superseded, reopenedFrom };
  }

  /** Records the PR's current head. A newest set on another head becomes stale with reason head_moved. */
  recordHead(repository: string, number: number, headSha: string): ProofSet | undefined {
    return this.transaction(() => {
      const at = nowIso();
      this.db.prepare("UPDATE proof_sets SET current_head_sha = ? WHERE repository = ? AND number = ?").run(headSha, repository, number);
      const latest = this.latestSet(repository, number);
      if (latest && !latest.stale && latest.headSha !== headSha) {
        this.db.prepare("UPDATE proof_sets SET stale_reason = 'head_moved', stale_at = ? WHERE id = ?").run(at, latest.id);
        this.touch(latest.id, at);
        this.event(latest.id, "stale", `PR head moved to ${headSha.slice(0, 7)} without a new proof.`, at);
      }
      return this.latestSet(repository, number);
    });
  }

  private requireReviewable(id: string, revision?: number): SetRow {
    const row = this.requireSetRow(id);
    if (row.stale_reason) throw new Error("This proof is for an outdated head and is read-only.");
    if (revision !== undefined && row.revision !== revision) {
      throw new Error("This proof changed since you opened it (new files or comments). Review the current state and decide again.");
    }
    return row;
  }

  /** Comments belong to an open review: not on outdated heads, not after approval. */
  private requireCommentable(id: string): SetRow {
    const row = this.requireReviewable(id);
    if (row.status === "approved") throw new Error("This proof is approved and read-only.");
    return row;
  }

  private checkAnchor(setId: string, assetId: string | null, anchor: Anchor): void {
    if (assetId === null) {
      if (anchor.kind !== "none") throw new Error("A note for the whole set has no position.");
      return;
    }
    const asset = this.getAsset(assetId);
    if (!asset || asset.setId !== setId) throw new Error("That file is not part of this proof set.");
    if (asset.kind === "image" && anchor.kind === "time") throw new Error("Image comments use a box, not a time.");
    if (asset.kind === "video" && anchor.kind === "rect") throw new Error("Screencast comments use a time, not a box.");
  }

  addAnnotation(input: AnnotationInput): Annotation {
    return this.transaction(() => {
      const row = this.requireCommentable(input.setId);
      this.checkAnchor(input.setId, input.assetId, input.anchor);
      const next = (this.db.prepare("SELECT COALESCE(MAX(number), 0) + 1 AS n FROM annotations WHERE set_id = ?").get(input.setId) as { n: number }).n;
      const id = randomUUID();
      const at = nowIso();
      this.db.prepare(`INSERT INTO annotations (id, set_id, asset_id, number, anchor_json, body, round, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, input.setId, input.assetId, next, JSON.stringify(input.anchor), input.body, row.round, at, at);
      this.touch(input.setId, at);
      return this.annotation(id);
    });
  }

  private requireOpenAnnotation(id: string): AnnotationRow {
    const row = this.db.prepare("SELECT * FROM annotations WHERE id = ?").get(id) as AnnotationRow | undefined;
    if (!row) throw new Error("That comment no longer exists.");
    if (row.sent_at || row.delivery_id) throw new Error("A sent comment cannot be changed.");
    this.requireCommentable(row.set_id);
    return row;
  }

  updateAnnotation(id: string, body: string): Annotation {
    return this.transaction(() => {
      const row = this.requireOpenAnnotation(id);
      const at = nowIso();
      this.db.prepare("UPDATE annotations SET body = ?, updated_at = ? WHERE id = ?").run(body, at, id);
      this.touch(row.set_id, at);
      return this.annotation(id);
    });
  }

  deleteAnnotation(id: string): string {
    return this.transaction(() => {
      const row = this.requireOpenAnnotation(id);
      this.db.prepare("DELETE FROM annotations WHERE id = ?").run(id);
      this.touch(row.set_id);
      return row.set_id;
    });
  }

  /** Comments not yet delivered to the implementer; they go into the next send back or approval. */
  openAnnotations(setId: string): Annotation[] {
    return this.annotations(setId).filter((annotation) => !annotation.locked);
  }

  requireSendBack(setId: string, revision?: number): { set: ProofSet; annotations: Annotation[] } {
    this.requireReviewable(setId, revision);
    const set = this.requireSet(setId);
    if (set.status === "approved") throw new Error("This proof is already approved.");
    const annotations = this.openAnnotations(setId);
    if (annotations.length === 0) throw new Error("Add at least one comment before sending back.");
    return { set, annotations };
  }

  private insertDelivery(setId: string, kind: Delivery["kind"], revision: number, delivery: DeliveryDraft, annotationIds: string[], at: string): void {
    this.db.prepare(`INSERT INTO deliveries (id, set_id, kind, revision, thread_id, text, images_json, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`).run(delivery.id, setId, kind, revision, delivery.threadId, delivery.text, JSON.stringify(delivery.images), at);
    const lock = this.db.prepare("UPDATE annotations SET sent_at = ?, delivery_id = ? WHERE id = ? AND set_id = ? AND sent_at IS NULL AND delivery_id IS NULL");
    for (const id of annotationIds) {
      if (lock.run(at, delivery.id, id, setId).changes !== 1) throw new Error("A comment changed while deciding; review the current state and decide again.");
    }
  }

  /**
   * Stores a send back for exactly the revision the reviewer saw, locks its comments into the frozen message and
   * queues that message; delivery is tracked separately and can be retried.
   */
  commitSendBack(input: { setId: string; revision: number; annotationIds: string[]; delivery: DeliveryDraft }): ProofSet {
    return this.transaction(() => {
      const row = this.requireReviewable(input.setId, input.revision);
      if (row.status === "approved") throw new Error("This proof is already approved.");
      const at = nowIso();
      this.insertDelivery(input.setId, "send_back", input.revision, input.delivery, input.annotationIds, at);
      this.db.prepare(`UPDATE proof_sets SET status = 'changes_requested', round = round + 1, decided_at = ?, github_status_wanted = 'failure'
        WHERE id = ?`).run(at, input.setId);
      this.touch(input.setId, at);
      this.event(input.setId, "sent_back", `Round ${row.round}: ${input.annotationIds.length} comment(s) sent to the implementer.`, at);
      return this.requireSet(input.setId);
    });
  }

  requireApprovable(setId: string, revision?: number): { set: ProofSet; annotations: Annotation[] } {
    this.requireReviewable(setId, revision);
    const set = this.requireSet(setId);
    if (set.status === "approved") throw new Error("This proof is already approved.");
    if (set.imageCount + set.videoCount === 0) throw new Error("This proof set has no files.");
    return { set, annotations: this.openAnnotations(setId) };
  }

  /** Approves exactly the revision the reviewer saw; any upload or comment change in between refuses the approval. */
  commitApproval(input: { setId: string; revision: number; headSha: string; note: string; annotationIds: string[]; delivery: DeliveryDraft | null }): ProofSet {
    return this.transaction(() => {
      const row = this.requireReviewable(input.setId, input.revision);
      if (row.head_sha !== input.headSha) throw new Error("Head changed while approving.");
      if (row.status === "approved") throw new Error("This proof is already approved.");
      const at = nowIso();
      if (input.delivery) {
        this.insertDelivery(input.setId, "approval", input.revision, input.delivery, input.annotationIds, at);
      } else {
        // No implementer thread: the remarks are part of the decision but reach nobody.
        const lock = this.db.prepare("UPDATE annotations SET sent_at = ?, no_recipient = 1 WHERE id = ? AND set_id = ? AND sent_at IS NULL AND delivery_id IS NULL");
        for (const id of input.annotationIds) lock.run(at, id, input.setId);
      }
      this.db.prepare("UPDATE proof_sets SET status = 'approved', decided_at = ?, decision_note = ?, github_status_wanted = 'success' WHERE id = ?")
        .run(at, input.note, input.setId);
      this.touch(input.setId, at);
      this.event(input.setId, "approved", `Approved head ${row.head_sha.slice(0, 7)} (revision ${input.revision})${input.note ? `: ${input.note}` : "."}`.slice(0, 500), at);
      return this.requireSet(input.setId);
    });
  }

  putThumbnail(assetId: string, mime: string, data: Buffer): Asset {
    const asset = this.getAsset(assetId);
    if (!asset) throw new Error("That file no longer exists.");
    if (!this.hasMedia(asset.sha256)) throw new Error("The media of this file has expired.");
    this.db.prepare("INSERT OR IGNORE INTO thumbnails (sha256, mime, data, created_at) VALUES (?, ?, ?, ?)").run(asset.sha256, mime, data, nowIso());
    return this.getAsset(assetId)!;
  }

  /** Expires the media of one set now (manual delete); stale or approved sets only. */
  deleteSetMedia(setId: string): ProofSet {
    const row = this.requireSetRow(setId);
    if (!row.stale_reason && row.status !== "approved") throw new Error("Only outdated or approved proofs can have their media deleted.");
    this.transaction(() => {
      const at = nowIso();
      const changed = this.db.prepare("UPDATE assets SET expired_at = ? WHERE set_id = ? AND expired_at IS NULL").run(at, setId).changes;
      if (changed > 0) this.event(setId, "media_deleted", `${changed} file(s) deleted by hand; comments and thumbnails remain.`, at);
      this.touch(setId, at);
    });
    this.removeUnreferencedMedia();
    return this.requireSet(setId);
  }

  /** Retention: expires media of stale and approved sets past their window, then removes files nothing current references. */
  sweep(now = Date.now()): { expiredSets: string[]; removedFiles: number } {
    const expiredSets: string[] = [];
    const candidates = this.db.prepare(`SELECT DISTINCT s.* FROM proof_sets s JOIN assets a ON a.set_id = s.id
      WHERE a.expired_at IS NULL AND (s.stale_at IS NOT NULL OR s.status = 'approved')`).all() as SetRow[];
    this.transaction(() => {
      const at = new Date(now).toISOString();
      for (const row of candidates) {
        const expires = this.expiresAt(row);
        if (!expires || Date.parse(expires) > now) continue;
        const changed = this.db.prepare("UPDATE assets SET expired_at = ? WHERE set_id = ? AND expired_at IS NULL").run(at, row.id).changes;
        if (changed > 0) {
          this.event(row.id, "media_expired", `${changed} file(s) expired after the retention window; comments and thumbnails remain.`, at);
          expiredSets.push(row.id);
        }
      }
    });
    return { expiredSets, removedFiles: this.removeUnreferencedMedia(now) };
  }

  private removeUnreferencedMedia(now = Date.now()): number {
    const orphans = this.db.prepare(`SELECT sha256 FROM media m WHERE NOT EXISTS
      (SELECT 1 FROM assets a WHERE a.sha256 = m.sha256 AND a.expired_at IS NULL)`).all() as Array<{ sha256: string }>;
    for (const { sha256 } of orphans) {
      rmSync(this.mediaPath(sha256), { force: true });
      this.db.prepare("DELETE FROM media WHERE sha256 = ?").run(sha256);
    }
    // Files left behind by an upload that failed after writing (no media row), once they are an hour old.
    let strays = 0;
    for (const name of readdirSync(this.mediaDir)) {
      const path = join(this.mediaDir, name);
      const known = /^[0-9a-f]{64}$/.test(name) && this.hasMedia(name);
      if (known) continue;
      try {
        if (now - statSync(path).mtimeMs < 3_600_000) continue;
        rmSync(path, { force: true });
        strays += 1;
      } catch {
        // Removed concurrently; nothing to do.
      }
    }
    return orphans.length + strays;
  }
}
