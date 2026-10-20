/**
 * 学习侧栏。React 只出现在这一层：取数、作答状态、判分都在 controller / study 里。
 *
 * 题干用 `MarkdownRenderer` 渲染而不是 `textContent`：题库里到处是 `$...$` 公式，
 * 走 Obsidian 的渲染器才拿得到数学排版（也顺手支持行内图片标记）。
 */

import { Component, ItemView, MarkdownRenderer, type App, type WorkspaceLeaf } from "obsidian";
import { useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

import { formatAnswer } from "../api/contracts.ts";
import type { ChoiceOption, QuestionCard } from "../api/contracts.ts";
import { canSubmit, correctKeys, isLocked, optionVerdict, startAnswer } from "../study/answering.ts";
import type { AnswerState, OptionVerdict } from "../study/answering.ts";
import type { StudyController, StudySnapshot } from "../study/controller.ts";
import { hasMore, kindLabel } from "../study/practice.ts";

export const VIEW_TYPE_STUDY = "lazylearn-study";

export interface StudyViewActions {
  bindTopic: () => void;
  openSettings: () => void;
  refresh: () => void;
  loadMore: () => void;
  practiceGroup: () => void;
  toggleOption: (card: QuestionCard, key: string) => void;
  submitAnswer: (card: QuestionCard) => void;
  revealAnswer: (cardId: string) => void;
  archiveCard: (card: QuestionCard) => void;
  importErrors: () => void;
  cancelImport: () => void;
  syncNote: () => void;
}

const VERDICT_MARK: Record<OptionVerdict, string> = { correct: "✓", wrong: "✗", missed: "漏选" };

interface MarkdownProps {
  app: App;
  markdown: string;
  sourcePath: string;
  className: string;
}

function Markdown({ app, markdown, sourcePath, className }: MarkdownProps) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = host.current;
    if (element === null) return;
    const component = new Component();
    component.load();
    void MarkdownRenderer.render(app, markdown, element, sourcePath, component);
    return () => {
      component.unload();
      element.empty();
    };
  }, [app, markdown, sourcePath, className]);
  return <div className={className} ref={host} />;
}

interface OptionProps {
  app: App;
  sourcePath: string;
  option: ChoiceOption;
  answer: AnswerState;
  onToggle: (key: string) => void;
}

function OptionRow({ app, sourcePath, option, answer, onToggle }: OptionProps) {
  const picked = answer.selected.includes(option.key);
  const verdict = optionVerdict(answer, option.key);
  const classes = ["lazylearn-option"];
  if (picked) classes.push("is-picked");
  if (verdict !== null) classes.push(`is-${verdict}`);
  const inner = (
    <>
      <span className="lazylearn-option-key">{option.key}.</span>
      <Markdown app={app} markdown={option.text} sourcePath={sourcePath} className="lazylearn-option-text" />
      {verdict === null ? null : <span className="lazylearn-verdict-mark">{VERDICT_MARK[verdict]}</span>}
    </>
  );
  // 交过卷就换成静态的：不给点，免得「我明明选对了」变成一场扯皮。
  if (isLocked(answer)) {
    return (
      <li>
        <div className={classes.join(" ")}>{inner}</div>
      </li>
    );
  }
  return (
    <li>
      <button type="button" className={classes.join(" ")} aria-pressed={picked} onClick={() => onToggle(option.key)}>
        {inner}
      </button>
    </li>
  );
}

interface CardProps {
  card: QuestionCard;
  app: App;
  sourcePath: string;
  answer: AnswerState;
  actions: StudyViewActions;
}

