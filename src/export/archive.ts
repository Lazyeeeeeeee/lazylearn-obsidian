/**
 * 归档落地：把一道错题写成（或更新成）vault 里的一篇笔记。
 *
 * 三件事分开：**找**（索引 → 已归档的是哪一篇）、**判**（建/覆盖/跳过/冲突，规则在
 * render-note.ts 里，纯函数，能单独测）、**写**（`Vault.process` 原子更新 + 认证下载附件）。
 *
 * 去重键是「服务地址 + 账号 + questionId」：换服务器、换账号是另一份档案，
 * 不会拿 A 站的题去覆盖 B 站同名题。索引也不是必须的——它是现从笔记 frontmatter 扫出来的，
 * 用户改名、移动、手动改正文都不影响认档案。
 */

import { normalizePath, TFile, type App } from "obsidian";

import type { LazylearnClient } from "../api/client.ts";
import type { ErrorCard, QuestionCard, RevealPayload } from "../api/contracts.ts";
import { assetFileName, mediaRefsIn } from "../api/media.ts";
import {
  accountTagFor,
  archivePath,
  contentHash,
  decideArchive,
  renderManaged,
} from "./render-note.ts";

export type ArchiveOutcome = "created" | "updated" | "skipped" | "conflict" | "failed";

export interface ArchiveResult {
  questionId: string;
  /** 落到哪儿了（冲突/失败时是「本该落到哪儿」）。 */
  path: string;
  outcome: ArchiveOutcome;
  reason: string;
}

export interface ArchiveContext {
  app: App;
  client: LazylearnClient;
  /** 归档根目录（相对 vault）。 */
  root: string;
  baseUrl: string;
  userId: string;
  subject: string;
}

interface ExistingNote {
  file: TFile;
  body: string;
  managedHash: string | null;
}

function bindingBlock(app: App, file: TFile): Record<string, unknown> | null {
  const raw = app.metadataCache.getFileCache(file)?.frontmatter;
  if (typeof raw !== "object" || raw === null) return null;
  const block = (raw as Record<string, unknown>)["lazylearn"];
  if (typeof block !== "object" || block === null || Array.isArray(block)) return null;
  return block as Record<string, unknown>;
}

/**
 * 扫一遍 vault，把「这个服务 + 这个账号已归档的题」做成索引：questionId → 文件。
 *
 * 走 metadataCache（内存里的），不读盘，几千篇也只是几毫秒。用户改名、移动、
 * 甚至改正文都不影响——认档案靠的是 frontmatter 里的三个字段，不是路径。
 * 同一批导入共用一份索引，扫一次就够。
 */
export function buildArchiveIndex(app: App, baseUrl: string, userId: string): Map<string, TFile> {
  const index = new Map<string, TFile>();
  for (const file of app.vault.getMarkdownFiles()) {
    const block = bindingBlock(app, file);
    if (block === null) continue;
    if (block["baseUrl"] !== baseUrl || block["userId"] !== userId) continue;
    const questionId = block["questionId"];
    if (typeof questionId !== "string" || questionId === "") continue;
    index.set(questionId, file);
  }
  return index;
}

async function readExisting(app: App, file: TFile): Promise<ExistingNote> {
  const body = await app.vault.cachedRead(file);
  const hash = bindingBlock(app, file)?.["managedHash"];
  return { file, body, managedHash: typeof hash === "string" ? hash : null };
}

/**
 * 找到「这道题已经归档到哪一篇」，没有就返回 null。
 *
 * 两条路，都是为了不让归档变成覆盖别人东西的动作：
 * 1. 索引里那一篇（靠 frontmatter 认，改名移动都还在）。读不到说明索引过期了
 *    （文件被移走/删掉），就当没归档过，然后把这条过期项剔掉。
 * 2. 索引里没有，但**目标路径上已经有一篇**：没有绑定就接管它（用户手抄的、或早期版本写的），
 *    绑定是同一个账号同一道题也接管。绑的是别人（换个账号/另一道题）/就报冲突，
 *    不往上面写一个字。
 */
async function resolveExisting(
  context: ArchiveContext,
  card: QuestionCard,
  notePath: string,
  index: Map<string, TFile>,
): Promise<ExistingNote | null> {
  const known = index.get(card.id);
  if (known !== undefined) {
    try {
      return await readExisting(context.app, known);
    } catch {
      index.delete(card.id);
    }
  }
  const atPath = context.app.vault.getAbstractFileByPath(notePath);
  if (!(atPath instanceof TFile)) return null;
  const block = bindingBlock(context.app, atPath);
  if (block === null) return readExisting(context.app, atPath);
  const sameArchive =
    block["baseUrl"] === context.baseUrl &&
    block["userId"] === context.userId &&
    block["questionId"] === card.id;
  if (sameArchive) return readExisting(context.app, atPath);
  throw new Error("这个路径上已经有另一份档案（别的账号或别的题），换个归档目录");
}

async function ensureFolder(app: App, folder: string): Promise<void> {
  if (folder === "" || app.vault.getAbstractFileByPath(folder) !== null) return;
  // 建目录失败（并发已建、权限）不算错：接下来那次写入会给出真正的原因。
  await app.vault.createFolder(folder).catch(() => undefined);
}

