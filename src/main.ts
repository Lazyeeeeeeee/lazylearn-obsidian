/**
 * LazyLearn Obsidian 插件的入口：注册命令、侧栏、设置页与事件。
 *
 * 业务不写在这里：会话与取题在 study/controller.ts，HTTP 在 api/，绑定形状在 study/binding.ts。
 */

import { FuzzySuggestModal, Modal, Notice, Plugin, Setting, type App } from "obsidian";

import type { TaxonomyNode } from "./api/contracts.ts";
import { obsidianTransport } from "./api/obsidian-transport.ts";
import type { SecretStore } from "./auth/session.ts";
import { DEFAULT_SETTINGS, parseSettings } from "./settings.ts";
import type { LazylearnSettings } from "./settings.ts";
import { LazylearnSettingTab } from "./settings-tab.ts";
import { activeMarkdownFile } from "./study/bind-topic.ts";
import { StudyController } from "./study/controller.ts";
import { StudyView, VIEW_TYPE_STUDY } from "./views/StudyView.tsx";
import type { SyncResolution } from "./sync/plan.ts";
import type { StudyViewActions } from "./views/StudyView.tsx";

/** 「打开本插件设置页」不是公开 API：拿不到就退回提示文案，不假装能开。 */
interface SettingTabHost {
  setting?: { open(): void; openTabById(id: string): void };
}

/**
 * 「先看清去哪儿再动手」那一屏。
 *
 * 服务端没有「错题共几张」的接口，数量只能边扫边知道，所以这里给的是**目标目录**
 * 与「可随时取消」——批量写几百个文件之前，至少得让人知道自己点了什么。
 */
class ImportConfirmModal extends Modal {
  #root: string;
  #resolve: (confirmed: boolean) => void;

  constructor(app: App, root: string, resolve: (confirmed: boolean) => void) {
    super(app);
    this.#root = root;
    this.#resolve = resolve;
  }

  override onOpen(): void {
    this.contentEl.createEl("h3", { text: "导入错题本" });
    this.contentEl.createEl("p", {
      text: `会扫描你的错题本，逐题写成笔记放到「${this.#root}」下（按 服务·账号/学科/题号 分层）。` +
        "已经归档过的只会跳过；你手改过的托管块不会被覆盖。导入过程中可以随时取消。",
    });
    new Setting(this.contentEl)
      .addButton((button) =>
        button.setButtonText("开始导入").setCta().onClick(() => {
          this.#resolve(true);
          this.close();
        }),
      )
      .addButton((button) =>
        button.setButtonText("取消").onClick(() => {
          this.#resolve(false);
          this.close();
        }),
      );
  }

  override onClose(): void {
    // 直接关掉窗口（Esc/点外面）等于取消：默认值是 false，所以这里不用再回调一次。
    this.contentEl.empty();
  }
}

function confirmImport(app: App, root: string): Promise<boolean> {
  return new Promise((resolve) => {
    new ImportConfirmModal(app, root, resolve).open();
  });
}

/**
 * 两边都改过时的那一屏。
 *
 * 只摆事实（哪边多少字、服务端第几版）**不做自动合并**：正文的合并没法只用字数判断，
 * 猜错一次就是把用户写的东西吃掉。想留哪边由他点。
 */
class SyncConflictModal extends Modal {
  #versions: { local: number; server: number; serverVersion: number };
  #resolve: (choice: SyncResolution | null) => void;

  constructor(app: App, info: { local: number; server: number; serverVersion: number }, resolve: (choice: SyncResolution | null) => void) {
    super(app);
    this.#versions = info;
    this.#resolve = resolve;
  }

