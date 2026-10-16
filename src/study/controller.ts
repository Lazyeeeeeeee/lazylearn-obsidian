/**
 * 侧栏背后的状态机：会话、绑定、取题都从这里走，视图只负责画。
 *
 * 两条硬约束：
 * 1. 侧栏永远只反映「当前笔记」的绑定。切笔记就把上一本的半截请求作废
 *    （`#generation`），否则旧响应回来会把 A 的知识点画到 B 上。
 * 2. 认证失败（401）当场清会话：token 过期了不该反复拿它去撞。
 */

import type { App, TFile } from "obsidian";

import { ApiError, LazylearnClient } from "../api/client.ts";
import type { Account, TaxonomyNode } from "../api/contracts.ts";
import type { HttpTransport } from "../api/transport.ts";
import { clearToken, readToken, saveToken } from "../auth/session.ts";
import type { SecretStore } from "../auth/session.ts";
import { examScopeLabel, subjectLabel } from "../settings.ts";
import type { LazylearnSettings } from "../settings.ts";
import type { QuestionCard } from "../api/contracts.ts";
import { archiveCard, buildArchiveIndex, materializeErrorCard } from "../export/archive.ts";
import type { ArchiveContext, ArchiveResult } from "../export/archive.ts";
import { readSyncMarker } from "../sync/marker.ts";
import type { SyncMarker } from "../sync/marker.ts";
import { syncNote } from "../sync/note-sync.ts";
import type { SyncOutcome } from "../sync/note-sync.ts";
import type { SyncResolution } from "../sync/plan.ts";
import * as Answering from "./answering.ts";
import type { AnswerState } from "./answering.ts";
import { clearNoteBinding, readNoteBinding, writeNoteBinding } from "./bind-topic.ts";
import { rebind, sameBinding, withTaxonomyId } from "./binding.ts";
import type { TopicBinding } from "./binding.ts";
import { QUESTIONS_PER_ROUND, hasMore, mergePage, nextTopicIds, startRound } from "./practice.ts";
import type { TopicRound } from "./practice.ts";

export type StudyPhase = "signed-out" | "loading" | "ready" | "error";

/** 导入错题时一页取多少张。服务端上限 100；50 够快也够稳。 */
const ERROR_PAGE_SIZE = 50;

function describeArchive(result: ArchiveResult): string {
  const where = result.path;
  if (result.outcome === "created") return `已归档到 ${where}`;
  if (result.outcome === "updated") return `已更新 ${where}（${result.reason}）`;
  if (result.outcome === "skipped") return `跳过：${where} 已经是最新的`;
  if (result.outcome === "conflict") return `没动 ${where}：${result.reason}`;
  return `归档失败：${result.reason}`;
}

function describeImport(progress: ImportProgress, cancelled: boolean): string {
  const head = cancelled ? `导入已取消（扫到 ${progress.done} 张）` : `导入完成（${progress.done} 张）`;
  return [
    head,
    `新增 ${progress.created}`,
    `更新 ${progress.updated}`,
    `跳过 ${progress.skipped}`,
    `冲突 ${progress.conflict}`,
    `失败 ${progress.failed}`,
  ]
    .filter((part) => part !== "")
    .join("，");
}

export interface StudySnapshot {
  phase: StudyPhase;
  message: string | null;
  baseUrl: string;
  account: Account | null;
  notePath: string | null;
  noteName: string | null;
  binding: TopicBinding | null;
  /** 知识点 id → 名称，来自最近一次拉到的树；查不到就显示 id。 */
  taxonomyNames: Record<string, string>;
  round: TopicRound;
  loadingMore: boolean;
  /** 题目 id → 作答状态。跟着 round 一起清：换笔记不该留着上一本的判分。 */
  answers: Readonly<Record<string, AnswerState>>;
  /** 正在导入错题本的进度；不在导入时为 null。 */
  importing: ImportProgress | null;
  /** 当前笔记的双向同步本子；没开过同步就是 null。 */
  syncMarker: SyncMarker | null;
}

/** 一轮导入的读数：总共扫到多少张、各种去向各多少。 */
export interface ImportProgress {
  done: number;
  total: number;
  created: number;
  updated: number;
  skipped: number;
  conflict: number;
  failed: number;
}

