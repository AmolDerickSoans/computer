import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { describe, expect, it } from "vitest";

import type { BackendHandle, WorkspaceBackend } from "./backend.js";
import { Workspace } from "./workspace.js";

// Minimal in-process backend: registered so inspect() can report it,
// never connected (no dial in inspect).
class IdleBackend implements WorkspaceBackend {
  readonly id: string;
  readonly type = "idle";
  readonly description = "An idle test backend.";

  constructor(id = "idle") {
    this.id = id;
  }

  connect(): Promise<BackendHandle> {
    return Promise.reject(new Error("IdleBackend must not connect"));
  }
}

function makeWorkspace(options?: { backends?: WorkspaceBackend[]; sessionId?: string }): Workspace {
  return new Workspace({
    storage: new SQLiteTestStorage(),
    ...(options?.backends ? { backends: options.backends } : {}),
    ...(options?.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
  });
}

describe("Workspace.inspect", () => {
  it("reports an empty workspace with zeroed storage and no backends", async () => {
    const ws = makeWorkspace();
    const report = await ws.inspect();

    expect(report.sessionId).toBe("");
    // initializeSchema seeds rev at 1 and creates the root directory.
    expect(report.revision.current).toBe(1);
    expect(report.storage).toEqual({
      files: 0,
      directories: 1,
      symlinks: 0,
      totalFileBytes: 0,
      blobs: 0,
      blobBytes: 0,
      tombstones: 0,
    });
    expect(report.largestFiles).toEqual([]);
    expect(report.sync).toEqual([]);
    expect(report.backends).toEqual([]);
    expect(report.mounts).toEqual([]);
    expect(report.executions).toEqual({ tracked: 0, recent: [] });
  });

  it("counts files, directories, and bytes after writes", async () => {
    const ws = makeWorkspace();
    await ws.fs.mkdir("/workspace/src", { recursive: true });
    await ws.fs.writeFile("/workspace/README.md", "# hi\n");
    await ws.fs.writeFile("/workspace/src/index.ts", "export {}\n");
    await ws.fs.writeFile("/workspace/src/index.ts", "export const x = 1;\n");

    const report = await ws.inspect();

    expect(report.storage.files).toBe(2);
    expect(report.storage.directories).toBe(3); // /, /workspace, /workspace/src
    expect(report.storage.symlinks).toBe(0);
    expect(report.storage.totalFileBytes).toBe("# hi\n".length + "export const x = 1;\n".length);
    expect(report.revision.current).toBeGreaterThan(0);
    expect(report.storage.blobs).toBeGreaterThan(0);
    // Stale blobs from the overwritten write may linger until GC.
    expect(report.storage.blobBytes).toBeGreaterThanOrEqual(report.storage.totalFileBytes);
  });

  it("lists the largest files in size order, capped by the option", async () => {
    const ws = makeWorkspace();
    await ws.fs.mkdir("/workspace", { recursive: true });
    await ws.fs.writeFile("/workspace/small.txt", "aa");
    await ws.fs.writeFile("/workspace/large.txt", "a".repeat(300));
    await ws.fs.writeFile("/workspace/mid.txt", "a".repeat(100));

    const report = await ws.inspect({ largestFiles: 2 });

    expect(report.largestFiles).toEqual([
      { path: "/workspace/large.txt", size: 300 },
      { path: "/workspace/mid.txt", size: 100 },
    ]);
  });

  it("omits the largest-files list when the limit is zero", async () => {
    const ws = makeWorkspace();
    await ws.fs.mkdir("/workspace", { recursive: true });
    await ws.fs.writeFile("/workspace/a.txt", "hello");

    const report = await ws.inspect({ largestFiles: 0 });

    expect(report.largestFiles).toEqual([]);
  });

  it("reports registered backends without dialing them", async () => {
    const ws = makeWorkspace({
      backends: [new IdleBackend("idle-1")],
      sessionId: "session-42",
    });

    const report = await ws.inspect();

    expect(report.sessionId).toBe("session-42");
    expect(report.backends).toEqual([
      {
        id: "idle-1",
        type: "idle",
        protocol: "command",
        callable: false,
        connected: false,
        description: "An idle test backend.",
      },
    ]);
  });

  it("reports per-backend sync cursors for every registered backend", async () => {
    const ws = makeWorkspace({ backends: [new IdleBackend("idle-1")] });

    const report = await ws.inspect();

    expect(report.sync).toEqual([
      {
        backend: "idle-1",
        pushCursor: { rev: 0, path: null },
        fetchCursor: { rev: 0, path: null },
        pendingOperations: [],
      },
    ]);
  });

  it("lists tracked executions from the durable store", async () => {
    const ws = makeWorkspace();
    ws.db.run(
      "INSERT INTO computer_execution_runtime (execution_key, runtime_id) VALUES (?, ?)",
      JSON.stringify(["idle-1", "exec-1"]),
      "runtime-a",
    );

    const report = await ws.inspect();

    expect(report.executions.tracked).toBe(1);
    expect(report.executions.recent).toEqual([
      { backend: "idle-1", executionId: "exec-1", runtimeId: "runtime-a" },
    ]);
  });
});
