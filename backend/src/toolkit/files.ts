/**
 * Reading and writing files, path-scoped — REQ-047 (#206), task #215.
 *
 * In `toolkit/` rather than `tools/` because it performs I/O and boundary rule **R7** forbids that in the tools
 * layer, the same arrangement `http.ts` has with the web tools. The tools in `tools/library/fs.ts` are envelopes
 * over these functions, and every security property lives here — not in the envelope, and not in the schema.
 *
 * ## The one property that matters
 *
 * **A path a model produced must not be able to name a file outside the configured root**, and there are three
 * ways it tries:
 *
 * - `../../etc/passwd` — normalised away by resolving against the root first.
 * - `/etc/passwd` — an absolute path is **refused outright** rather than silently re-rooted. Re-rooting would
 *   answer a different question than the one asked, and the model would not know.
 * - A **symlink** inside the root pointing out of it. This is the one that gets missed, because the path is
 *   inside the root right up until the filesystem resolves it. So the check is against the *real* path, after
 *   symlink resolution, on every call — not against the string.
 *
 * The root itself is resolved once at construction, also through `realpath`: a root that is itself a symlink
 * would otherwise make every real path look like an escape.
 *
 * ## Bytes are bounded while reading
 *
 * A cap applied after `readFile` has already buffered a two-gigabyte file protects nothing. These read into a
 * fixed buffer and report `truncated`, which is the same decision `http.ts` made for the same reason. Truncation
 * rather than refusal, because "the first 200 KB of the log" is usually the answer, and a refusal leaves the
 * model with nothing.
 */

