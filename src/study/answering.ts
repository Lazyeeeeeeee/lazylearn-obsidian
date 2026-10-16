/**
 * 一道题的作答状态。纯数据 + 纯函数：界面照它画，smoke 照它钉「交卷后不能改答案」
 * 「双击只发一次」这两条。
 *
 * 状态迁移：answering → submitting → submitted → revealed。
 * 提交失败回到 answering 并带上 error——**不自动重发**（服务端这条路径还没有幂等键）。
 */

import { answerKeys } from "../api/contracts.ts";
import { newUuid } from "../lib/ids.ts";
import type { RevealPayload, SubmitResult } from "../api/contracts.ts";

export type AnswerStage = "answering" | "submitting" | "submitted" | "revealed";

export interface AnswerState {
  stage: AnswerStage;
  selected: readonly string[];
  result: SubmitResult | null;
  reveal: RevealPayload | null;
  error: string | null;
  /**
   * 这一次提交的幂等键。第一次提交前生成，**失败重发时沿用同一个**：
   * 服务端据此保证同一笔只落一条 Attempt、只回流一次复习，
   * 所以「超时了再点一次」不会变成「今天多错了一道」。
   */
  requestId: string | null;
}

export type OptionVerdict = "correct" | "wrong" | "missed";

export function startAnswer(): AnswerState {
  return { stage: "answering", selected: [], result: null, reveal: null, error: null, requestId: null };
}

/** 提交的幂等键。生成规则见 `lib/ids.ts`。 */
export function newRequestId(): string {
  return newUuid();
}

/** 交过卷就锁住：选项不能再动，否则「我明明选对了」会变成一场扯皮。 */
export function isLocked(state: AnswerState): boolean {
  return state.stage === "submitted" || state.stage === "revealed" || state.stage === "submitting";
}

export function toggleOption(state: AnswerState, key: string, multiple: boolean): AnswerState {
  if (isLocked(state)) return state;
  if (!multiple) {
    return { ...state, selected: state.selected.includes(key) && state.selected.length === 1 ? [] : [key] };
  }
  const selected = state.selected.includes(key)
    ? state.selected.filter((item) => item !== key)
    : [...state.selected, key];
  return { ...state, selected };
}

export function canSubmit(state: AnswerState): boolean {
  return state.stage === "answering" && state.selected.length > 0;
}

export function beginSubmit(state: AnswerState): AnswerState {
  if (!canSubmit(state)) return state;
  // 键在这里定，之后不再变：重试走的是同一个 state，所以拿到的还是这一个。
  return { ...state, stage: "submitting", error: null, requestId: state.requestId ?? newRequestId() };
}

/** 只有飞行中那一笔能落到 submitted：晚到的响应不许盖掉已经交过卷的状态。 */
export function applySubmit(state: AnswerState, result: SubmitResult): AnswerState {
  if (state.stage !== "submitting") return state;
  return { ...state, stage: "submitted", result, error: null };
}

export function failAnswer(state: AnswerState, message: string): AnswerState {
  return { ...state, stage: "answering", error: message };
}

/** 揭晓失败（网络、403）不该把「已经交卷」这件事抹掉：只挂一句话。 */
export function noteError(state: AnswerState, message: string): AnswerState {
  return { ...state, error: message };
}

export function applyReveal(state: AnswerState, reveal: RevealPayload): AnswerState {
  if (state.stage !== "submitted" && state.stage !== "revealed") return state;
  return { ...state, stage: "revealed", reveal };
}

/** 选项旁边那个记号：只有看过解析、且知道正确答案时才给。 */
export function optionVerdict(state: AnswerState, key: string): OptionVerdict | null {
  if (state.reveal === null) return null;
  const keys = answerKeys(state.reveal.answer);
  if (keys.length === 0) return null;
  const picked = state.selected.includes(key);
  if (keys.includes(key)) return picked ? "correct" : "missed";
  return picked ? "wrong" : null;
}

export function correctKeys(state: AnswerState): string[] {
  return state.reveal === null ? [] : answerKeys(state.reveal.answer);
}
