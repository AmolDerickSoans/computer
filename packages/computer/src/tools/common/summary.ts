import { z } from "zod";
import type { WorkspaceBackendInfo } from "../../runtime/runtime.js";

/** The filesystem surface the summary tool reads through. */
export interface SummaryWorkspaceLike {
  fs: {
    readdir(
      path: string,
      options?: { limit?: number; offset?: number },
    ): Promise<
      Array<{
        name: string;
        size: number;
        isFile: boolean;
        isDirectory: boolean;
        isSymbolicLink: boolean;
      }>
    >;
  };
  runtime?: {
    backends?(): readonly WorkspaceBackendInfo[];
  };
}

export interface SummaryToolOptions {
  workspace: SummaryWorkspaceLike;
}

/** Entries beyond this page are counted as truncated rather than listed. */
const MAX_ENTRIES = 200;
const DEFAULT_PATH = "/workspace";

export const summaryInputSchema = z.object({
  path: z
    .string()
    .optional()
    .describe(`Absolute directory path to summarize. Defaults to ${DEFAULT_PATH}.`),
});

export interface SummaryEntry {
  name: string;
  size: number;
  kind: "file" | "directory" | "symlink";
}

export type SummaryResult =
  | {
      path: string;
      count: number;
      files: number;
      directories: number;
      totalBytes: number;
      truncated: boolean;
      entries: SummaryEntry[];
    }
  | { error: string };

/**
 * Build the tool description from what the workspace actually has.
 *
 * The inventory line is the only part that changes: a workspace with
 * backends names them, and one without says so, so the description
 * stays truthful no matter how the workspace is configured.
 */
export function workspaceSummaryDescription(workspace: SummaryWorkspaceLike): string {
  const base = `Summarize a workspace directory in one call: entry count, file and directory counts, total bytes, and each entry with its size. Covers the first ${MAX_ENTRIES} entries; pass path to choose another directory (defaults to ${DEFAULT_PATH}).`;
  const backends = workspace.runtime?.backends?.() ?? [];
  if (backends.length === 0) {
    return `${base} No execution backend is registered on this workspace.`;
  }
  const inventory = backends
    .map(
      (backend) =>
        `${backend.id} (${backend.protocol}${backend.callable ? ", callable" : ", command-only"})`,
    )
    .join(", ");
  return `${base} Registered execution backends: ${inventory}.`;
}

/**
 * Page one directory and reduce it to counts and sizes.
 *
 * Reads one more entry than the cap to learn whether a further page
 * exists without a second call, then reports `truncated` when it does.
 */
export async function summarizeWorkspace(
  workspace: SummaryWorkspaceLike,
  input: { path?: string },
): Promise<SummaryResult> {
  try {
    const path = input.path ?? DEFAULT_PATH;
    const page = await workspace.fs.readdir(path, { limit: MAX_ENTRIES + 1 });
    const truncated = page.length > MAX_ENTRIES;
    const entries = (truncated ? page.slice(0, MAX_ENTRIES) : page).map((entry) => ({
      name: entry.name,
      size: entry.size,
      kind: entry.isFile
        ? ("file" as const)
        : entry.isDirectory
          ? ("directory" as const)
          : ("symlink" as const),
    }));
    return {
      path,
      count: entries.length,
      files: entries.filter((entry) => entry.kind === "file").length,
      directories: entries.filter((entry) => entry.kind === "directory").length,
      totalBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
      truncated,
      entries,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
