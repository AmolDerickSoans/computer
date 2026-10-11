// Workspace.inspect() — a read-only, structured snapshot of a
// Workspace for debugging and agent observability.
//
// Every section is answered from the local Durable Object store
// (SQLite) plus in-memory Workspace state. Nothing here dials a
// backend, so the report is safe to call frequently — from a health
// endpoint, an agent loop, or a log line — without touching the wire.

import {
  currentRev,
  type Database,
  ROOT_INODE,
  readFetchCursor,
  readPushCursor,
} from "@cloudflare/dofs";
import type { Mount } from "./mounts/types.js";
import { isModuleBackend, type WorkspaceRegisteredBackend } from "./runtime/types.js";

/** Options for {@link Workspace.inspect}. */
export interface WorkspaceInspectOptions {
  /**
   * How many of the largest files to include, ordered by size.
   * Defaults to 5; pass 0 to skip the list and its path walk.
   */
  largestFiles?: number;
}

const DEFAULT_LARGEST_FILES = 5;
const MAX_LARGEST_FILES = 50;
const RECENT_EXECUTIONS = 10;

/** Filesystem and blob-store counters, all answered with one row each. */
export interface WorkspaceInspectStorage {
  files: number;
  directories: number;
  symlinks: number;
  /** Sum of `vfs_nodes.size` over file nodes. */
  totalFileBytes: number;
  blobs: number;
  /** Sum of `vfs_blobs.size`. */
  blobBytes: number;
  /** Tombstone rows in `vfs_changes`. */
  tombstones: number;
}

/** One registered backend and whether the Workspace holds a live handle for it. */
export interface WorkspaceInspectBackend {
  id: string;
  /** The backend's diagnostic kind ("cloudflare-container", "worker-shell", ...). */
  type: string;
  protocol: "command" | "module";
  callable: boolean;
  /** True when a handle is cached — the backend has been dialed this incarnation. */
  connected: boolean;
  /** Durable identity of the connected runtime, when the handle reports one. */
  runtimeId?: string;
  description?: string;
}

/** Sync cursors and unfinished operations for one backend. */
export interface WorkspaceInspectSync {
  backend: string;
  pushCursor: { rev: number; path: string | null };
  fetchCursor: { rev: number; path: string | null };
  pendingOperations: Array<{
    direction: "pull" | "push";
    status: "capturing" | "pending" | "failed" | "lost";
    generation: string;
    targetRev?: number;
  }>;
}

/** A registered mount root. */
export interface WorkspaceInspectMount {
  root: string;
  kind: string;
  mode: "read-only" | "read-write";
}

/** Durable execution-to-runtime mappings still tracked for this store. */
export interface WorkspaceInspectExecutions {
  tracked: number;
  recent: Array<{ backend: string; executionId: string; runtimeId: string }>;
}

/** The full inspect report. Every section is present; empty workspaces report zeros. */
export interface WorkspaceInspectReport {
  sessionId: string;
  revision: { current: number };
  storage: WorkspaceInspectStorage;
  largestFiles: Array<{ path: string; size: number }>;
  sync: WorkspaceInspectSync[];
  backends: WorkspaceInspectBackend[];
  mounts: WorkspaceInspectMount[];
  executions: WorkspaceInspectExecutions;
}

/** What Workspace passes the collector: its store plus in-memory state. */
export interface InspectCollector {
  db: Database;
  sessionId: string;
  backends: ReadonlyMap<string, WorkspaceRegisteredBackend>;
  connected: (id: string) => { connected: boolean; runtimeId?: string };
  mounts: Map<string, Mount>;
  largestFiles?: number;
}

/** Build the report. Pure reads; never opens a backend connection. */
export function collectInspect(input: InspectCollector): WorkspaceInspectReport {
  const limit = clampLimit(input.largestFiles);
  const storage = readStorage(input.db);
  return {
    sessionId: input.sessionId,
    revision: { current: currentRev(input.db) },
    storage,
    largestFiles: limit === 0 ? [] : readLargestFiles(input.db, limit),
    sync: readSync(input.db, input.backends),
    backends: readBackends(input.backends, input.connected),
    mounts: [...input.mounts].map(([root, mount]) => ({
      root,
      kind: mount.kind,
      mode: mount.mode,
    })),
    executions: readExecutions(input.db),
  };
}

function clampLimit(requested: number | undefined): number {
  const limit = requested ?? DEFAULT_LARGEST_FILES;
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new Error(
      `Workspace.inspect: largestFiles must be a non-negative integer, got ${String(requested)}`,
    );
  }
  return Math.min(limit, MAX_LARGEST_FILES);
}

function readStorage(db: Database): WorkspaceInspectStorage {
  const nodes = db.one<{
    files: number;
    directories: number;
    symlinks: number;
    total_file_bytes: number;
  }>(`
    SELECT
      COALESCE(SUM(type = 'file'), 0)      AS files,
      COALESCE(SUM(type = 'dir'), 0)       AS directories,
      COALESCE(SUM(type = 'symlink'), 0)   AS symlinks,
      COALESCE(SUM(CASE WHEN type = 'file' THEN size ELSE 0 END), 0) AS total_file_bytes
    FROM vfs_nodes
  `);
  const blobs = db.one<{ blobs: number; blob_bytes: number }>(`
    SELECT COUNT(*) AS blobs, COALESCE(SUM(size), 0) AS blob_bytes FROM vfs_blobs
  `);
  const tombstones = db.scalar<number>("SELECT COUNT(*) FROM vfs_changes") ?? 0;
  return {
    files: nodes?.files ?? 0,
    directories: nodes?.directories ?? 0,
    symlinks: nodes?.symlinks ?? 0,
    totalFileBytes: nodes?.total_file_bytes ?? 0,
    blobs: blobs?.blobs ?? 0,
    blobBytes: blobs?.blob_bytes ?? 0,
    tombstones,
  };
}

