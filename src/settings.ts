/**
 * 插件设置。纯数据 + 纯函数：不 import obsidian，smoke 才能直接跑它。
 */

export interface ExamScope {
  id: string;
  label: string;
}

export interface SubjectChoice {
  id: string;
  label: string;
  scopes: readonly ExamScope[];
}

/**
 * 侧栏只做单选/多选，所以这里开放的是「题库里有可自动判分选择题」的科目。
 *
 * 数学与 408 是公共题库；政治是统考选择题库，没有卷种之分（`examScope` 留空，
 * 请求里按「不限」处理）；「其他专业课」是用户自己导入的题库，章节也来自本人。
 * 英语的阅读共用篇章与作文批改要另一套界面，暂不开放。
 */
export const SUBJECTS: readonly SubjectChoice[] = [
  {
    id: "math",
    label: "数学",
    scopes: [
      { id: "math1", label: "数学一" },
      { id: "math2", label: "数学二" },
      { id: "math3", label: "数学三" },
    ],
  },
  {
    id: "cs408",
    label: "专业课 408",
    scopes: [
      { id: "cs408", label: "408" },
      { id: "ds", label: "数据结构" },
      { id: "co", label: "计算机组成原理" },
      { id: "os", label: "操作系统" },
      { id: "cn", label: "计算机网络" },
    ],
  },
  {
    id: "politics",
    label: "政治",
    scopes: [{ id: "", label: "不分卷" }],
  },
  {
    id: "other",
    label: "其他专业课",
    scopes: [{ id: "", label: "不分卷" }],
  },
];

/** 卷种 id 为空表示这科不分卷：请求里不带 `examScope`，不是「选了一个空卷种」。 */
export function hasExamScopes(subject: string): boolean {
  return scopesFor(subject).some((scope) => scope.id !== "");
}

export interface LazylearnSettings {
  /** 服务地址，规范化后不带尾斜杠，例如 https://lazylearn.example.com */
  baseUrl: string;
  subject: string;
  examScope: string;
  /** 归档根目录（相对于 vault）。 */
  archiveRoot: string;
}

export const DEFAULT_SETTINGS: LazylearnSettings = {
  baseUrl: "",
  subject: "math",
  examScope: "math1",
  archiveRoot: "LazyLearn",
};

/** 用户可能只写域名。缺协议补 https，尾巴的斜杠统一去掉。 */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (trimmed === "") return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

export function subjectChoice(subject: string): SubjectChoice | null {
  return SUBJECTS.find((item) => item.id === subject) ?? null;
}

export function scopesFor(subject: string): readonly ExamScope[] {
  return subjectChoice(subject)?.scopes ?? [];
}

/** 科目换了但卷种还是上一科的（math1 → 408）时落到新科目的第一个卷种。 */
export function scopeFor(subject: string, examScope: string): string {
  const scopes = scopesFor(subject);
  if (scopes.some((scope) => scope.id === examScope)) return examScope;
  return scopes[0]?.id ?? "";
}

export function subjectLabel(subject: string): string {
  return subjectChoice(subject)?.label ?? subject;
}

export function examScopeLabel(subject: string, examScope: string): string {
  return scopesFor(subject).find((scope) => scope.id === examScope)?.label ?? examScope;
}

/**
 * 读 data.json 里那一坨。缺字段用默认值，科目/卷种不合法就纠正回默认——
 * 一份手改坏了的配置不该让插件起不来。
 */
export function parseSettings(raw: unknown): LazylearnSettings {
  const source = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const baseUrl = typeof source["baseUrl"] === "string" ? normalizeBaseUrl(source["baseUrl"]) : DEFAULT_SETTINGS.baseUrl;
  const subject =
    typeof source["subject"] === "string" && subjectChoice(source["subject"]) !== null
      ? source["subject"]
      : DEFAULT_SETTINGS.subject;
  const requestedScope = typeof source["examScope"] === "string" ? source["examScope"] : "";
  const archiveRoot =
    typeof source["archiveRoot"] === "string" && source["archiveRoot"].trim() !== ""
      ? source["archiveRoot"].trim().replace(/^\/+|\/+$/g, "")
      : DEFAULT_SETTINGS.archiveRoot;
  return {
    baseUrl,
    subject,
    examScope: scopeFor(subject, requestedScope),
    archiveRoot,
  };
}
