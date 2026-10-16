/**
 * 一轮练习的取题状态。纯数据 + 纯函数：侧栏靠它去重、翻页，smoke 靠它钉住
 * 「同一批不重复」「翻到底就不再请求」这两条。
 */

import { pickUsableChoices } from "../api/contracts.ts";
import type { QuestionCard, QuestionPage } from "../api/contracts.ts";

/** 一次出几题。服务端 limit 上限 100，这里只是产品口径。 */
export const QUESTIONS_PER_ROUND = 6;

export interface TopicRound {
  readonly taxonomyIds: readonly string[];
  /** 每个知识点下一次请求要带的 cursor；没有键 = 还没拉过第一页。 */
  readonly cursors: Readonly<Record<string, string | null>>;
  /** 还有下一页的知识点。空了就是「这一轮到头了」。 */
  readonly pending: readonly string[];
  readonly cards: readonly QuestionCard[];
  readonly seen: ReadonlySet<string>;
}

export function startRound(taxonomyIds: readonly string[]): TopicRound {
  const unique = [...new Set(taxonomyIds.filter((id) => id.trim() !== ""))];
  return { taxonomyIds: unique, cursors: {}, pending: unique, cards: [], seen: new Set() };
}

export function nextTopicIds(round: TopicRound): string[] {
  return [...round.pending];
}

export function hasMore(round: TopicRound): boolean {
  return round.pending.length > 0;
}

/**
 * 合进一页。同一道题在多个知识点下都出现时只留第一份（服务端一个知识点可能出现
 * 在多棵子树里，去重放在这里，不靠服务端保证）。
 */
export function mergePage(round: TopicRound, taxonomyId: string, page: QuestionPage): TopicRound {
  const fresh: QuestionCard[] = [];
  const seen = new Set(round.seen);
  for (const card of pickUsableChoices(page.items)) {
    if (seen.has(card.id)) continue;
    seen.add(card.id);
    fresh.push(card);
  }
  const cursors: Record<string, string | null> = { ...round.cursors };
  cursors[taxonomyId] = page.nextCursor;
  const wasPending = new Set(round.pending);
  const pending = round.taxonomyIds.filter((id) =>
    id === taxonomyId ? page.nextCursor !== null : wasPending.has(id),
  );
  return { ...round, cursors, pending, cards: [...round.cards, ...fresh], seen };
}

export function kindLabel(kind: string): string {
  if (kind === "single_choice") return "单选";
  if (kind === "multiple_choice") return "多选";
  if (kind === "fill_blank") return "填空";
  if (kind === "solve") return "解答";
  return kind;
}