// Top files by the cached node size, then one upward walk per file to
// its path. The walk uses the vfs_dirents_by_child index, so the cost
// is O(limit * tree depth) rather than a full-tree scan.
function readLargestFiles(db: Database, limit: number): Array<{ path: string; size: number }> {
  const rows = db.all<{ inode: number; size: number }>(
    "SELECT inode, size FROM vfs_nodes WHERE type = 'file' ORDER BY size DESC, inode LIMIT ?",
    limit,
  );
  const out: Array<{ path: string; size: number }> = [];
  for (const row of rows) {
    const path = resolvePath(db, row.inode);
    if (path !== null) out.push({ path, size: row.size });
  }
  return out;
}

function resolvePath(db: Database, inode: number): string | null {
  const parts: string[] = [];
  let current = inode;
  for (let depth = 0; depth < 256; depth++) {
    const row = db.one<{ parent_inode: number; name: string }>(
      "SELECT parent_inode, name FROM vfs_dirents WHERE child_inode = ?",
      current,
    );
    if (row === undefined) return null;
    parts.push(row.name);
    if (row.parent_inode === ROOT_INODE) {
      parts.reverse();
      return `/${parts.join("/")}`;
    }
    current = row.parent_inode;
  }
  return null;
}

function readSync(
  db: Database,
  backends: ReadonlyMap<string, WorkspaceRegisteredBackend>,
): WorkspaceInspectSync[] {
  const ids = new Set<string>(backends.keys());
  for (const row of db.all<{ backend: string }>("SELECT DISTINCT backend FROM _vfs_watermark")) {
    ids.add(row.backend);
  }
  for (const row of db.all<{ backend: string }>(
    "SELECT DISTINCT backend FROM _vfs_sync_operations",
  )) {
    ids.add(row.backend);
  }
  const entries = [...ids].sort().map((backend) => ({
    backend,
    pushCursor: readPushCursor(db, backend),
    fetchCursor: readFetchCursor(db, backend),
    pendingOperations: readPendingOperations(db, backend),
  }));
  // initializeSchema seeds watermark rows for a "default" backend so
  // the cursors always exist. A backend that is neither registered
  // nor has moved a cursor nor left an operation behind is noise —
  // drop it rather than report a phantom peer.
  return entries.filter(
    (entry) =>
      backends.has(entry.backend) ||
      entry.pushCursor.rev !== 0 ||
      entry.pushCursor.path !== null ||
      entry.fetchCursor.rev !== 0 ||
      entry.fetchCursor.path !== null ||
      entry.pendingOperations.length > 0,
  );
}

function readPendingOperations(
  db: Database,
  backend: string,
): WorkspaceInspectSync["pendingOperations"] {
  return db
    .all<{
      direction: "pull" | "push";
      status: "capturing" | "pending" | "failed" | "lost";
      generation: string;
      target_rev: number | null;
    }>(
      `SELECT direction, status, generation, target_rev
         FROM _vfs_sync_operations
        WHERE backend = ? AND status IN ('capturing', 'pending', 'failed', 'lost')
        ORDER BY direction`,
      backend,
    )
    .map((row) => ({
      direction: row.direction,
      status: row.status,
      generation: row.generation,
      ...(row.target_rev === null ? {} : { targetRev: row.target_rev }),
    }));
}

function readBackends(
  backends: ReadonlyMap<string, WorkspaceRegisteredBackend>,
  connected: (id: string) => { connected: boolean; runtimeId?: string },
): WorkspaceInspectBackend[] {
  return [...backends.values()].map((backend) => {
    const status = connected(backend.id);
    const module = isModuleBackend(backend);
    return {
      id: backend.id,
      type: backend.type,
      protocol: module ? ("module" as const) : ("command" as const),
      callable: backend.callable === true,
      connected: status.connected,
      ...(status.runtimeId === undefined ? {} : { runtimeId: status.runtimeId }),
      ...(backend.description === undefined ? {} : { description: backend.description }),
    };
  });
}

// The execution-runtime store keeps one row per (backend, executionId)
// with no timestamp column, so rowid order stands in for recency:
// rows are inserted as executions start.
function readExecutions(db: Database): WorkspaceInspectExecutions {
  const tracked = db.scalar<number>("SELECT COUNT(*) FROM computer_execution_runtime") ?? 0;
  const recent = db
    .all<{ execution_key: string; runtime_id: string }>(
      "SELECT execution_key, runtime_id FROM computer_execution_runtime ORDER BY rowid DESC LIMIT ?",
      RECENT_EXECUTIONS,
    )
    .map((row) => {
      const parsed = parseExecutionKey(row.execution_key);
      return {
        backend: parsed.backend,
        executionId: parsed.executionId,
        runtimeId: row.runtime_id,
      };
    });
  return { tracked, recent };
}

function parseExecutionKey(key: string): { backend: string; executionId: string } {
  try {
    const parsed: unknown = JSON.parse(key);
    if (Array.isArray(parsed) && parsed.length === 2) {
      return { backend: String(parsed[0]), executionId: String(parsed[1]) };
    }
  } catch {
    // Fall through: an unrecognized key is reported verbatim.
  }
  return { backend: "", executionId: key };
}
