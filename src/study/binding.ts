/**
 * 笔记 frontmatter 里的知识点绑定。纯函数 + 纯数据，读写 vault 的那一层在 bind-topic.ts。
 *
 * 形状（schema 固定为 1，将来改形状靠它区分）：
 * ```yaml
 * lazylearn:
 *   schema: 1
 *   subject: math
 *   examScope: math1
 *   taxonomyIds:
 *     - <服务端知识点 id>
 *   boundAt: 2026-10-15T02:00:00.000Z
 * ```
 */

export const BINDING_KEY = "lazylearn";
export const BINDING_SCHEMA = 1;

export interface TopicBinding {
  schema: number;
  subject: string;
  examScope: string;
  taxonomyIds: string[];
  boundAt: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
}

/** 认不出来就当没绑过：一份手改坏的 frontmatter 不该让侧栏报错。 */
export function readBinding(frontmatter: unknown): TopicBinding | null {
  if (!isRecord(frontmatter)) return null;
  const raw = frontmatter[BINDING_KEY];
  if (!isRecord(raw)) return null;
  if (raw["schema"] !== BINDING_SCHEMA) return null;
  const subject = raw["subject"];
  const examScope = raw["examScope"];
  const taxonomyIds = nonEmptyStrings(raw["taxonomyIds"]);
  if (typeof subject !== "string" || subject === "") return null;
  if (typeof examScope !== "string" || examScope === "") return null;
  if (taxonomyIds.length === 0) return null;
  const boundAt = raw["boundAt"];
  return {
    schema: BINDING_SCHEMA,
    subject,
    examScope,
    taxonomyIds,
    boundAt: typeof boundAt === "string" && boundAt !== "" ? boundAt : null,
  };
}

export function createBinding(
  subject: string,
  examScope: string,
  taxonomyIds: readonly string[],
  now: Date = new Date(),
): TopicBinding {
  return {
    schema: BINDING_SCHEMA,
    subject,
    examScope,
    taxonomyIds: [...new Set(taxonomyIds.filter((id) => id.trim() !== ""))],
    boundAt: now.toISOString(),
  };
}

/** 原地写入（`processFrontMatter` 的回调就是这么用的）。 */
export function writeBindingInto(frontmatter: Record<string, unknown>, binding: TopicBinding): void {
  frontmatter[BINDING_KEY] = {
    schema: binding.schema,
    subject: binding.subject,
    examScope: binding.examScope,
    taxonomyIds: [...binding.taxonomyIds],
    ...(binding.boundAt === null ? {} : { boundAt: binding.boundAt }),
  };
}

export function removeBindingFrom(frontmatter: Record<string, unknown>): void {
  delete frontmatter[BINDING_KEY];
}

/**
 * 两份绑定是不是同一回事。「笔记正文每保存一次 metadataCache 都会 changed」，
 * 没有这道判断的话，打字打到一半就会把正在做的那一批题重新拉一遍。
 */
export function sameBinding(a: TopicBinding | null, b: TopicBinding | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.subject === b.subject &&
    a.examScope === b.examScope &&
    a.taxonomyIds.join("\u0000") === b.taxonomyIds.join("\u0000")
  );
}

/** 同科目再加一个知识点：并进已有的 id 表，重复点同一个不会加出第二行。 */
export function withTaxonomyId(binding: TopicBinding, taxonomyId: string, now: Date = new Date()): TopicBinding {
  return {
    schema: BINDING_SCHEMA,
    subject: binding.subject,
    examScope: binding.examScope,
    taxonomyIds: [...new Set([...binding.taxonomyIds, taxonomyId])],
    boundAt: now.toISOString(),
  };
}

/** 换科目/卷种是一次重绑：旧知识点 id 属于上一门课，留着只会拉出错科的题。 */
export function rebind(
  subject: string,
  examScope: string,
  taxonomyId: string,
  now: Date = new Date(),
): TopicBinding {
  return {
    schema: BINDING_SCHEMA,
    subject,
    examScope,
    taxonomyIds: [taxonomyId],
    boundAt: now.toISOString(),
  };
}

