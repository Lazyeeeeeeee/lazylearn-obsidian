/**
 * frontmatter 里那个「这篇笔记和服务端哪一篇对应、上次同步到哪一版」的小本子。
 *
 * ```yaml
 * lazylearn:
 *   sync:
 *     noteId: obs-<uuid>   # 服务端 externalId，插件生成一次就不再变
 *     version: 3           # 上次说定的服务端版本号
 *     hash: 8f3a1c2d       # 上次说定的那一段内容的哈希
 *     at: 2026-10-15T…     # 上次同步时间（给人看的）
 * ```
 *
 * 三个值一起才有意义：`version` 说「服务端那一版我见过」，`hash` 说「我这一版长这样」，
 * 两者分别跟当前值比，就知道是**只有本地改了**、**只有服务端改了**，还是**两边都改了**。
 */

export const SYNC_KEY = "sync";
export const SYNC_SCHEMA = 1;

export interface SyncMarker {
  noteId: string;
  version: number;
  hash: string;
  at: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 认不出来就当没同步过：一份手改坏的 frontmatter 不该让整条同步链报错。 */
export function readSyncMarker(frontmatter: unknown): SyncMarker | null {
  if (!isRecord(frontmatter)) return null;
  const block = frontmatter["lazylearn"];
  if (!isRecord(block)) return null;
  const raw = block[SYNC_KEY];
  if (!isRecord(raw)) return null;
  const noteId = raw["noteId"];
  const version = raw["version"];
  const hash = raw["hash"];
  if (typeof noteId !== "string" || noteId.trim() === "") return null;
  if (typeof version !== "number" || !Number.isFinite(version) || version < 1) return null;
  if (typeof hash !== "string" || hash === "") return null;
  const at = raw["at"];
  return { noteId, version, hash, at: typeof at === "string" && at !== "" ? at : null };
}

/** 原地写入（`processFrontMatter` 的回调就是这么用的）。 */
export function writeSyncMarkerInto(frontmatter: Record<string, unknown>, marker: SyncMarker): void {
  const block = frontmatter["lazylearn"];
  const existing = isRecord(block) ? { ...block } : {};
  existing[SYNC_KEY] = {
    noteId: marker.noteId,
    version: marker.version,
    hash: marker.hash,
    ...(marker.at === null ? {} : { at: marker.at }),
  };
  frontmatter["lazylearn"] = existing;
}

export function newNoteId(uuid: string): string {
  return `obs-${uuid}`;
}