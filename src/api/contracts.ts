/**
 * 服务端下发结构的最小镜像 + 运行时校验。
 *
 * 只抄用得上的字段：插件不为「服务端将来可能下发什么」预留类型，
 * 字段对不上时宁可当场报错，也不要让 undefined 流进界面里变成空白题。
 */

export class ContractError extends Error {
  constructor(message: string) {
    super(`服务端返回的结构不认识：${message}`);
    this.name = "ContractError";
  }
}

export interface ChoiceOption {
  key: string;
  text: string;
}

/** 列表项（`GET /api/questions` 的 slim 形状）里我们真会读的那部分。 */
export interface QuestionCard {
  id: string;
  kind: string;
  subject: string;
  stem: string;
  options: ChoiceOption[];
  examScopes: string[];
  taxonomyIds: string[];
  /** 服务端 `public_question_payload` 算出来的：有答案键的选择题才为 true。 */
  autoGradable: boolean;
  seq: number | null;
  /** 题干里 `asset:` 引用解析后的绝对地址（服务端已带水印）。 */
  assetUrls: string[];
}

export interface QuestionPage {
  items: QuestionCard[];
  nextCursor: string | null;
}

export interface TaxonomyNode {
  id: string;
  parentId: string | null;
  subject: string;
  level: number;
  name: string;
  questionCount: number;
  /** 有值 = 这门课的知识点树是用户自己的章节，不是公共树。 */
  ownerId: string | null;
}

export interface Account {
  id: string;
  username: string;
  nickname: string;
  role: string;
  member: boolean;
  memberUntil: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ContractError(`${where} 应是对象`);
  return value;
}

function text(source: Record<string, unknown>, key: string, where: string): string {
  const value = source[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ContractError(`${where}.${key} 应是非空字符串`);
  }
  return value;
}

