/**
 * 错题归档的**纯**渲染层：给定题目内容与已有笔记正文，算出新的正文。
 * 不碰 vault（那在 archive.ts），所以 smoke 能直接把它跑穿。
 *
 * 笔记的形状：
 * ```
 * ---
 * lazylearn: {…}
 * ---
 * # 题干标题
 *
 * <!-- lazylearn:managed:start -->
 * 题面 / 选项 / 答案 / 解析（服务端下发的那一份，整块由插件维护）
 * <!-- lazylearn:managed:end -->
 *
 * ## 我的错因
 * （用户自己写，插件永不覆盖）
 *
 * ## 下次怎么识别
 * ```
 * 托管块用 HTML 注释标出来，是为了让「哪一段会被覆盖」在阅读视图里也看得见。
 */

import { rewriteMediaRefs } from "../api/media.ts";
import { fnv1a } from "../lib/hash.ts";
import type { ErrorCard, QuestionCard, RevealPayload } from "../api/contracts.ts";
import { formatAnswer } from "../api/contracts.ts";

export const MANAGED_START = "<!-- lazylearn:managed:start -->";
export const MANAGED_END = "<!-- lazylearn:managed:end -->";

/** 个人段落：正文块之外的固定小标题。缺了就补，有内容就一个字都不动。 */
export const PERSONAL_SECTIONS = ["## 我的错因", "## 下次怎么识别"] as const;

const EMPTY_PERSONAL = `${PERSONAL_SECTIONS[0]}\n\n${PERSONAL_SECTIONS[1]}\n`;

export type ManagedState =
  | { kind: "absent" }
  | { kind: "present"; text: string }
  /** 标记缺失/重复：这段内容到底归谁说不清，一律不覆盖。 */
  | { kind: "broken"; reason: string };

export interface SplitBody {
  /** 托管块之前的内容（含 frontmatter），原样保留。 */
  head: string;
  managed: ManagedState;
  /** 托管块之后的内容（个人段落），原样保留。 */
  tail: string;
}

/** 托管块的哈希：判断「这一段还是我们上次写的那一份吗」。 */
export function contentHash(text: string): string {
  return fnv1a(text);
}

export function splitBody(body: string): SplitBody {
  const startCount = body.split(MANAGED_START).length - 1;
  const endCount = body.split(MANAGED_END).length - 1;
  if (startCount === 0 && endCount === 0) {
    // 老档案（或用户自己新建的）没有托管块：整篇都是个人的，追加在末尾。
    return { head: body, managed: { kind: "absent" }, tail: "" };
  }
  if (startCount !== 1 || endCount !== 1) {
    return { head: "", managed: { kind: "broken", reason: "托管块标记重复或不成对" }, tail: "" };
  }
  const startAt = body.indexOf(MANAGED_START);
  const endAt = body.indexOf(MANAGED_END);
  if (endAt < startAt) {
    return { head: "", managed: { kind: "broken", reason: "结束标记在开始标记之前" }, tail: "" };
  }
  return {
    head: body.slice(0, startAt),
    managed: { kind: "present", text: body.slice(startAt + MANAGED_START.length, endAt) },
    tail: body.slice(endAt + MANAGED_END.length),
  };
}

/** 托管块里的正文（题面 + 选项 + 允许访问的答案与解析）。 */
export function renderManaged(
  card: QuestionCard,
  reveal: RevealPayload | null,
  mediaRewrite: ReadonlyMap<string, string> = new Map(),
): string {
  const parts: string[] = [];
  parts.push(rewriteMediaRefs(card.stem.trim(), mediaRewrite));
  if (card.options.length > 0) {
    parts.push(
      card.options
        .map((option) => `- **${option.key}.** ${rewriteMediaRefs(option.text.trim(), mediaRewrite)}`)
        .join("\n"),
    );
  }

  const reference = reveal === null ? "" : formatAnswer(reveal.answer).trim();
  if (reference !== "") parts.push(`**正确答案**：${reference}`);
  if (reveal?.trick) parts.push(`**技巧**：${rewriteMediaRefs(reveal.trick.trim(), mediaRewrite)}`);
  if (reveal?.analysis) parts.push(rewriteMediaRefs(reveal.analysis.trim(), mediaRewrite));
  if (reveal?.aiAnalysis) parts.push(rewriteMediaRefs(reveal.aiAnalysis.trim(), mediaRewrite));
  if (reveal === null) {
    parts.push("（解析没取到：这一档看不到，或这道题还没有解析。到原站看。）");
  }
  return parts.join("\n\n").trim();
}