function Card({ card, app, sourcePath, answer, actions }: CardProps) {
  const revealed = answer.stage === "revealed" && answer.reveal !== null;
  const reference = revealed ? formatAnswer(answer.reveal?.answer) : "";
  const keys = correctKeys(answer);
  const assetNote = card.assetUrls.length > 0 ? `含图 ${card.assetUrls.length} 张（看图请到原站）` : null;

  return (
    <li className="lazylearn-card">
      <div className="lazylearn-card-meta">
        <span className="lazylearn-tag">{kindLabel(card.kind)}</span>
        {card.seq === null ? null : <span className="lazylearn-tag">第 {card.seq} 题</span>}
        {assetNote === null ? null : <span className="lazylearn-tag">{assetNote}</span>}
        {answer.result === null ? null : (
          <span className={answer.result.correct ? "lazylearn-tag is-right" : "lazylearn-tag is-wrong"}>
            {answer.result.correct ? "答对了" : "答错了"}
          </span>
        )}
      </div>

      <Markdown app={app} markdown={card.stem} sourcePath={sourcePath} className="lazylearn-stem" />

      {card.options.length === 0 ? null : (
        <ul className="lazylearn-options">
          {card.options.map((option) => (
            <OptionRow
              key={option.key}
              app={app}
              sourcePath={sourcePath}
              option={option}
              answer={answer}
              onToggle={(key) => actions.toggleOption(card, key)}
            />
          ))}
        </ul>
      )}

      <div className="lazylearn-card-actions">
        {answer.stage === "answering" ? (
          <button
            className="lazylearn-button"
            onClick={() => actions.submitAnswer(card)}
            disabled={!canSubmit(answer)}
          >
            提交
          </button>
        ) : null}
        {answer.stage === "submitting" ? (
          // 禁用而不是换个 handler：这一笔没回来之前不许再发一次。
          <button className="lazylearn-button" disabled>
            判分中…
          </button>
        ) : null}
        {answer.stage === "submitted" ? (
          <button className="lazylearn-button" onClick={() => actions.revealAnswer(card.id)}>
            看解析
          </button>
        ) : null}
        {answer.stage === "revealed" ? <span className="lazylearn-muted">已揭晓</span> : null}
        {/* 归档不要求先作答：错题本来就可能是在原站做错的，迁回笔记时照样要收。 */}
        <button className="lazylearn-button" onClick={() => actions.archiveCard(card)}>
          归档
        </button>
      </div>

      {answer.error === null ? null : <p className="lazylearn-card-error">{answer.error}</p>}

      {!revealed && keys.length > 0 ? <p className="lazylearn-answer">正确答案：{keys.join("、")}</p> : null}

      {revealed ? (
        <div className="lazylearn-reveal">
          {reference === "" ? null : <p className="lazylearn-answer">参考答案：{reference}</p>}
          {answer.reveal?.trick === null || answer.reveal?.trick === undefined ? null : (
            <Markdown app={app} markdown={`**技巧**：${answer.reveal.trick}`} sourcePath={sourcePath} className="lazylearn-analysis" />
          )}
          {answer.reveal?.analysis === null || answer.reveal?.analysis === undefined ? (
            <p className="lazylearn-muted">这道题没有解析。</p>
          ) : (
            <Markdown app={app} markdown={answer.reveal.analysis} sourcePath={sourcePath} className="lazylearn-analysis" />
          )}
          {answer.reveal?.aiAnalysis === null || answer.reveal?.aiAnalysis === undefined ? null : (
            <Markdown app={app} markdown={answer.reveal.aiAnalysis} sourcePath={sourcePath} className="lazylearn-analysis" />
          )}
        </div>
      ) : null}
    </li>
  );
}

interface PanelProps {
  controller: StudyController;
  app: App;
  actions: StudyViewActions;
}