function textOrNull(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberOrNull(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanOr(source: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = source[key];
  return typeof value === "boolean" ? value : fallback;
}

function textList(source: Record<string, unknown>, key: string): string[] {
  const value = source[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function parseOptions(source: Record<string, unknown>): ChoiceOption[] {
  const value = source["options"];
  if (!Array.isArray(value)) return [];
  const options: ChoiceOption[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const key = raw["key"];
    const label = raw["text"];
    if (typeof key !== "string" || key === "") continue;
    options.push({ key, text: typeof label === "string" ? label : "" });
  }
  return options;
}

function parseAssetUrls(source: Record<string, unknown>): string[] {
  const value = source["assets"];
  if (!Array.isArray(value)) return [];
  const urls: string[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const url = raw["url"];
    if (typeof url === "string" && url !== "") urls.push(url);
  }
  return urls;
}

export function parseQuestionCard(value: unknown): QuestionCard {
  const source = record(value, "question");
  return {
    id: text(source, "id", "question"),
    kind: text(source, "kind", "question"),
    subject: text(source, "subject", "question"),
    stem: typeof source["stem"] === "string" ? source["stem"] : "",
    options: parseOptions(source),
    examScopes: textList(source, "examScopes"),
    taxonomyIds: textList(source, "taxonomyIds"),
    autoGradable: booleanOr(source, "autoGradable", false),
    seq: numberOrNull(source, "seq"),
    assetUrls: parseAssetUrls(source),
  };
}

export function parseQuestionPage(value: unknown): QuestionPage {
  const source = record(value, "题目分页");
  const rawItems = source["items"];
  if (!Array.isArray(rawItems)) throw new ContractError("题目分页.items 应是数组");
  return {
    items: rawItems.map(parseQuestionCard),
    nextCursor: textOrNull(source, "nextCursor"),
  };
}

export function parseTaxonomyNodes(value: unknown): TaxonomyNode[] {
  if (!Array.isArray(value)) throw new ContractError("知识点树应是数组");
  return value.map((raw) => {
    const source = record(raw, "知识点");
    const level = numberOrNull(source, "level");
    if (level === null) throw new ContractError("知识点.level 应是数字");
    return {
      id: text(source, "id", "知识点"),
      parentId: textOrNull(source, "parentId"),
      subject: text(source, "subject", "知识点"),
      level,
      name: text(source, "name", "知识点"),
      questionCount: numberOrNull(source, "questionCount") ?? 0,
      ownerId: textOrNull(source, "ownerId"),
    };
  });
}

export function parseAccount(value: unknown): Account {
  const source = record(value, "账号");
  return {
    id: text(source, "id", "账号"),
    username: text(source, "username", "账号"),
    nickname: text(source, "nickname", "账号"),
    role: typeof source["role"] === "string" ? source["role"] : "user",
    member: booleanOr(source, "member", false),
    memberUntil: textOrNull(source, "memberUntil"),
  };
}

/** 首版只做单选/多选：其余题型要么自评、要么得在原站作答。 */
export function isUsableChoice(card: QuestionCard): boolean {
  if (card.kind !== "single_choice" && card.kind !== "multiple_choice") return false;
  return card.autoGradable && card.options.length >= 2;
}

export function pickUsableChoices(cards: readonly QuestionCard[]): QuestionCard[] {
  return cards.filter(isUsableChoice);
}

/** 一次作答的判分结果（`POST /api/questions/{id}/submit`）。正确性以服务端为准。 */
export interface SubmitResult {
  correct: boolean;
  score: number;
  method: string;
  attemptId: string;
  /**
   * 服务端说「这一笔我早记过了」：同一个 clientRequestId 重发时会置真。
   * 判分与 attemptId 与首次逐字一致，所以界面照常显示结果即可。
   */
  replay: boolean;
}

export function parseSubmitResult(value: unknown): SubmitResult {
  const source = record(value, "判分结果");
  const correct = source["correct"];
  if (typeof correct !== "boolean") throw new ContractError("判分结果.correct 应是布尔");
  const attemptId = source["attemptId"];
  if (typeof attemptId !== "string" || attemptId === "") {
    throw new ContractError("判分结果.attemptId 应是非空字符串");
  }
  return {
    correct,
    score: typeof source["score"] === "number" ? source["score"] : 0,
    method: typeof source["method"] === "string" ? source["method"] : "",
    attemptId,
    replay: source["replay"] === true,
  };
}

/** 揭晓（`GET /api/questions/{id}/reveal`）：只抄界面要画的四段。 */
export interface RevealPayload {
  answer: unknown;
  analysis: string | null;
  aiAnalysis: string | null;
  trick: string | null;
}

export function parseRevealPayload(value: unknown): RevealPayload {
  const source = record(value, "揭晓");
  const nullable = (key: string): string | null => {
    const raw = source[key];
    return typeof raw === "string" && raw.trim() !== "" ? raw : null;
  };
  return { answer: source["answer"], analysis: nullable("analysis"), aiAnalysis: nullable("aiAnalysis"), trick: nullable("trick") };
}

/**
 * 参考答案的显示串。choice 是 `["A","C"]`、填空是 `[{id, answer}]`、解答是一段文字，
 * 三种形状都从这里收口，界面不用各自判一次。
 */
export function formatAnswer(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      if (typeof item === "string") {
        parts.push(item);
        continue;
      }
      if (isRecord(item)) {
        // 填空题：{id, answer: [...]} → 「1: 答案」
        const answers = textList(item, "answer");
        if (answers.length > 0) {
          const label = typeof item["id"] === "string" && item["id"] !== "" ? `${item["id"]}: ` : "";
          parts.push(`${label}${answers.join("、")}`);
          continue;
        }
      }
      const nested = formatAnswer(item);
      if (nested !== "") parts.push(nested);
    }
    return parts.join("、");
  }
  if (isRecord(value)) {
    return Object.entries(value)
      .map(([key, item]) => `${key}: ${formatAnswer(item)}`)
      .filter((line) => !line.endsWith(": "))
      .join("；");
  }
  return String(value);
}

/** 选择题的正确答案键（揭晓里那一栏），非选择题给空数组。 */
export function answerKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}
/**
 * 错题本一页里的一条（`GET /api/reviews/errors-page`）。
 *
 * 与题目列表的差别：这是**复习卡**，卡面（stem/options/assets）由服务端的 `_question_preview`
 * 补上，**没有**答案与解析——那要另外调 reveal（复习场景带 `review=1`）。
 */
export interface ErrorCard {
  reviewId: string;
  questionId: string;
  subject: string;
  dueAt: string;
  wrongCount: number;
  createdAt: string;
  question: QuestionCard;
}

export interface ErrorPage {
  items: ErrorCard[];
  nextCursor: string | null;
}

function parseErrorCard(value: unknown): ErrorCard {
  const source = record(value, "错题卡");
  const question = record(source["question"], "错题卡.question");
  const stats = isRecord(source["stats"]) ? source["stats"] : {};
  return {
    reviewId: text(source, "id", "错题卡"),
    questionId: text(source, "questionId", "错题卡"),
    subject: typeof source["bankSubject"] === "string" ? source["bankSubject"] : "",
    dueAt: typeof source["dueAt"] === "string" ? source["dueAt"] : "",
    wrongCount: numberOrNull(stats, "wrong") ?? 0,
    createdAt: typeof source["createdAt"] === "string" ? source["createdAt"] : "",
    question: {
      id: text(question, "id", "错题卡.question"),
      kind: text(question, "kind", "错题卡.question"),
      subject: typeof source["bankSubject"] === "string" ? source["bankSubject"] : "",
      stem: typeof question["stem"] === "string" ? question["stem"] : "",
      options: parseOptions(question),
      examScopes: [],
      taxonomyIds: textList(question, "taxonomyIds"),
      autoGradable: false,
      seq: null,
      assetUrls: parseAssetUrls(question),
    },
  };
}

export function parseErrorPage(value: unknown): ErrorPage {
  const source = record(value, "错题分页");
  const rawItems = source["items"];
  if (!Array.isArray(rawItems)) throw new ContractError("错题分页.items 应是数组");
  return {
    items: rawItems.map(parseErrorCard),
    nextCursor: textOrNull(source, "nextCursor"),
  };
}
/** 服务端笔记（`/api/notes`）。只抄同步要用到的字段。 */
export interface Note {
  id: string;
  title: string;
  body: string;
  /** 乐观锁版本号：每成功写入一次 +1。条件写靠它认「别人动过没有」。 */
  version: number;
  /** 外部客户端给的稳定标识；网页里写的笔记是 null。 */
  externalId: string | null;
  updatedAt: string;
}

export function parseNote(value: unknown): Note {
  const source = record(value, "笔记");
  return {
    id: text(source, "id", "笔记"),
    title: typeof source["title"] === "string" ? source["title"] : "",
    body: typeof source["body"] === "string" ? source["body"] : "",
    version: numberOrNull(source, "version") ?? 1,
    externalId: textOrNull(source, "externalId"),
    updatedAt: typeof source["updatedAt"] === "string" ? source["updatedAt"] : "",
  };
}

export function parseNoteList(value: unknown): Note[] {
  const items = isRecord(value) ? value["items"] : value;
  if (!Array.isArray(items)) throw new ContractError("笔记列表应是数组");
  return items.map(parseNote);
}