  override onOpen(): void {
    const { local, server, serverVersion } = this.#versions;
    this.contentEl.createEl("h3", { text: "这篇笔记两边都改过了" });
    this.contentEl.createEl("p", {
      text: `本地这一版 ${local} 字，懒学上那一版 ${server} 字（v${serverVersion}）。` +
        "选一边覆盖另一边；不想现在决定就取消，两边的现有内容都还在。",
    });
    new Setting(this.contentEl)
      .addButton((button) =>
        button.setButtonText("用本地覆盖").setCta().onClick(() => {
          this.#resolve("local");
          this.close();
        }),
      )
      .addButton((button) =>
        button.setButtonText("用服务端覆盖").onClick(() => {
          this.#resolve("server");
          this.close();
        }),
      );
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

function askSyncConflict(
  app: App,
  info: { local: number; server: number; serverVersion: number },
): Promise<SyncResolution | null> {
  return new Promise((resolve) => {
    new SyncConflictModal(app, info, resolve).open();
  });
}

class TopicSuggestModal extends FuzzySuggestModal<TaxonomyNode> {
  #nodes: TaxonomyNode[];
  #onChoose: (node: TaxonomyNode) => void;

  constructor(app: App, nodes: TaxonomyNode[], onChoose: (node: TaxonomyNode) => void) {
    super(app);
    this.#nodes = nodes;
    this.#onChoose = onChoose;
    this.setPlaceholder("搜知识点，回车绑定到当前笔记");
  }

  override getItems(): TaxonomyNode[] {
    return this.#nodes;
  }

  override getItemText(node: TaxonomyNode): string {
    return `${node.name}（${node.questionCount} 题）`;
  }

  override onChooseItem(node: TaxonomyNode): void {
    this.#onChoose(node);
  }
}

export default class LazyLearnPlugin extends Plugin {
  // 基类 1.13 起就有 `settings`（声明式设置用），文档让我们在自己的类上声明具体类型。
  override settings: LazylearnSettings = { ...DEFAULT_SETTINGS };
  controller!: StudyController;

  override async onload(): Promise<void> {
    await this.loadSettings();
    this.controller = new StudyController({
      app: this.app,
      secrets: this.#secretStore(),
      transport: obsidianTransport,
      settings: () => this.settings,
    });

    this.registerView(VIEW_TYPE_STUDY, (leaf) => new StudyView(leaf, this.controller, this.#viewActions()));

    this.addRibbonIcon("graduation-cap", "LazyLearn：打开练题侧栏", () => {
      void this.activateStudyView();
    });

    this.addCommand({
      id: "open-study-view",
      name: "打开练题侧栏",
      callback: () => {
        void this.activateStudyView();
      },
    });
    this.addCommand({
      id: "bind-topic",
      name: "绑定当前笔记的知识点",
      callback: () => {
        void this.pickTopic();
      },
    });
    this.addCommand({
      id: "clear-topic-binding",
      name: "清除当前笔记的知识点绑定",
      callback: () => {
        void this.clearBinding();
      },
    });
    this.addCommand({
      id: "reload-questions",
      name: "重新拉取当前笔记的题目",
      callback: () => {
        void this.controller.reload();
      },
    });
    this.addCommand({
      id: "archive-wrong-in-round",
      name: "归档本轮做错的题",
      callback: () => {
        void this.archiveWrongInRound();
      },
    });
    this.addCommand({
      id: "import-errors",
      name: "导入错题本",
      callback: () => {
        void this.importErrors();
      },
    });
    this.addCommand({
      id: "sync-note",
      name: "双向同步当前笔记",
      callback: () => {
        void this.syncActiveNote();
      },
    });

    this.addSettingTab(new LazylearnSettingTab(this.app, this));
    this.addCommand({
      id: "personalized-practice-group",
      name: "按薄弱点换 6 题",
      callback: () => { void this.controller.loadPracticeGroup(); },
    });

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.refreshActiveNote();
      }),
    );
    // frontmatter 被别处改掉（手改、同步、Git 拉取）时跟着刷新绑定。
    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        if (file.path === this.controller.snapshot.notePath) this.refreshActiveNote();
      }),
    );

    this.refreshActiveNote();
    await this.controller.initialize();
  }

  override onunload(): void {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_STUDY);
  }

  async loadSettings(): Promise<void> {
    this.settings = parseSettings(await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /**
   * token 走 SecretStorage（since 1.11.4，manifest 的 minAppVersion 钉的就是它）：
   * data.json 是明文同步到各处的，会话不该躺在里面。
   */
  #secretStore(): SecretStore {
    const storage = this.app.secretStorage;
    if (storage === undefined) {
      new Notice("这个 Obsidian 版本没有 SecretStorage，请升级到 1.11.4 以上。");
      return { get: () => null, set: () => undefined };
    }
    return {
      get: (id) => storage.getSecret(id),
      set: (id, value) => {
        try {
          storage.setSecret(id, value);
        } catch (error) {
          new Notice(`写会话失败：${error instanceof Error ? error.message : String(error)}`);
        }
      },
    };
  }

  #viewActions(): StudyViewActions {
    return {
      practiceGroup: () => { void this.controller.loadPracticeGroup(); },
      bindTopic: () => {
        void this.pickTopic();
      },
      openSettings: () => {
        this.openPluginSettings();
      },
      refresh: () => {
        void this.controller.reload();
      },
      loadMore: () => {
        void this.controller.loadMore();
      },
      toggleOption: (card, key) => {
        this.controller.toggleOption(card, key);
      },
      submitAnswer: (card) => {
        void this.controller.submitAnswer(card);
      },
      revealAnswer: (cardId) => {
        void this.controller.revealAnswer(cardId);
      },
      archiveCard: (card) => {
        void this.controller.archiveOne(card);
      },
      syncNote: () => {
        void this.syncActiveNote();
      },
      importErrors: () => {
        void this.importErrors();
      },
      cancelImport: () => {
        this.controller.cancelImport();
      },
    };
  }

  /**
   * 导入错题本。先让用户看一眼**目标目录**再动手（服务端没有总数接口，
   * 数量只能边扫边知道，所以这里给的是目录与「可随时取消」），完成后报一份读数。
   */
  async importErrors(): Promise<void> {
    if (this.controller.snapshot.account === null) {
      new Notice("先登录，再导入错题。");
      return;
    }
    if (this.controller.snapshot.importing !== null) {
      new Notice("已经在导入了。");
      return;
    }
    const confirmed = await confirmImport(this.app, this.controller.archiveRoot);
    if (!confirmed) return;
    const progress = await this.controller.importErrors();
    if (progress === null) return;
    new Notice(
      `导入完成：新增 ${progress.created}、更新 ${progress.updated}、跳过 ${progress.skipped}` +
        `、冲突 ${progress.conflict}、失败 ${progress.failed}`,
    );
  }

  /**
   * 双向同步当前笔记。冲突时弹一次选择框，带着用户的选择再走一趟。
   * 第一次调用**不会**动任何一边的内容（`syncNote` 遇到冲突只回报，不写盘）。
   */
  async syncActiveNote(): Promise<void> {
    const first = await this.controller.syncActiveNote();
    if (first === null) return;
    if (first.action !== "conflict" || first.conflict === undefined) {
      new Notice(first.detail);
      return;
    }
    const choice = await askSyncConflict(this.app, {
      local: first.conflict.localText.length,
      server: first.conflict.server.body.length,
      serverVersion: first.conflict.server.version,
    });
    if (choice === null) return;
    const second = await this.controller.syncActiveNote({ resolution: choice });
    if (second !== null) new Notice(second.detail);
  }

  /** 本轮做错的题一次性归档：侧栏里没有「当前题」这个概念，按结果挑更清楚。 */
  async archiveWrongInRound(): Promise<void> {
    const snapshot = this.controller.snapshot;
    const wrong = snapshot.round.cards.filter(
      (card) => snapshot.answers[card.id]?.result?.correct === false,
    );
    if (wrong.length === 0) {
      new Notice("这一轮还没有做错的题。");
      return;
    }
    let created = 0;
    let conflict = 0;
    let failed = 0;
    for (const card of wrong) {
      const result = await this.controller.archiveOne(card);
      if (result === null) return;
      if (result.outcome === "created" || result.outcome === "updated") created += 1;
      else if (result.outcome === "conflict") conflict += 1;
      else if (result.outcome === "failed") failed += 1;
    }
    new Notice(`归档本轮错题：写下 ${created}、冲突 ${conflict}、失败 ${failed}`);
  }

  /** 重新读一遍当前笔记（绑定、同步本子都是 frontmatter 里的）。 */
  refreshActiveNote(): void {
    this.controller.setActiveNote(activeMarkdownFile(this.app));
  }

  async activateStudyView(): Promise<void> {
    // 已经开着就只是把它拉到前面；没开才新建，免得每次点 ribbon 都多一个标签页。
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_STUDY)[0];
    if (existing !== undefined) {
      await this.app.workspace.revealLeaf(existing);
      return;
    }
    await this.app.workspace.ensureSideLeaf(VIEW_TYPE_STUDY, "right", { active: true, reveal: true });
  }

  openPluginSettings(): void {
    const host = this.app as unknown as SettingTabHost;
    if (host.setting === undefined) {
      new Notice("打开「设置 → 社区插件 → LazyLearn」填服务地址并登录。");
      return;
    }
    host.setting.open();
    host.setting.openTabById(this.manifest.id);
  }

  async pickTopic(): Promise<void> {
    if (this.controller.snapshot.account === null) {
      new Notice("先在设置里登录懒学账号。");
      return;
    }
    if (activeMarkdownFile(this.app) === null) {
      new Notice("先打开一篇 Markdown 笔记。");
      return;
    }
    let nodes: TaxonomyNode[];
    try {
      nodes = await this.controller.loadTaxonomy();
    } catch (error) {
      new Notice(`拉知识点树失败：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    // 没有题的节点选了也是空转：优先只列有题的，全都没题时退回整棵树。
    const withQuestions = nodes.filter((node) => node.questionCount > 0);
    const pool = withQuestions.length > 0 ? withQuestions : nodes;
    if (pool.length === 0) {
      new Notice("这个科目下没拿到知识点，检查设置里的科目/卷种。");
      return;
    }
    new TopicSuggestModal(this.app, pool, (node) => {
      void this.controller.bindNode(node).then((binding) => {
        if (binding === null) return;
        new Notice(`已绑定「${node.name}」，共 ${binding.taxonomyIds.length} 个知识点。`);
      });
    }).open();
  }

  async clearBinding(): Promise<void> {
    const cleared = await this.controller.unbindActiveNote();
    new Notice(cleared ? "已清除这篇笔记的知识点绑定。" : "没清掉：先打开一篇 Markdown 笔记。");
  }

  async signOut(): Promise<void> {
    await this.controller.signOut();
  }

  /** 换服务器只有一个入口：旧地址的会话当场清掉，免得拿 A 站的 token 去请求 B 站。 */
  async applyBaseUrl(next: string): Promise<void> {
    if (next === this.settings.baseUrl) return;
    await this.controller.signOut();
    this.settings.baseUrl = next;
    await this.saveSettings();
    this.controller.invalidateTaxonomy();
    await this.controller.initialize();
    this.refreshActiveNote();
  }

  async applyScope(subject: string, examScope: string): Promise<void> {
    if (subject === this.settings.subject && examScope === this.settings.examScope) return;
    this.settings.subject = subject;
    this.settings.examScope = examScope;
    await this.saveSettings();
    this.controller.invalidateTaxonomy();
    this.refreshActiveNote();
    await this.controller.reload();
  }

  async applyArchiveRoot(raw: string): Promise<void> {
    const next = raw.trim().replace(/^\/+|\/+$/g, "");
    if (next === "" || next === this.settings.archiveRoot) return;
    this.settings.archiveRoot = next;
    await this.saveSettings();
  }
}