/** 笔记所在目录与不带扩展名的文件名。 */
function splitNotePath(path: string): { dir: string; base: string } {
  const slash = path.lastIndexOf("/");
  const dir = slash === -1 ? "" : path.slice(0, slash);
  const name = slash === -1 ? path : path.slice(slash + 1);
  return { dir, base: name.replace(/\.md$/i, "") };
}

/**
 * 题干与选项里的媒体下载到 `<笔记目录>/<笔记名>/assets/`，
 * 返回「服务端地址 → 笔记里的相对路径」映射，正文渲染时照它改写引用。
 *
 * 单张图取不到不让整道题失败：正文照写、引用留着原地址（阅读视图里点得开）。
 */
async function fetchAssets(
  context: ArchiveContext,
  notePath: string,
  card: QuestionCard,
  reveal: RevealPayload | null,
): Promise<Map<string, string>> {
  const refs = mediaRefsIn(
    card.stem,
    ...card.options.map((option) => option.text),
    reveal?.trick ?? null,
    reveal?.analysis ?? null,
    reveal?.aiAnalysis ?? null,
  );
  const mapping = new Map<string, string>();
  if (refs.length === 0) return mapping;

  const { dir, base } = splitNotePath(notePath);
  const folder = normalizePath(dir === "" ? `${base}/assets` : `${dir}/${base}/assets`);
  await ensureFolder(context.app, folder);

  for (const ref of refs) {
    const target = normalizePath(`${folder}/${assetFileName(ref.objectKey)}`);
    try {
      if (context.app.vault.getAbstractFileByPath(target) === null) {
        await context.app.vault.createBinary(target, await context.client.media(ref.objectKey));
      }
      // 相对当前笔记：Obsidian 按笔记所在目录解析链接，写相对路径最稳。
      mapping.set(ref.url, `./${base}/assets/${assetFileName(ref.objectKey)}`);
    } catch {
      // 见函数注释：跳过这一张，引用保持原样。
    }
  }
  return mapping;
}

interface ArchiveMetadata {
  card: QuestionCard;
  baseUrl: string;
  userId: string;
  subject: string;
  managedText: string;
}

async function writeMetadata(app: App, file: TFile, metadata: ArchiveMetadata): Promise<void> {
  await app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
    frontmatter["lazylearn"] = {
      schema: 1,
      kind: "error-archive",
      questionId: metadata.card.id,
      baseUrl: metadata.baseUrl,
      userId: metadata.userId,
      subject: metadata.subject,
      taxonomyIds: [...metadata.card.taxonomyIds],
      managedHash: contentHash(metadata.managedText.trim()),
      archivedAt: new Date().toISOString(),
    };
  });
}

/** 归档一道题。`reveal` 为 null 时只写题面（解析留一句说明，事后可以再归档一次补上）。 */
export async function archiveCard(
  context: ArchiveContext,
  card: QuestionCard,
  reveal: RevealPayload | null,
  index: Map<string, TFile>,
): Promise<ArchiveResult> {
  const accountTag = accountTagFor(context.baseUrl, context.userId);
  const target = archivePath(context.root, accountTag, context.subject, card.id);
  try {
    const existing = await resolveExisting(context, card, target, index);
    const notePath = existing?.file.path ?? target;

    const mediaMapping = await fetchAssets(context, notePath, card, reveal);
    const managedText = renderManaged(card, reveal, mediaMapping);
    const decision = decideArchive(existing, managedText);
    if (decision.action === "conflict" || decision.action === "skip") {
      return {
        questionId: card.id,
        path: notePath,
        outcome: decision.action === "skip" ? "skipped" : "conflict",
        reason: decision.reason,
      };
    }

    let file: TFile;
    if (existing === null) {
      await ensureFolder(context.app, notePath.replace(/\/[^/]+$/, ""));
      file = await context.app.vault.create(notePath, decision.body ?? "");
      index.set(card.id, file);
    } else {
      // process：读改写在一个原子步骤里，同步或别的插件同时动这篇也不会写出半截。
      await context.app.vault.process(existing.file, () => decision.body ?? existing.body);
      file = existing.file;
    }
    await writeMetadata(context.app, file, {
      card,
      baseUrl: context.baseUrl,
      userId: context.userId,
      subject: context.subject,
      managedText,
    });
    return {
      questionId: card.id,
      path: file.path,
      outcome: decision.action === "create" ? "created" : "updated",
      reason: decision.reason,
    };
  } catch (error) {
    return {
      questionId: card.id,
      path: target,
      outcome: "failed",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * 把一条错题卡（复习卡）补成完整题目：卡面已有题面，答案与解析另外揭晓。
 * 取不到解析（非会员档的官方卡、题已删）不挡归档——题面照存，留一句说明。
 */
export async function materializeErrorCard(
  client: LazylearnClient,
  card: ErrorCard,
): Promise<{ card: QuestionCard; reveal: RevealPayload | null }> {
  try {
    // 复习场景：错题本里的卡本来就允许先看答案，服务端 review=1 放行。
    return { card: card.question, reveal: await client.reveal(card.questionId, { review: true }) };
  } catch {
    return { card: card.question, reveal: null };
  }
}

/** 给 vault 里那篇笔记的路径（测试与提示文案要用的），避免调用方各写一份。 */
export function archiveTargetPath(context: ArchiveContext, questionId: string): string {
  return archivePath(
    context.root,
    accountTagFor(context.baseUrl, context.userId),
    context.subject,
    questionId,
  );
}