/** 笔记标题用题干第一行；题干只有公式时退回题号。 */
export function renderTitle(card: QuestionCard | ErrorCard): string {
  const question = "question" in card ? card.question : card;
  const first = question.stem.trim().split("\n")[0] ?? "";
  const heading = first.replace(/^[#>\s]+/, "").trim();
  const short = heading.length > 60 ? `${heading.slice(0, 60)}…` : heading;
  return short === "" ? `错题 ${question.id}` : short;
}

/** 归档正文：托管块 + 个人段落。`existing` 为 null = 新建。 */
export function buildBody(existing: string | null, managedText: string): string {
  const block = `${MANAGED_START}\n${managedText}\n${MANAGED_END}`;
  if (existing === null || existing.trim() === "") {
    return `${block}\n\n${EMPTY_PERSONAL}`;
  }
  const split = splitBody(existing);
  if (split.managed.kind === "absent") {
    return `${split.head.replace(/\s+$/, "")}\n\n${block}\n\n${EMPTY_PERSONAL}`;
  }
  if (split.managed.kind === "broken") {
    // 判不清就不动它；调用方会把这当成冲突报给用户。
    return existing;
  }
  return `${split.head.replace(/\s+$/, "")}\n\n${block}\n\n${ensurePersonalSections(split.tail)}`;
}

/** 个人段落缺了就补上，已经有内容（哪怕是空的标题）就原样留着。 */
export function ensurePersonalSections(tail: string): string {
  let text = tail.replace(/^\s+/, "").replace(/\s+$/, "");
  for (const heading of PERSONAL_SECTIONS) {
    if (!text.includes(heading)) {
      text = text === "" ? `${heading}\n` : `${text}\n\n${heading}\n`;
    }
  }
  return `${text}\n`;
}

export interface ArchiveDecision {
  action: "create" | "update" | "skip" | "conflict";
  /** 给人看的一句话（跳过/冲突时用它解释原因）。 */
  reason: string;
  body: string | null;
}

/**
 * 该不该覆盖这一篇。四条规则：
 * - 没写过 → 新建；
 * - 写过、托管块内容一模一样 → 跳过（重复导入不新增，也不重写，mtime 不动）；
 * - 写过、托管块还是我们上次写的那一份 → 覆盖（服务端改了题面/解析，跟着更新）；
 * - 托管块被用户改过、或标记坏了 → 冲突，一个字都不动，报给用户。
 */
export function decideArchive(
  existing: { body: string; managedHash: string | null } | null,
  managedText: string,
): ArchiveDecision {
  if (existing === null) {
    return { action: "create", reason: "新建", body: buildBody(null, managedText) };
  }
  const split = splitBody(existing.body);
  if (split.managed.kind === "broken") {
    return { action: "conflict", reason: split.managed.reason, body: null };
  }
  const trimmed = managedText.trim();
  const currentText = split.managed.kind === "present" ? split.managed.text.trim() : null;
  if (currentText !== null && currentText === trimmed) {
    return { action: "skip", reason: "内容没变", body: null };
  }
  // 能覆盖的两个前提：托管块还是我们上次写的那一份（哈希对得上），
  // 或者老档案根本没有托管块（插件早期版本/用户手抄的）——第一次归档给它补上，
  // 个人正文整段留在下面。其余情况一律当冲突，一个字不动。
  const canOverwrite =
    (currentText !== null && existing.managedHash !== null && existing.managedHash === contentHash(currentText)) ||
    (split.managed.kind === "absent" && existing.managedHash === null);
  if (!canOverwrite) {
    return { action: "conflict", reason: "托管块被改过，插件不覆盖这一篇", body: null };
  }
  return {
    action: "update",
    reason: split.managed.kind === "absent" ? "补上托管块" : "服务端内容有更新",
    body: buildBody(existing.body, trimmed),
  };
}

/** 归档路径：`<root>/<服务·账号>/<学科>/<questionId>.md`。 */
export function archivePath(root: string, accountTag: string, subject: string, questionId: string): string {
  // 根目录允许带子目录（用户可能想放到 `LazyLearn/错题`），但它必须落在 vault 里：
  // 开头的 `../` 一律剥掉。其余三段**必须是一片叶子**——它们里有 `/` 或 `..`
  // 就等于让服务端下发的 id 决定文件写到哪儿。
  const base = root.replace(/\\/g, "/").replace(/^(\.\.\/)+/, "").replace(/^\/+|\/+$/g, "");
  const segment = (part: string): string => {
    const cleaned = part.replace(/[\\/:*?"<>|]/g, "_").replace(/^\.+$/, "_");
    return cleaned === "" ? "_" : cleaned;
  };
  return [base, segment(accountTag), segment(subject), `${segment(questionId)}.md`].join("/");
}

/** 服务 + 账号的目录名：一眼看出「这是哪个站的哪个号」。 */
export function accountTagFor(baseUrl: string, userId: string): string {
  let host = baseUrl;
  try {
    host = new URL(baseUrl).host;
  } catch {
    // 地址不规范（用户手写）就退回原串，后面还会清洗字符。
  }
  return `${host}-${userId}`;
}