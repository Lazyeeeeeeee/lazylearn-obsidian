/**
 * 双向同步的**决策**：只回答「这一次该干什么」，不碰 vault、不发请求。
 *
 * 一句话规则：**谁改了谁说话，两边都改了就别动**。
 * 判定靠两个数——frontmatter 里记的「上次说定的服务端版本」和「上次说定的内容哈希」：
 * - 服务端版本 != 当前版本 → 服务端动过
 * - 本地内容哈希 != 记下来的哈希 → 本地动过
 * 四种组合正好对应：没动（in-sync）、只本地动（push）、只服务端动（pull）、都动（conflict）。
 */

import { MANAGED_END } from "../export/render-note.ts";
import { fnv1a } from "../lib/hash.ts";
import type { SyncMarker } from "./marker.ts";

export type SyncAction = "create" | "push" | "pull" | "in-sync" | "conflict";

/** 冲突时用户已经做出的选择。 */
export type SyncResolution = "local" | "server";

export interface ServerNote {
  id: string;
  title: string;
  body: string;
  version: number;
  externalId: string | null;
}

export interface SyncPlanInput {
  marker: SyncMarker | null;
  /** 本地「会被同步的那一段」的哈希（不是整篇文件——frontmatter 不参与同步）。 */
  localHash: string;
  server: ServerNote | null;
  resolution?: SyncResolution | null;
}

export interface SyncPlan {
  action: SyncAction;
  /** 给人看的一句话，直接进通知。 */
  reason: string;
}

export function planSync(input: SyncPlanInput): SyncPlan {
  const { marker, localHash, server, resolution = null } = input;

  if (marker === null) {
    // 还没开过同步：第一次就是把本地这篇推上去（服务端不该已经有对应那一篇）。
    return { action: "create", reason: "第一次同步：把这篇笔记推到懒学" };
  }
  if (server === null) {
    // 服务端那篇不在了（被删了）。按本地重建，而不是把本地的同步记录也清掉——
    // 用户看到的应该是「它又回去了」，不是「同步悄悄关掉了」。
    return { action: "create", reason: "服务端那篇不在了，按本地重建一篇" };
  }
  if (resolution === "local") {
    return { action: "push", reason: "按你的选择：用本地覆盖服务端" };
  }
  if (resolution === "server") {
    return { action: "pull", reason: "按你的选择：用服务端覆盖本地" };
  }

  const localChanged = localHash !== marker.hash;
  const serverChanged = server.version !== marker.version;
  if (!localChanged && !serverChanged) return { action: "in-sync", reason: "两边一致" };
  if (localChanged && !serverChanged) return { action: "push", reason: "只有本地改了" };
  if (!localChanged && serverChanged) return { action: "pull", reason: "只有服务端改了" };
  return { action: "conflict", reason: "本地和服务端都改了，先选一个" };
}

/** 服务端版本给 push 用：有服务端那一篇就带它的版本（条件写），否则不带。 */
export function pushBaseVersion(plan: SyncPlan, server: ServerNote | null): number | null {
  if (plan.action !== "push") return null;
  return server?.version ?? null;
}

// --- 「哪一段算同步单位」 ---

export interface NoteParts {
  /** 开头的 YAML frontmatter（含两端的 --- 与尾随换行）；没有就是空串。 */
  frontmatter: string;
  /** 其余部分。 */
  body: string;
}

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/;

/** 拆出 frontmatter。它**不参与同步**：服务端不该看到你的标签、别名和插件状态。 */
export function splitFrontmatter(text: string): NoteParts {
  const match = FRONTMATTER.exec(text);
  if (match === null) return { frontmatter: "", body: text };
  return { frontmatter: text.slice(0, match[0].length), body: text.slice(match[0].length) };
}

/**
 * 这篇笔记里**属于人的那一段**。
 *
 * 普通笔记：正文全部。归档笔记（`kind: error-archive`）：托管块之后的部分——
 * 题面/选项/答案/解析是服务端自己下发的东西，同步上去只会制造一份会漂移的副本；
 * 而「我的错因」正是要双向的那一段。
 */
export function syncedPartOf(text: string, kind: string | null): string {
  const { body } = splitFrontmatter(text);
  if (kind !== "error-archive") return body;
  const endAt = body.indexOf(MANAGED_END);
  if (endAt === -1) return body;
  return body.slice(endAt + MANAGED_END.length);
}

export function hashOfSyncedPart(text: string, kind: string | null): string {
  return fnv1a(syncedPartOf(text, kind).trim());
}

/**
 * 把服务端那一版写回整篇文件：frontmatter 与（归档笔记的）托管块都原样留着，
 * 只换「属于人的那一段」。
 */
export function applySyncedPart(text: string, kind: string | null, pulled: string): string {
  const { frontmatter, body } = splitFrontmatter(text);
  const tail = pulled.replace(/^\s+/, "").replace(/\s+$/, "");
  if (kind !== "error-archive") {
    return tail === "" ? frontmatter : `${frontmatter}${tail}\n`;
  }
  const endAt = body.indexOf(MANAGED_END);
  if (endAt === -1) {
    // 托管块不见了（用户删了？）：不猜，原样留着，只把同步进来的那段接在后面。
    return `${frontmatter}${body}${body.endsWith("\n") ? "" : "\n"}\n${tail}\n`;
  }
  const kept = body.slice(0, endAt + MANAGED_END.length);
  return `${frontmatter}${kept}\n\n${tail}\n`;
}