import { closeSync, existsSync, openSync, readSync, readdirSync, realpathSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Bytes returned from one read. Matches the HTTP client's ceiling, for the same reason. */
export const MAX_FILE_BYTES = 200_000;
/** Entries returned from one listing. A directory of ten thousand files is not an answer. */
export const MAX_ENTRIES = 200;
/** Files examined by one search. Bounded work, so a search cannot become a filesystem crawl. */
export const MAX_SEARCHED_FILES = 2_000;
/** Matches returned from one search. */
export const MAX_MATCHES = 100;

export type FileScope = {
  /** Everything readable, and the only thing readable. Resolved through `realpath` at construction. */
  readonly root: string;
  /**
   * Where writes may land, when writes are wanted at all.
   *
   * Separate from `root`, and absent by default. A deployment that pointed both at the same directory would let
   * a model edit the material it also reads — which is how a corpus a model cites becomes a corpus a model wrote.
   */
  readonly writableRoot?: string;
  readonly maxBytes?: number;
  readonly maxEntries?: number;
  readonly maxMatches?: number;
  readonly maxSearchedFiles?: number;
};

/**
 * Why a file operation did not happen.
 *
 * A *reason*, not an exception, for the reason `HttpFailure` gives: a refused path is information the model can
 * act on, and a thrown error reads as "something broke", which invites an identical retry.
 */
export type FileFailure = {
  readonly ok: false;
  readonly path: string;
  readonly kind: "forbidden" | "not-found" | "not-a-file" | "not-a-directory" | "unreadable" | "too-many";
  readonly reason: string;
};

export type FileRead = {
  readonly ok: true;
  readonly path: string;
  readonly bytes: number;
  readonly truncated: boolean;
  readonly content: string;
};

export type FileEntry = {
  readonly name: string;
  readonly path: string;
  readonly kind: "file" | "directory" | "other";
  readonly bytes?: number;
};

export type FileList = {
  readonly ok: true;
  readonly path: string;
  readonly entries: readonly FileEntry[];
  readonly truncated: boolean;
};

export type FileMatch = {
  readonly path: string;
  readonly line: number;
  /** The matching line, trimmed and capped. Untrusted content, like everything else read from disk. */
  readonly text: string;
};

export type FileSearch = {
  readonly ok: true;
  readonly query: string;
  readonly matches: readonly FileMatch[];
  readonly filesSearched: number;
  /** True when the file or match ceiling stopped the search early. */
  readonly truncated: boolean;
};

export type FileWrite = {
  readonly ok: true;
  readonly path: string;
  readonly bytes: number;
  readonly created: boolean;
};

const forbidden = (path: string, reason: string): FileFailure => ({ ok: false, path, kind: "forbidden", reason });

/**
 * Is `candidate` inside `root`, both already real paths?
 *
 * `relative` rather than `startsWith`: `/srv/data-secrets` starts with `/srv/data`, and a prefix comparison would
 * accept it. A relative path that begins with `..` or is absolute is outside.
 */
export const contains = (root: string, candidate: string): boolean => {
  if (candidate === root) return true;
  const rel = relative(root, candidate);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
};

export type FileReader = {
  read(path: string): FileRead | FileFailure;
  list(path?: string): FileList | FileFailure;
  search(input: { readonly query: string; readonly path?: string; readonly namePattern?: string }): FileSearch | FileFailure;
  write(input: { readonly path: string; readonly content: string }): FileWrite | FileFailure;
};

export const createFileReader = (scope: FileScope): FileReader => {
  const maxBytes = scope.maxBytes ?? MAX_FILE_BYTES;
  const maxEntries = scope.maxEntries ?? MAX_ENTRIES;
  const maxMatches = scope.maxMatches ?? MAX_MATCHES;
  const maxSearched = scope.maxSearchedFiles ?? MAX_SEARCHED_FILES;

  /**
   * The root, resolved once through `realpath`.
   *
   * A root that is itself a symlink — `/tmp` on macOS is `/private/tmp` — would otherwise make every resolved
   * path look like an escape, and the tool would refuse everything while appearing to be configured correctly.
   */
  const realRoot = realpathSync(scope.root);
  const realWritable = scope.writableRoot === undefined ? undefined : realpathSync(scope.writableRoot);

  /** Resolve a model-supplied path inside a root, or say why not. */
  const within = (root: string, requested: string, mustExist: boolean): { ok: true; path: string } | FileFailure => {
    if (isAbsolute(requested))
      return forbidden(
        requested,
        "Give a path relative to the configured root. An absolute path is refused rather than re-rooted, so a " +
          "refusal is never mistaken for a different file.",
      );
    const joined = resolve(root, requested);

    /**
     * Lexical containment first, before the filesystem is consulted at all.
     *
     * `../../etc/passwd` used to come back as `not-found`, because `realpath` threw on a path that does not exist
     * and the containment check never ran. Technically safe and a poor answer: the model learns that a path it
     * may not read merely happens to be absent, which is a different fact and an invitation to try another. It
     * also means the refusal depended on the target's existence, which is not a property anybody wants a security
     * boundary to have.
     */
    if (!contains(root, joined))
      return forbidden(requested, "That path is outside the configured root.");

    if (mustExist) {
      let real: string;
      try {
        real = realpathSync(joined);
      } catch {
        return { ok: false, path: requested, kind: "not-found", reason: `No such path: ${requested}` };
      }
      if (!contains(root, real))
        return forbidden(requested, "That path resolves outside the configured root. Symlinks are followed and then checked.");
      return { ok: true, path: real };
    }

    /**
     * For a write, the target may not exist yet — nor may its directory.
     *
     * So walk up to the nearest ancestor that *does* exist, resolve **that** through `realpath`, and rebuild the
     * target beneath it. The first version resolved `dirname` only, which refused every write into a directory it
     * was about to create — a correct-looking check that made the tool useless. Resolving the existing prefix is
     * what keeps the symlink guarantee: a link anywhere along the real part of the path is followed and checked.
     */
    const missing: string[] = [];
    let probe = joined;
    while (!existsSync(probe)) {
      const parent = dirname(probe);
      if (parent === probe) break;
      missing.unshift(basename(probe));
      probe = parent;
    }
    let realPrefix: string;
    try {
      realPrefix = realpathSync(probe);
    } catch {
      return { ok: false, path: requested, kind: "not-found", reason: `No such path: ${requested}` };
    }
    const candidate = missing.length === 0 ? realPrefix : join(realPrefix, ...missing);
    if (!contains(root, candidate))
      return forbidden(requested, "That path resolves outside the configured root. Symlinks are followed and then checked.");
    return { ok: true, path: candidate };
  };

  const readBounded = (path: string): FileRead | FileFailure => {
    let handle: number;
    try {
      handle = openSync(path, "r");
    } catch (error) {
      return { ok: false, path, kind: "unreadable", reason: (error as Error).message };
    }
    try {
      const buffer = Buffer.alloc(maxBytes + 1);
      const read = readSync(handle, buffer, 0, maxBytes + 1, 0);
      const truncated = read > maxBytes;
      return {
        ok: true,
        path,
        bytes: truncated ? maxBytes : read,
        truncated,
        content: buffer.subarray(0, truncated ? maxBytes : read).toString("utf8"),
      };
    } catch (error) {
      return { ok: false, path, kind: "unreadable", reason: (error as Error).message };
    } finally {
      closeSync(handle);
    }
  };

  /** A deliberately small pattern language: `*.md`, `report*`, `*draft*`. Not a glob engine. */
  const matchesName = (name: string, pattern: string | undefined): boolean => {
    if (pattern === undefined || pattern === "") return true;
    const parts = pattern.toLowerCase().split("*");
    const lower = name.toLowerCase();
    if (parts.length === 1) return lower === (parts[0] ?? "");
    let index = 0;
    for (const [position, part] of parts.entries()) {
      if (part === "") continue;
      const at = lower.indexOf(part, index);
      if (at === -1) return false;
      if (position === 0 && at !== 0) return false;
      index = at + part.length;
    }
    const last = parts[parts.length - 1] ?? "";
    return last === "" || lower.endsWith(last);
  };

  return {
    read(requested) {
      const scoped = within(realRoot, requested, true);
      if (!scoped.ok) return scoped;
      let stats;
      try {
        stats = statSync(scoped.path);
      } catch (error) {
        return { ok: false, path: requested, kind: "not-found", reason: (error as Error).message };
      }
      if (stats.isDirectory())
        return { ok: false, path: requested, kind: "not-a-file", reason: `${requested} is a directory — use fs_list.` };
      const outcome = readBounded(scoped.path);
      return outcome.ok ? { ...outcome, path: relative(realRoot, scoped.path) || "." } : { ...outcome, path: requested };
    },

    list(requested = ".") {
      const scoped = within(realRoot, requested, true);
      if (!scoped.ok) return scoped;
      let names: string[];
      try {
        names = readdirSync(scoped.path).sort();
      } catch (error) {
        const message = (error as { code?: string }).code === "ENOTDIR" ? `${requested} is a file — use fs_read.` : (error as Error).message;
        return {
          ok: false,
          path: requested,
          kind: (error as { code?: string }).code === "ENOTDIR" ? "not-a-directory" : "unreadable",
          reason: message,
        };
      }
      const entries: FileEntry[] = [];
      for (const name of names.slice(0, maxEntries)) {
        const full = join(scoped.path, name);
        let stats;
        try {
          stats = statSync(full);
        } catch {
          // A broken symlink or a file removed mid-listing. Reported as `other` rather than omitted: a name that
          // exists and cannot be described is more useful than a silently shorter list.
          entries.push({ name, path: relative(realRoot, full), kind: "other" });
          continue;
        }
        entries.push({
          name,
          path: relative(realRoot, full),
          kind: stats.isDirectory() ? "directory" : stats.isFile() ? "file" : "other",
          ...(stats.isFile() ? { bytes: stats.size } : {}),
        });
      }
      return { ok: true, path: relative(realRoot, scoped.path) || ".", entries, truncated: names.length > maxEntries };
    },

    search({ query, path = ".", namePattern }) {
      if (query.trim() === "")
        return { ok: false, path, kind: "unreadable", reason: "Give something to search for." };
      const scoped = within(realRoot, path, true);
      if (!scoped.ok) return scoped;

      const needle = query.toLowerCase();
      const matches: FileMatch[] = [];
      let searched = 0;
      let truncated = false;

      const walk = (dir: string): void => {
        if (truncated) return;
        let names: string[];
        try {
          names = readdirSync(dir).sort();
        } catch {
          return;
        }
        for (const name of names) {
          if (truncated) return;
          const full = join(dir, name);
          let stats;
          try {
            stats = statSync(full);
          } catch {
            continue;
          }
          // The real path is checked here too: a symlinked directory inside the root would otherwise let a
          // search walk out of it, which is the same escape as a symlinked file and easier to miss.
          if (!contains(realRoot, realpathSync(full))) continue;
          if (stats.isDirectory()) {
            walk(full);
            continue;
          }
          if (!stats.isFile() || !matchesName(name, namePattern)) continue;
          searched += 1;
          if (searched > maxSearched) {
            truncated = true;
            return;
          }
          const read = readBounded(full);
          if (!read.ok) continue;
          read.content.split("\n").forEach((line, index) => {
            if (truncated || !line.toLowerCase().includes(needle)) return;
            if (matches.length >= maxMatches) {
              truncated = true;
              return;
            }
            matches.push({ path: relative(realRoot, full), line: index + 1, text: line.trim().slice(0, 400) });
          });
        }
      };
      walk(scoped.path);
      return { ok: true, query, matches, filesSearched: searched, truncated };
    },

    write({ path, content }) {
      if (realWritable === undefined)
        return forbidden(
          path,
          "No writable root is configured, so nothing can be written. This is a wiring decision, not a " +
            "permission one — see FileScope.writableRoot.",
        );
      const scoped = within(realWritable, path, false);
      if (!scoped.ok) return scoped;
      const bytes = Buffer.byteLength(content, "utf8");
      if (bytes > maxBytes)
        return { ok: false, path, kind: "too-many", reason: `That is ${bytes} bytes; the ceiling is ${maxBytes}.` };
      let created = true;
      try {
        created = !statSync(scoped.path).isFile();
      } catch {
        created = true;
      }
      try {
        mkdirSync(dirname(scoped.path), { recursive: true });
        writeFileSync(scoped.path, content, "utf8");
      } catch (error) {
        return { ok: false, path, kind: "unreadable", reason: (error as Error).message };
      }
      return { ok: true, path: relative(realWritable, scoped.path), bytes, created };
    },
  };
};