function Panel({ controller, app, actions }: PanelProps) {
  const [snapshot, setSnapshot] = useState<StudySnapshot>(() => controller.snapshot);
  useEffect(() => controller.subscribe(setSnapshot), [controller]);

  const signedIn = snapshot.account !== null;
  const sourcePath = snapshot.notePath ?? "";
  const boundNames = (snapshot.binding?.taxonomyIds ?? []).map((id) => snapshot.taxonomyNames[id] ?? id);
  const answers = snapshot.round.cards.map((card) => snapshot.answers[card.id] ?? startAnswer());
  const answered = answers.filter((answer) => answer.result !== null).length;
  const right = answers.filter((answer) => answer.result?.correct === true).length;

  return (
    <div className="lazylearn-panel">
      <header className="lazylearn-header">
        <div>
          <div className="lazylearn-title">LazyLearn</div>
          <div className="lazylearn-subtitle">{controller.describeScope()}</div>
        </div>
        <button className="lazylearn-icon-button" onClick={actions.openSettings} title="打开设置">
          设置
        </button>
      </header>

      <section className="lazylearn-section">
        <div className="lazylearn-row">
          <span className="lazylearn-label">账号</span>
          {signedIn ? (
            <span className="lazylearn-value">
              {snapshot.account?.nickname || snapshot.account?.username}
              {snapshot.account?.member ? "（会员）" : ""}
            </span>
          ) : (
            <span className="lazylearn-value lazylearn-muted">未登录</span>
          )}
          {signedIn ? null : (
            <button className="lazylearn-button" onClick={actions.openSettings}>
              去登录
            </button>
          )}
        </div>
        <div className="lazylearn-row">
          <span className="lazylearn-label">服务</span>
          <span className="lazylearn-value lazylearn-break">{snapshot.baseUrl || "未配置"}</span>
        </div>
      </section>

      <section className="lazylearn-section">
        <div className="lazylearn-row">
          <span className="lazylearn-label">当前笔记</span>
          <span className="lazylearn-value">{snapshot.noteName ?? "没有打开 Markdown 笔记"}</span>
        </div>
        <div className="lazylearn-row">
          <span className="lazylearn-label">知识点</span>
          {boundNames.length === 0 ? (
            <span className="lazylearn-value lazylearn-muted">未绑定</span>
          ) : (
            <span className="lazylearn-value">{boundNames.join("、")}</span>
          )}
        </div>
        <div className="lazylearn-row">
          <span className="lazylearn-label">同步</span>
          <span className="lazylearn-value">{controller.describeSync()}</span>
        </div>
        <div className="lazylearn-actions">
          <button
            className="lazylearn-button"
            onClick={actions.bindTopic}
            disabled={snapshot.notePath === null || !signedIn}
          >
            绑定知识点
          </button>
          <button
            className="lazylearn-button"
            onClick={actions.syncNote}
            disabled={snapshot.notePath === null || !signedIn}
          >
            双向同步
          </button>
          <button className="lazylearn-button" onClick={actions.refresh} disabled={!signedIn}>
            重新取题
          </button>
          <button className="lazylearn-button" onClick={actions.practiceGroup}
            disabled={!signedIn || snapshot.binding === null || snapshot.loadingMore}>
            按薄弱点换 6 题
          </button>
        </div>
      </section>

      {snapshot.message === null ? null : <div className="lazylearn-notice">{snapshot.message}</div>}

      <section className="lazylearn-section lazylearn-grow">
        <div className="lazylearn-row">
          <span className="lazylearn-label">题目</span>
          <span className="lazylearn-value lazylearn-muted">
            {answers.length === 0
              ? "还没取到题"
              : `已取 ${answers.length} 题，答了 ${answered} 题，对 ${right} 题`}
          </span>
        </div>
        {snapshot.binding === null ? (
          <p className="lazylearn-hint">
            先给这篇笔记绑定一个知识点：绑定只写 frontmatter，笔记正文不会上传。
          </p>
        ) : null}
        <ul className="lazylearn-cards">
          {snapshot.round.cards.map((card) => (
            <Card
              key={card.id}
              card={card}
              app={app}
              sourcePath={sourcePath}
              answer={snapshot.answers[card.id] ?? startAnswer()}
              actions={actions}
            />
          ))}
        </ul>
        <div className="lazylearn-actions">
          <button
            className="lazylearn-button"
            onClick={actions.loadMore}
            disabled={!signedIn || snapshot.loadingMore || !hasMore(snapshot.round)}
          >
            {snapshot.loadingMore ? "取题中…" : "再来 6 题"}
          </button>
        </div>
      </section>

      <section className="lazylearn-section">
        <div className="lazylearn-row">
          <span className="lazylearn-label">归档到</span>
          <span className="lazylearn-value lazylearn-break">{controller.archiveRoot}</span>
        </div>
        {snapshot.importing === null ? (
          <div className="lazylearn-actions">
            <button className="lazylearn-button" onClick={actions.importErrors} disabled={!signedIn}>
              导入错题本
            </button>
          </div>
        ) : (
          <div className="lazylearn-row">
            <span className="lazylearn-value">
              导入中：新增 {snapshot.importing.created}、更新 {snapshot.importing.updated}、跳过{" "}
              {snapshot.importing.skipped}
            </span>
            <button className="lazylearn-button" onClick={actions.cancelImport}>
              取消
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

export class StudyView extends ItemView {
  #controller: StudyController;
  #actions: StudyViewActions;
  #root: Root | null = null;

  constructor(leaf: WorkspaceLeaf, controller: StudyController, actions: StudyViewActions) {
    super(leaf);
    this.#controller = controller;
    this.#actions = actions;
  }

  override getViewType(): string {
    return VIEW_TYPE_STUDY;
  }

  override getDisplayText(): string {
    return "LazyLearn 练题";
  }

  override getIcon(): string {
    return "graduation-cap";
  }

  override async onOpen(): Promise<void> {
    this.contentEl.addClass("lazylearn-view");
    this.#root = createRoot(this.contentEl);
    this.#root.render(<Panel controller={this.#controller} app={this.app} actions={this.#actions} />);
  }

  override async onClose(): Promise<void> {
    this.#root?.unmount();
    this.#root = null;
  }
}
