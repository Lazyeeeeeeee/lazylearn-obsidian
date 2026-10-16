import {
  parseAccount,
  parseErrorPage,
  parseNote,
  parseNoteList,
  parseQuestionCard,
  parseQuestionPage,
  parseRevealPayload,
  parseSubmitResult,
  parseTaxonomyNodes,
} from "./contracts.ts";
import type {
  Account,
  ErrorPage,
  Note,
  QuestionCard,
  QuestionPage,
  RevealPayload,
  SubmitResult,
  TaxonomyNode,
} from "./contracts.ts";
import type { HttpMethod, HttpTransport } from "./transport.ts";

/** 一次请求的失败。`status` 用来分诊（401 清会话、429 停手），`detail` 直接给用户看。 */
export class ApiError extends Error {
  readonly status: number;
  readonly retryAfterSeconds: number | null;

  constructor(status: number, detail: string, retryAfterSeconds: number | null = null) {
    super(detail);
    this.name = "ApiError";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }

  /** 429 是「今天题库读取额度用完」，不是网络抖动：重试没用，得停下来说清楚。 */
  get isThrottled(): boolean {
    return this.status === 429;
  }
}

export interface TaxonomyQuery {
  subject: string;
  examScope?: string | null;
}

export interface QuestionQuery {
  taxonomyId?: string | null;
  subject?: string | null;
  examScope?: string | null;
  kind?: string | null;
  limit?: number;
  cursor?: string | null;
}

export interface ErrorPageQuery {
  subject?: string | null;
  limit?: number;
  cursor?: string | null;
}

type QueryValue = string | number | boolean | null | undefined;

/** 拼查询串：空值不出现，避免服务端把 `subject=` 当成一个空学科。 */
export function buildUrl(baseUrl: string, path: string, query: Record<string, QueryValue> = {}): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined || value === "") continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  const suffix = parts.length > 0 ? `?${parts.join("&")}` : "";
  return `${baseUrl}${path}${suffix}`;
}


function detailOf(text: string, status: number): string {
  const trimmed = text.trim();
  if (trimmed === "") return `请求失败（HTTP ${status}）`;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null && "detail" in parsed) {
      const detail = (parsed as { detail: unknown }).detail;
      if (typeof detail === "string" && detail !== "") return detail;
      // FastAPI 的 422 是一张校验错误表，挑出人话那一段，别把 JSON 甩给用户。
      if (Array.isArray(detail)) {
        const messages = detail
          .map((item) =>
            typeof item === "object" && item !== null && "msg" in item ? String((item as { msg: unknown }).msg) : "",
          )
          .filter((message) => message !== "");
        if (messages.length > 0) return messages.join("；");
      }
    }
  } catch {
    // 不是 JSON（反代吐的 HTML 错误页）：原文比「请求失败」有用，截断后照给。
  }
  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
}