export interface StudyHooks {
  app: App;
  secrets: SecretStore;
  transport: HttpTransport;
  /** 每次要用设置时现读，设置页改完立刻生效。 */
  settings: () => LazylearnSettings;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

export class StudyController {
  #hooks: StudyHooks;
  #snapshot: StudySnapshot;
  #listeners: Set<(snapshot: StudySnapshot) => void> = new Set();
  #generation = 0;
  #taxonomyKey: string | null = null;
  #taxonomy: TaxonomyNode[] = [];
  /** 导入循环的开关。false = 用户按了取消，或这一轮已经收尾。 */
  #importing = false;
  #importCancelled = false;
  #indexKey: string | null = null;
  #index: Map<string, TFile> | null = null;

  constructor(hooks: StudyHooks) {
    this.#hooks = hooks;
    this.#snapshot = {
      phase: "signed-out",
      message: null,
      baseUrl: hooks.settings().baseUrl,
      account: null,
      notePath: null,
      noteName: null,
      binding: null,
      taxonomyNames: {},
      round: startRound([]),
      loadingMore: false,
      answers: {},
      importing: null,
      syncMarker: null,
    };
  }

  get snapshot(): StudySnapshot {
    return this.#snapshot;
  }

  subscribe(listener: (snapshot: StudySnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #emit(patch: Partial<StudySnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...patch };
    for (const listener of this.#listeners) listener(this.#snapshot);
  }

  #settings(): LazylearnSettings {
    return this.#hooks.settings();
  }

  #client(token: string | null): LazylearnClient {
    return new LazylearnClient(this.#hooks.transport, this.#settings().baseUrl, token);
  }

  #token(): string | null {
    return readToken(this.#hooks.secrets, this.#settings().baseUrl);
  }

  /** 换服务器／换账号都会让已拉到的树变成别人的，作废掉。 */
  invalidateTaxonomy(): void {
    this.#taxonomyKey = null;
    this.#taxonomy = [];
  }

  async initialize(): Promise<void> {
    this.invalidateTaxonomy();
    if (this.#settings().baseUrl === "") {
      this.#emit({ phase: "signed-out", message: "还没填服务地址，去设置里填一下。", baseUrl: "" });
      return;
    }
    if (this.#token() === null) {
      this.#emit({ phase: "signed-out", message: null, baseUrl: this.#settings().baseUrl });
      return;
    }
    await this.refreshAccount();
  }

  async refreshAccount(): Promise<void> {
    const token = this.#token();
    if (token === null) {
      this.#emit({ phase: "signed-out", account: null, message: null });
      return;
    }
    const generation = ++this.#generation;
    this.#emit({ phase: "loading", message: null });
    try {
      const account = await this.#client(token).me();
      if (generation !== this.#generation) return;
      this.#emit({ phase: "ready", account, message: null, baseUrl: this.#settings().baseUrl });
      await this.#reloadRound();
    } catch (error) {
      if (generation !== this.#generation) return;
      if (error instanceof ApiError && error.isUnauthorized) {
        clearToken(this.#hooks.secrets, this.#settings().baseUrl);
        this.#emit({ phase: "signed-out", account: null, message: "登录已过期，请重新登录。" });
        return;
      }
      this.#emit({ phase: "error", account: null, message: errorMessage(error) });
    }
  }

  async signIn(username: string, password: string): Promise<void> {
    const baseUrl = this.#settings().baseUrl;
    if (baseUrl === "") {
      this.#emit({ phase: "error", message: "先填服务地址，再登录。" });
      return;
    }
    const generation = ++this.#generation;
    this.#emit({ phase: "loading", message: "正在登录…", baseUrl });
    try {
      const token = await this.#client(null).login(username, password);
      saveToken(this.#hooks.secrets, baseUrl, token);
      if (generation !== this.#generation) return;
      this.invalidateTaxonomy();
      await this.refreshAccount();
    } catch (error) {
      if (generation !== this.#generation) return;
      this.#emit({ phase: "error", message: errorMessage(error) });
    }
  }

  async signOut(): Promise<void> {
    const token = this.#token();
    ++this.#generation;
    clearToken(this.#hooks.secrets, this.#settings().baseUrl);
    this.invalidateTaxonomy();
    this.#emit({
      phase: "signed-out",
      account: null,
      message: null,
      binding: null,
      round: startRound([]),
      taxonomyNames: {},
      answers: {},
    });
    if (token === null) return;
    try {
      // 服务端那条会话要作废，否则「退出」只是本地装装样子。
      await this.#client(token).logout();
    } catch {
      // 退出失败不影响本地已登出的事实：网络断了也该能退出。
    }
  }

  /**
   * 当前笔记变了：绑定跟着换，上一本的取题结果当场丢掉。
   * 同一篇笔记 + 同一份绑定就什么都不做：metadataCache 的 changed 在正文每次保存时都会响，
   * 不挡的话「打字」就等于「重新取题」。
   */
  setActiveNote(file: TFile | null): void {
    const path = file?.path ?? null;
    const binding = file === null ? null : readNoteBinding(this.#hooks.app, file);
    // 同步本子在 frontmatter 里：切笔记时顺手读出来给侧栏显示（纯本地，不发请求）。
    const syncMarker =
      file === null ? null : readSyncMarker(this.#hooks.app.metadataCache.getFileCache(file)?.frontmatter);
    if (path === this.#snapshot.notePath && sameBinding(binding, this.#snapshot.binding)) {
      if (syncMarker?.noteId !== this.#snapshot.syncMarker?.noteId || syncMarker?.version !== this.#snapshot.syncMarker?.version) {
        this.#emit({ syncMarker });
      }
      return;
    }
    ++this.#generation;
    this.#emit({
      notePath: path,
      noteName: file?.basename ?? null,
      binding,
      syncMarker,
      round: startRound([]),
      loadingMore: false,
      answers: {},
      message: null,
    });
    // 启动时账号还没验过：取题交给 initialize()，别在这里抢跑一次（会白拉一遍）。
    if (this.#snapshot.account !== null && binding !== null) void this.#reloadRound();
  }

  /** 重新按当前绑定拉第一页（命令「重新取题」也走它）。 */
  async reload(): Promise<void> {
    await this.#reloadRound();
  }

  async #reloadRound(): Promise<void> {
    const binding = this.#snapshot.binding;
    if (binding === null) {
      this.#emit({ round: startRound([]), answers: {} });
      return;
    }
    const generation = ++this.#generation;
    this.#emit({ round: startRound(binding.taxonomyIds), answers: {}, loadingMore: true, message: null });
    await this.#fetchPage(generation, false);
  }

  async loadMore(): Promise<void> {
    if (this.#snapshot.loadingMore) return;
    if (!hasMore(this.#snapshot.round)) return;
    const generation = this.#generation;
    this.#emit({ loadingMore: true });
    await this.#fetchPage(generation, true);
  }

  /**
   * 拉一页。多个绑定知识点时按顺序逐个请求：每个知识点各记各的 cursor，
   * 攒够 QUESTIONS_PER_ROUND 就停手（配额按「不同的题」算，多拉没意义）。
   */
  async #fetchPage(generation: number, append: boolean): Promise<void> {
    const binding = this.#snapshot.binding;
    const token = this.#token();
    if (binding === null || token === null) {
      this.#emit({ loadingMore: false });
      return;
    }
    const client = this.#client(token);
    let round = append ? this.#snapshot.round : startRound(binding.taxonomyIds);
    const pending = nextTopicIds(round);
    if (pending.length === 0) {
      this.#emit({ round, loadingMore: false });
      return;
    }
    for (const taxonomyId of pending) {
      if (round.cards.length >= QUESTIONS_PER_ROUND) break;
      const cursor = round.cursors[taxonomyId] ?? null;
      try {
        const page = await client.questions({
          taxonomyId,
          subject: binding.subject,
          examScope: binding.examScope,
          limit: QUESTIONS_PER_ROUND,
          ...(cursor === null ? {} : { cursor }),
        });
        if (generation !== this.#generation) return;
        round = mergePage(round, taxonomyId, page);
      } catch (error) {
        if (generation !== this.#generation) return;
        if (error instanceof ApiError && error.isUnauthorized) {
          clearToken(this.#hooks.secrets, this.#settings().baseUrl);
          this.#emit({ phase: "signed-out", account: null, loadingMore: false, message: "登录已过期，请重新登录。" });
          return;
        }
        const suffix =
          error instanceof ApiError && error.isThrottled ? "（今天的题库读取额度用完了，明天再来）" : "";
        // 已经取到的先留在屏上：429 是这一趟到头，不是这一批作废。
        this.#emit({ round, phase: "error", loadingMore: false, message: `${errorMessage(error)}${suffix}` });
        return;
      }
    }
    if (generation !== this.#generation) return;
    this.#emit({ round, loadingMore: false, phase: "ready" });
  }

  /** 知识点树（带缓存）。侧栏的绑定选择器与名称回显都用它。 */
  async loadTaxonomy(): Promise<TaxonomyNode[]> {
    const token = this.#token();
    const settings = this.#settings();
    if (token === null) return [];
    const key = `${settings.baseUrl}|${settings.subject}|${settings.examScope}`;
    if (this.#taxonomyKey === key) return this.#taxonomy;
    const nodes = await this.#client(token).taxonomy({ subject: settings.subject, examScope: settings.examScope });
    this.#taxonomyKey = key;
    this.#taxonomy = nodes;
    const names: Record<string, string> = { ...this.#snapshot.taxonomyNames };
    for (const node of nodes) names[node.id] = node.name;
    this.#emit({ taxonomyNames: names });
    return nodes;
  }

  /** 命令「绑定当前笔记知识点」选中一个节点后落到 frontmatter。 */
  async bindNode(node: TaxonomyNode): Promise<TopicBinding | null> {
    const file = this.#activeFile();
    if (file === null) {
      this.#emit({ message: "先打开一篇 Markdown 笔记，再绑定知识点。" });
      return null;
    }
    const settings = this.#settings();
    const current = this.#snapshot.binding;
    const sameExam =
      current !== null && current.subject === settings.subject && current.examScope === settings.examScope;
    const next = sameExam
      ? withTaxonomyId(current, node.id)
      : rebind(settings.subject, settings.examScope, node.id);
    try {
      await writeNoteBinding(this.#hooks.app, file, next);
    } catch (error) {
      this.#emit({ phase: "error", message: `写 frontmatter 失败：${errorMessage(error)}` });
      return null;
    }
    this.#emit({
      binding: next,
      notePath: file.path,
      noteName: file.basename,
      message: null,
      taxonomyNames: { ...this.#snapshot.taxonomyNames, [node.id]: node.name },
    });
    await this.#reloadRound();
    return next;
  }

  async unbindActiveNote(): Promise<boolean> {
    const file = this.#activeFile();
    if (file === null) {
      this.#emit({ message: "先打开一篇 Markdown 笔记。" });
      return false;
    }
    try {
      await clearNoteBinding(this.#hooks.app, file);
    } catch (error) {
      this.#emit({ phase: "error", message: `清除 frontmatter 失败：${errorMessage(error)}` });
      return false;
    }
    ++this.#generation;
    this.#emit({
      binding: null,
      round: startRound([]),
      answers: {},
      loadingMore: false,
      notePath: file.path,
      noteName: file.basename,
    });
    return true;
  }

  /** 某道题的作答状态；没答过就是「空着待答」。 */
  answerOf(cardId: string): AnswerState {
    return this.#snapshot.answers[cardId] ?? Answering.startAnswer();
  }

  /** 点一下选项：单选换、多选切；交过卷就不动（判断在纯函数里）。 */
  toggleOption(card: QuestionCard, key: string): void {
    const multiple = card.kind === "multiple_choice";
    this.#setAnswer(card.id, Answering.toggleOption(this.answerOf(card.id), key, multiple));
  }

  /**
   * 交一道题。界面在飞行中禁用按钮，这里再挡一道：服务端这条路径还没有幂等键，
   * 多按一次就真的多一笔 Attempt（多算一次错、多回流一次复习）。
   */
  async submitAnswer(card: QuestionCard): Promise<void> {
    const current = this.answerOf(card.id);
    if (!Answering.canSubmit(current)) return;
    const token = this.#token();
    if (token === null) {
      this.#setAnswer(card.id, Answering.failAnswer(current, "登录已过期，请重新登录。"));
      return;
    }
    const submitting = Answering.beginSubmit(current);
    this.#setAnswer(card.id, submitting);
    try {
      // 带上幂等键：这一笔超时后重发，服务端认得出是同一次，不会多记一笔。
      const result = await this.#client(token).submitChoice(
        card.id,
        submitting.selected,
        submitting.requestId ?? undefined,
      );
      this.#setAnswer(card.id, Answering.applySubmit(this.answerOf(card.id), result));
    } catch (error) {
      if (error instanceof ApiError && error.isUnauthorized) {
        clearToken(this.#hooks.secrets, this.#settings().baseUrl);
        this.#emit({ phase: "signed-out", account: null, message: "登录已过期，请重新登录。" });
        return;
      }
      this.#setAnswer(card.id, Answering.failAnswer(this.answerOf(card.id), errorMessage(error)));
    }
  }

  /** 揭晓答案与解析。只有交过卷才给点（服务端也是这么判的）。 */
  async revealAnswer(cardId: string): Promise<void> {
    if (this.answerOf(cardId).stage !== "submitted") return;
    const token = this.#token();
    if (token === null) return;
    try {
      this.#setAnswer(cardId, Answering.applyReveal(this.answerOf(cardId), await this.#client(token).reveal(cardId)));
    } catch (error) {
      // 揭晓失败不该把「已经交卷」这件事抹掉：只挂一句话。
      this.#setAnswer(cardId, Answering.noteError(this.answerOf(cardId), errorMessage(error)));
    }
  }

  #setAnswer(cardId: string, state: AnswerState): void {
    this.#emit({ answers: { ...this.#snapshot.answers, [cardId]: state } });
  }

  /** 归档一道题（侧栏每张卡上那个按钮）。 */
  async archiveOne(card: QuestionCard): Promise<ArchiveResult | null> {
    const index = await this.#archiveIndex();
    if (index === null) return null;
    const answer = this.answerOf(card.id);
    // 已经揭晓过就直接用手里那份；否则现取（练习场景答过就能取）。
    let reveal = answer.reveal;
    if (reveal === null) {
      const token = this.#token();
      if (token === null) return null;
      try {
        reveal = await this.#client(token).reveal(card.id, { review: true });
      } catch (error) {
        this.#emit({ message: `取解析失败，只归档题面：${errorMessage(error)}` });
      }
    }
    const result = await archiveCard(this.#archiveContext(), card, reveal, index);
    this.#emit({ message: describeArchive(result) });
    return result;
  }

  /**
   * 导入错题本：一页页扫，逐题归档。可随时取消（`cancelImport`），
   * 取消后已经写进去的档案留着——它们是有效的，下次再来只会跳过。
   */
  async importErrors(): Promise<ImportProgress | null> {
    if (this.#snapshot.importing !== null) return null;
    const token = this.#token();
    const account = this.#snapshot.account;
    if (token === null || account === null) {
      this.#emit({ message: "先登录，再导入错题。" });
      return null;
    }
    const index = await this.#archiveIndex();
    if (index === null) return null;
    const context = this.#archiveContext();
    const progress: ImportProgress = {
      done: 0,
      total: 0,
      created: 0,
      updated: 0,
      skipped: 0,
      conflict: 0,
      failed: 0,
    };
    this.#importing = true;
    this.#emit({ importing: { ...progress }, message: null });
    let cursor: string | null = null;
    try {
      while (this.#importing) {
        const page = await this.#client(token).errorCards({
          subject: context.subject,
          limit: ERROR_PAGE_SIZE,
          cursor,
        });
        for (const card of page.items) {
          if (!this.#importing) break;
          const materialized = await materializeErrorCard(this.#client(token), card);
          const result = await archiveCard(context, materialized.card, materialized.reveal, index);
          progress.done += 1;
          if (result.outcome === "created") progress.created += 1;
          else if (result.outcome === "updated") progress.updated += 1;
          else if (result.outcome === "skipped") progress.skipped += 1;
          else if (result.outcome === "conflict") progress.conflict += 1;
          else progress.failed += 1;
          this.#emit({ importing: { ...progress } });
        }
        cursor = page.nextCursor;
        if (cursor === null) break;
      }
    } catch (error) {
      if (error instanceof ApiError && error.isUnauthorized) {
        clearToken(this.#hooks.secrets, this.#settings().baseUrl);
        this.#emit({ phase: "signed-out", account: null, message: "登录已过期，请重新登录。" });
        return null;
      }
      this.#emit({ message: `导入中断：${errorMessage(error)}` });
    } finally {
      this.#importing = false;
      this.#emit({ importing: null, message: describeImport(progress, this.#importCancelled) });
      this.#importCancelled = false;
    }
    return progress;
  }

  /** 取消这一轮导入：已经写完的档案留着，下一次只会跳过它们。 */
  cancelImport(): void {
    if (this.#snapshot.importing === null) return;
    this.#importing = false;
    this.#importCancelled = true;
  }

  /** 归档根目录（给「先列出数量与目标目录」那一步用）。 */
  get archiveRoot(): string {
    return this.#settings().archiveRoot;
  }

  /**
   * 双向同步当前笔记。
   *
   * 冲突时**不替用户选**：原样把两边交回去，由调用方弹选择框，再带 `resolution`
   * 回来第二次。返回 null 只表示「连条件都不满足」（没登录 / 没打开笔记）。
   */
  async syncActiveNote(options: { resolution?: SyncResolution | null } = {}): Promise<SyncOutcome | null> {
    const file = this.#activeFile();
    const token = this.#token();
    if (file === null) {
      this.#emit({ message: "先打开一篇 Markdown 笔记。" });
      return null;
    }
    if (token === null || this.#snapshot.account === null) {
      this.#emit({ message: "先登录，再同步笔记。" });
      return null;
    }
    const outcome = await syncNote(this.#hooks.app, this.#client(token), file, options);
    // 同步写过 frontmatter，本子跟着刷新（不依赖 metadataCache 的异步回调）。
    if (outcome.action === "created" || outcome.action === "pushed" || outcome.action === "pulled") {
      this.setActiveNote(file);
    }
    this.#emit({ message: outcome.action === "conflict" ? null : outcome.detail });
    return outcome;
  }

  /** 侧栏那一行「同步」的文字。 */
  describeSync(): string {
    const marker = this.#snapshot.syncMarker;
    if (marker === null) return "未开启";
    return `已开启（服务端 v${marker.version}）`;
  }

  /**
   * 归档索引（`questionId → 文件`）。按「服务地址 + 账号」缓存：
   * 一轮导入几百张卡只扫一次 vault。换账号/换服务器键就不同，自动重建。
   */
  async #archiveIndex(): Promise<Map<string, TFile> | null> {
    const account = this.#snapshot.account;
    const settings = this.#settings();
    if (account === null || settings.baseUrl === "") {
      this.#emit({ message: "先登录，再归档。" });
      return null;
    }
    const key = `${settings.baseUrl}|${account.id}`;
    if (this.#index !== null && this.#indexKey === key) return this.#index;
    const built = buildArchiveIndex(this.#hooks.app, settings.baseUrl, account.id);
    this.#indexKey = key;
    this.#index = built;
    return built;
  }

  #archiveContext(): ArchiveContext {
    const account = this.#snapshot.account;
    const settings = this.#settings();
    return {
      app: this.#hooks.app,
      client: this.#client(this.#token()),
      root: settings.archiveRoot,
      baseUrl: settings.baseUrl,
      userId: account?.id ?? "",
      subject: this.#archiveSubject(),
    };
  }

  /** 归档用的学科：优先当前笔记绑定的那一科，没绑定就用设置里的。 */
  #archiveSubject(): string {
    const binding = this.#snapshot.binding;
    if (binding !== null) return binding.subject;
    return this.#settings().subject;
  }

  #activeFile(): TFile | null {
    const file = this.#hooks.app.workspace.getActiveFile();
    if (file === null || file.extension !== "md") return null;
    return file;
  }

  /** 侧栏头部那行「数学 · 数学一」。 */
  describeScope(): string {
    const settings = this.#settings();
    const binding = this.#snapshot.binding;
    if (binding === null) return `${subjectLabel(settings.subject)} · ${examScopeLabel(settings.subject, settings.examScope)}`;
    return `${subjectLabel(binding.subject)} · ${examScopeLabel(binding.subject, binding.examScope)}`;
  }
}


