/**
 * 双向同步的落地：读笔记 → 问服务端 → 按 plan 决定推/拉/报冲突 → 写回。
 *
 * 两条不动的原则：
 * 1. **不自动覆盖**。两边都改了就停下来报冲突，由用户选；插件不会替他挑一边。
 * 2. **frontmatter 不参与同步**。它是本地的（标签、别名、绑定、同步本子），
 *    服务端只拿「属于人的那一段」正文（归档笔记就只剩托管块之后的错因）。
 */

import type { App, TFile } from "obsidian";

import { ApiError, type LazylearnClient } from "../api/client.ts";
import type { Note } from "../api/contracts.ts";
import { fnv1a } from "../lib/hash.ts";
import { newUuid } from "../lib/ids.ts";
import { newNoteId, readSyncMarker, writeSyncMarkerInto } from "./marker.ts";
import type { SyncMarker } from "./marker.ts";
import { applySyncedPart, hashOfSyncedPart, planSync, pushBaseVersion, syncedPartOf } from "./plan.ts";
import type { ServerNote, SyncPlan, SyncResolution } from "./plan.ts";

export type SyncOutcomeAction = "created" | "pushed" | "pulled" | "in-sync" | "conflict" | "failed";

export interface SyncOutcome {
  action: SyncOutcomeAction;
  /** 给人看的一句话，直接进通知。 */
  detail: string;
  /** 冲突时要给用户选的两边。 */
  conflict?: {
    noteId: string;
    server: ServerNote;
    localText: string;
    plan: SyncPlan;
  };
}

function serverNoteOf(note: Note): ServerNote {
  return {
    id: note.id,
    title: note.title,
    body: note.body,
    version: note.version,
    externalId: note.externalId,
  };
}

function blockOf(frontmatter: unknown): Record<string, unknown> {
  if (typeof frontmatter !== "object" || frontmatter === null) return {};
  const block = (frontmatter as Record<string, unknown>)["lazylearn"];
  if (typeof block !== "object" || block === null || Array.isArray(block)) return {};
  return block as Record<string, unknown>;
}

function kindOf(frontmatter: unknown): string | null {
  const kind = blockOf(frontmatter)["kind"];
  return typeof kind === "string" && kind !== "" ? kind : null;
}

async function writeMarker(app: App, file: TFile, marker: SyncMarker): Promise<void> {
  await app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
    writeSyncMarkerInto(frontmatter, marker);
  });
}

export interface SyncNoteOptions {
  /** 冲突时用户已经做的选择；不给就是「还没选」。 */
  resolution?: SyncResolution | null;
  /** 服务端那篇的标题；默认用文件名。 */
  title?: string;
}

/**
 * 同步一篇笔记。返回值里 `conflict` 非空时，调用方要让用户选一边再带着 `resolution` 回来。
 */
export async function syncNote(
  app: App,
  client: LazylearnClient,
  file: TFile,
  options: SyncNoteOptions = {},
): Promise<SyncOutcome> {
  try {
    const text = await app.vault.read(file);
    const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter;
    const kind = kindOf(frontmatter);
    const marker = readSyncMarker(frontmatter);
    const localHash = hashOfSyncedPart(text, kind);
    const title = options.title ?? file.basename;

    let server: ServerNote | null = null;
    if (marker !== null) {
      const found = await client.findNote(marker.noteId);
      server = found === null ? null : serverNoteOf(found);
    }

    const plan = planSync({
      marker,
      localHash,
      server,
      resolution: options.resolution ?? null,
    });

    if (plan.action === "in-sync") {
      // 顺手把「上次同步时间」刷新一下：这一趟确实对过账了。
      await writeMarker(app, file, {
        noteId: marker!.noteId,
        version: server!.version,
        hash: localHash,
        at: new Date().toISOString(),
      });
      return { action: "in-sync", detail: "两边一致，不用动" };
    }

    if (plan.action === "conflict") {
      return {
        action: "conflict",
        detail: plan.reason,
        conflict: { noteId: marker!.noteId, server: server!, localText: text, plan },
      };
    }

    if (plan.action === "pull") {
      const pulled = applySyncedPart(text, kind, server!.body);
      await app.vault.process(file, () => pulled);
      await writeMarker(app, file, {
        noteId: marker!.noteId,
        version: server!.version,
        hash: hashOfSyncedPart(pulled, kind),
        at: new Date().toISOString(),
      });
      return { action: "pulled", detail: `已用服务端那一版（v${server!.version}）更新本地` };
    }

    // push / create 都是「把本地这一段交上去」。
    const body = syncedPartOf(text, kind).trim();
    let updated: Note;
    if (plan.action === "create") {
      const noteId = marker?.noteId ?? newNoteId(newUuid());
      try {
        updated = await client.createNote({ title, body, externalId: noteId });
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          // 这个标识在服务端已经有主了（比如 frontmatter 丢过一次）：不猜该听谁的，
          // 把当前那一版取回来交给用户选。
          const existing = await client.findNote(noteId);
          if (existing === null) throw error;
          return {
            action: "conflict",
            detail: "服务端已经有对应的那一篇了，先选一个",
            conflict: {
              noteId,
              server: serverNoteOf(existing),
              localText: text,
              plan: { action: "conflict", reason: "服务端已经有对应的那一篇" },
            },
          };
        }
        throw error;
      }
    } else {
      const base = pushBaseVersion(plan, server);
      try {
        updated = await client.updateNote(server!.id, {
          title,
          body,
          baseVersion: base ?? server!.version,
        });
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          const existing = await client.findNote(marker!.noteId);
          if (existing === null) throw error;
          return {
            action: "conflict",
            detail: "刚读到的那一版又变了，先选一个",
            conflict: {
              noteId: marker!.noteId,
              server: serverNoteOf(existing),
              localText: text,
              plan: { action: "conflict", reason: "服务端又往前走了一版" },
            },
          };
        }
        throw error;
      }
    }

    await writeMarker(app, file, {
      noteId: marker?.noteId ?? updated.externalId ?? "",
      version: updated.version,
      hash: body === "" ? fnv1a("") : hashOfSyncedPart(text, kind),
      at: new Date().toISOString(),
    });
    return plan.action === "create"
      ? { action: "created", detail: `已在懒学建了对应的一篇（v${updated.version}）` }
      : { action: "pushed", detail: `本地这一版已推上去（v${updated.version}）` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { action: "failed", detail: `同步失败：${message}` };
  }
}