function retryAfterOf(headers: Record<string, string>): number | null {
  const raw = headers["retry-after"];
  if (raw === undefined) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

export class LazylearnClient {
  readonly baseUrl: string;
  readonly token: string | null;
  #transport: HttpTransport;

  constructor(transport: HttpTransport, baseUrl: string, token: string | null = null) {
    this.#transport = transport;
    this.baseUrl = baseUrl;
    this.token = token;
  }

  withToken(token: string | null): LazylearnClient {
    return new LazylearnClient(this.#transport, this.baseUrl, token);
  }

  async #requestRaw(
    method: HttpMethod,
    path: string,
    options: { query?: Record<string, QueryValue>; body?: unknown; accept?: string } = {},
  ): Promise<import("./transport.ts").HttpResponse> {
    const headers: Record<string, string> = { Accept: options.accept ?? "application/json" };
    if (this.token !== null && this.token !== "") headers["Authorization"] = `Bearer ${this.token}`;
    let body: string | null = null;
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.body);
    }
    const response = await this.#transport.send({
      url: buildUrl(this.baseUrl, path, options.query ?? {}),
      method,
      headers,
      body,
    });
    if (response.status >= 400) {
      throw new ApiError(response.status, detailOf(response.text, response.status), retryAfterOf(response.headers));
    }
    return response;
  }

  async #request(
    method: HttpMethod,
    path: string,
    options: { query?: Record<string, QueryValue>; body?: unknown } = {},
  ): Promise<unknown> {
    const response = await this.#requestRaw(method, path, options);
    if (response.text.trim() === "") return null;
    try {
      return JSON.parse(response.text) as unknown;
    } catch {
      throw new ApiError(response.status, "服务端返回的不是 JSON，检查服务地址是否填对");
    }
  }

  /** 媒体那条路：不解析 JSON，直接给字节。 */
  async #requestBytes(path: string): Promise<ArrayBuffer> {
    return (await this.#requestRaw("GET", path, { accept: "*/*" })).bytes;
  }

  /** 登录成功返回会话 token；密码只在这一趟里出现，绝不落盘。 */
  async login(username: string, password: string): Promise<string> {
    const payload = await this.#request("POST", "/api/auth/login", { body: { username, password } });
    if (typeof payload !== "object" || payload === null || !("token" in payload)) {
      throw new ApiError(200, "登录响应里没有 token，服务端与本插件版本不匹配");
    }
    const token = (payload as { token: unknown }).token;
    if (typeof token !== "string" || token === "") throw new ApiError(200, "登录响应里的 token 是空的");
    return token;
  }

  async me(): Promise<Account> {
    return parseAccount(await this.#request("GET", "/api/auth/me"));
  }

  async logout(): Promise<void> {
    await this.#request("POST", "/api/auth/logout");
  }

  async taxonomy(query: TaxonomyQuery): Promise<TaxonomyNode[]> {
    return parseTaxonomyNodes(
      await this.#request("GET", "/api/taxonomy", {
        query: { subject: query.subject, examScope: query.examScope ?? null },
      }),
    );
  }

  async questions(query: QuestionQuery): Promise<QuestionPage> {
    return parseQuestionPage(
      await this.#request("GET", "/api/questions", {
        query: {
          taxonomyId: query.taxonomyId ?? null,
          subject: query.subject ?? null,
          examScope: query.examScope ?? null,
          kind: query.kind ?? null,
          limit: query.limit ?? null,
          cursor: query.cursor ?? null,
        },
      }),
    );
  }

  async question(id: string): Promise<QuestionCard> {
    return parseQuestionCard(await this.#request("GET", `/api/questions/${encodeURIComponent(id)}`));
  }

  /**
   * 交一道选择题。
   *
   * `clientRequestId` 是幂等键：服务端据此保证同一笔只落一条 Attempt、只回流一次复习。
   * 调用方在**第一次**发出前生成、失败后沿用它重发——超时后重试因此是安全的。
   * 不传时行为与从前一致（每发一次就是一笔），所以别在重试路径上漏传。
   */
  async submitChoice(id: string, selected: readonly string[], clientRequestId?: string): Promise<SubmitResult> {
    return parseSubmitResult(
      await this.#request("POST", `/api/questions/${encodeURIComponent(id)}/submit`, {
        body: {
          answer: { type: "choice", selected: [...selected] },
          ...(clientRequestId === undefined ? {} : { clientRequestId }),
        },
      }),
    );
  }

  /**
   * 揭晓答案与解析。
   *
   * `review=true` 是给**复习场景**用的（错题本就属于这一档）：那里的动线天生是
   * 「先看答案再自评」，服务端因此放行未作答就能取。练习场景不传它，
   * 那条路要求先作答过。
   */
  async reveal(id: string, options: { review?: boolean } = {}): Promise<RevealPayload> {
    return parseRevealPayload(
      await this.#request("GET", `/api/questions/${encodeURIComponent(id)}/reveal`, {
        query: { review: options.review === true ? "1" : null },
      }),
    );
  }

  /**
   * 错题本一页。给「把错题搬回笔记」用：按不可变的 `(createdAt, id)` 往前扫，
   * 游标由服务端给、原样回传即可。整页都把卡面补齐了，所以这一页拿到就能直接渲染。
   */
  async errorCards(query: ErrorPageQuery): Promise<ErrorPage> {
    return parseErrorPage(
      await this.#request("GET", "/api/reviews/errors-page", {
        query: {
          subject: query.subject ?? null,
          limit: query.limit ?? null,
          cursor: query.cursor ?? null,
        },
      }),
    );
  }

  /** 下载题干媒体（带 token）。返回原始字节，交给 `Vault.createBinary` 落盘。 */
  async media(objectKey: string): Promise<ArrayBuffer> {
    const path = `/api/media/${objectKey.split("/").map(encodeURIComponent).join("/")}`;
    return this.#requestBytes(path);
  }

  // --- 笔记双向同步（/api/notes） ---

  /** 按外部标识认「我在这台服务器上有没有一篇」。没有就是 null（第一次同步）。 */
  async findNote(externalId: string): Promise<Note | null> {
    const items = parseNoteList(
      await this.#request("GET", "/api/notes", { query: { externalId, limit: 1 } }),
    );
    return items[0] ?? null;
  }

  /** 新建一篇属于外部客户端的笔记（带 externalId）。 */
  async createNote(input: { title: string; body: string; externalId: string }): Promise<Note> {
    return parseNote(
      await this.#request("POST", "/api/notes", {
        body: { title: input.title, body: input.body, externalId: input.externalId },
      }),
    );
  }

  /**
   * 条件写：带上上次读到的 `baseVersion`，服务端版本往前走过了就回 409
   * （`ApiError.status === 409`）——那说明别人在我们读之后又写过了，由调用方走冲突流程。
   */
  async updateNote(
    id: string,
    input: { title?: string; body?: string; baseVersion: number },
  ): Promise<Note> {
    return parseNote(
      await this.#request("PUT", `/api/notes/${encodeURIComponent(id)}`, { body: { ...input } }),
    );
  }
}

