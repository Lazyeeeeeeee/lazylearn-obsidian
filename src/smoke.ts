/**
 * 10 秒冒烟：不联网、不要账号、不需要 Obsidian。
 * 跑：npm run smoke（在本仓库根目录下）
 *
 * 检的是「插件与服务的契约」这几条：DTO 认不认、错误分不分诊、绑定形状对不对、
 * 同一批题会不会重复、换服务器会不会串会话。真机联调不在这里。
 */

import { ApiError, LazylearnClient } from "./api/client.ts";
import { ContractError, formatAnswer, pickUsableChoices, parsePracticeGroup, parseRevealPayload, parseSubmitResult } from "./api/contracts.ts";
import type { QuestionCard, QuestionPage } from "./api/contracts.ts";
import type { HttpRequest, HttpResponse, HttpTransport } from "./api/transport.ts";
import { clearToken, readToken, saveToken, sessionSecretId } from "./auth/session.ts";
import type { SecretStore } from "./auth/session.ts";
import { DEFAULT_SETTINGS, normalizeBaseUrl, parseSettings, scopeFor } from "./settings.ts";
import {
  createBinding,
  readBinding,
  rebind,
  removeBindingFrom,
  withTaxonomyId,
  writeBindingInto,
} from "./study/binding.ts";
import { assetFileName, mediaRefOf, mediaRefsIn, rewriteMediaRefs } from "./api/media.ts";
import { fnv1a } from "./lib/hash.ts";
import { newNoteId, readSyncMarker, writeSyncMarkerInto } from "./sync/marker.ts";
import {
  applySyncedPart,
  hashOfSyncedPart,
  planSync,
  pushBaseVersion,
  splitFrontmatter,
  syncedPartOf,
} from "./sync/plan.ts";
import {
  MANAGED_END,
  MANAGED_START,
  accountTagFor,
  archivePath,
  buildBody,
  contentHash,
  decideArchive,
  renderManaged,
  splitBody,
  PERSONAL_SECTIONS,
} from "./export/render-note.ts";
import {
  applyReveal,
  applySubmit,
  beginSubmit,
  canSubmit,
  correctKeys,
  failAnswer,
  isLocked,
  optionVerdict,
  startAnswer,
  toggleOption,
} from "./study/answering.ts";
import { hasMore, kindLabel, mergePage, nextTopicIds, startRound } from "./study/practice.ts";

let failures = 0;

function check(label: string, passed: boolean, detail = ""): void {
  if (passed) {
    console.log(`  ok   ${label}`);
    return;
  }
  failures += 1;
  console.error(`  FAIL ${label}${detail === "" ? "" : ` — ${detail}`}`);
}

function equal(label: string, actual: unknown, expected: unknown): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  check(label, same, `实际 ${JSON.stringify(actual)} / 期望 ${JSON.stringify(expected)}`);
}

interface Reply {
  status: number;
  body: string;
  headers?: Record<string, string>;
  bytes?: ArrayBuffer;
}

class FakeTransport implements HttpTransport {
  requests: HttpRequest[] = [];
  #replies: Reply[];

  constructor(replies: Reply[]) {
    this.#replies = replies;
  }

  async send(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    const reply = this.#replies.shift() ?? { status: 500, body: JSON.stringify({ detail: "夹具不够用了" }) };
    return {
      status: reply.status,
      text: reply.body,
      bytes: reply.bytes ?? new ArrayBuffer(0),
      headers: reply.headers ?? {},
    };
  }
}

function card(id: string, kind: string, extra: Record<string, unknown> = {}): QuestionCard {
  return {
    id,
    kind,
    subject: "math",
    stem: `第 ${id} 题`,
    options: [
      { key: "A", text: "甲" },
      { key: "B", text: "乙" },
    ],
    examScopes: ["math1"],
    taxonomyIds: ["t1"],
    autoGradable: true,
    seq: null,
    assetUrls: [],
    ...extra,
  };
}

const fixtureCards = [
  {
    id: "q1",
    subject: "math",
    kind: "single_choice",
    stem: "第 1 题",
    autoGradable: true,
    options: [{ key: "A", text: "甲" }, { key: "B", text: "乙" }],
  },
  {
    id: "q2",
    subject: "math",
    kind: "multiple_choice",
    stem: "第 2 题",
    autoGradable: true,
    options: [{ key: "A", text: "甲" }, { key: "B", text: "乙" }],
  },
  { id: "q3", subject: "math", kind: "solve", stem: "证明题", autoGradable: false },
  {
    id: "q4",
    subject: "math",
    kind: "single_choice",
    stem: "第 4 题",
    autoGradable: false,
    options: [{ key: "A", text: "甲" }, { key: "B", text: "乙" }],
  },
];

console.log("契约");
const listing = new FakeTransport([
  { status: 200, body: JSON.stringify({ items: fixtureCards, nextCursor: "c2" }) },
]);
const client = new LazylearnClient(listing, "https://ll.test", "tok-1");
const page = await client.questions({ taxonomyId: "t1", subject: "math", examScope: "math1", limit: 6 });
equal("分页收下全部 items", page.items.length, 4);
equal("nextCursor 透传", page.nextCursor, "c2");
check("请求带上 taxonomyId 与 limit", (listing.requests[0]?.url ?? "").includes("taxonomyId=t1&subject=math&examScope=math1&limit=6"), listing.requests[0]?.url);
check("请求带 Bearer", listing.requests[0]?.headers["Authorization"] === "Bearer tok-1");
equal("只留可自动判分的选择题", pickUsableChoices(page.items).map((item) => item.id), ["q1", "q2"]);
equal("题型中文名", [kindLabel("single_choice"), kindLabel("multiple_choice"), kindLabel("solve")], ["单选", "多选", "解答"]);

console.log("新版个性化题组");
const groupTransport = new FakeTransport([
  { status: 200, body: JSON.stringify({ questionIds: ["q2", "q1", "q2"], sessionId: "group-1" }) },
  { status: 200, body: JSON.stringify({ items: fixtureCards }) },
]);
const groupClient = new LazylearnClient(groupTransport, "https://ll.test", "tok-1");
const groupInput = { requestId: "group-1", subject: "math", examScope: "math1", chapterIds: ["t1", "t2"], limit: 6 };
const group = await groupClient.practiceGroup(groupInput);
equal("题组 ID 去重并保留顺序", group.questionIds, ["q2", "q1"]);
equal("新版题组请求路径", groupTransport.requests[0]?.url, "https://ll.test/api/questions/practice-group");
equal("题组条件和重试 ID 原样传递", JSON.parse(groupTransport.requests[0]?.body ?? "{}"), groupInput);
equal("批量读取按题组顺序过滤响应", (await groupClient.questionsBatch(group.questionIds)).map((item) => item.id), ["q2", "q1"]);
equal("批量读取路径", groupTransport.requests[1]?.url, "https://ll.test/api/questions/batch");
equal("空题组无需读取题面", await groupClient.questionsBatch([]), []);
equal("空题组不发请求", groupTransport.requests.length, 2);
equal("服务端空题组合法", parsePracticeGroup({ questionIds: [], sessionId: "empty" }).questionIds, []);
for (const badIds of [null, [""], [3]]) {
  try {
    parsePracticeGroup({ questionIds: badIds, sessionId: "bad" });
    check("非法题组应当拒绝", false);
  } catch (error) {
    check("非法题组明确报契约错误", error instanceof ContractError);
  }
}
const batchIds = Array.from({ length: 101 }, (_, index) => `batch-${index}`);
const batchTransport = new FakeTransport([
  { status: 200, body: JSON.stringify({ items: [] }) },
  { status: 200, body: JSON.stringify({ items: [] }) },
]);
await new LazylearnClient(batchTransport, "https://ll.test", "tok").questionsBatch([...batchIds, batchIds[0]!]);
equal("批量上限 100 且去重", batchTransport.requests.map((request) => JSON.parse(request.body ?? "{}").ids.length), [100, 1]);

console.log("错误分诊");
const unauthorized = new FakeTransport([{ status: 401, body: JSON.stringify({ detail: "请先登录，或登录已过期" }) }]);
try {
  await new LazylearnClient(unauthorized, "https://ll.test", "bad").me();
  check("401 应当抛错", false);
} catch (error) {
  check(
    "401 抛 ApiError 且认得出未登录",
    error instanceof ApiError && error.isUnauthorized && error.message.includes("登录"),
    error instanceof Error ? error.message : String(error),
  );
}

const throttled = new FakeTransport([
  { status: 429, body: JSON.stringify({ detail: "今天的题库读取额度已用完" }), headers: { "retry-after": "3600" } },
]);
try {
  await new LazylearnClient(throttled, "https://ll.test", "tok").questions({ taxonomyId: "t1" });
  check("429 应当抛错", false);
} catch (error) {
  check(
    "429 带 Retry-After",
    error instanceof ApiError && error.isThrottled && error.retryAfterSeconds === 3600,
    error instanceof Error ? error.message : String(error),
  );
}

const html = new FakeTransport([{ status: 502, body: "<html>bad gateway</html>" }]);
try {
  await new LazylearnClient(html, "https://ll.test", "tok").me();
  check("502 应当抛错", false);
} catch (error) {
  check("非 JSON 错误页也给人话", error instanceof ApiError && error.message.includes("bad gateway"), error instanceof Error ? error.message : String(error));
}

console.log("绑定形状");
const frontmatter: Record<string, unknown> = {};
writeBindingInto(frontmatter, createBinding("math", "math1", ["t1", "t1", "t2"], new Date("2026-10-15T00:00:00Z")));
const binding = readBinding(frontmatter);
equal("taxonomyIds 去重", binding?.taxonomyIds.join(","), "t1,t2");
equal("boundAt 保留", binding?.boundAt, "2026-10-15T00:00:00.000Z");
equal(
  "同科目再加一个知识点",
  withTaxonomyId(binding!, "t3", new Date("2026-10-15T01:00:00Z")).taxonomyIds.join(","),
  "t1,t2,t3",
);
equal(
  "换科目重绑只留新知识点",
  rebind("cs408", "cs408", "q9", new Date("2026-10-15T02:00:00Z")).taxonomyIds.join(","),
  "q9",
);
removeBindingFrom(frontmatter);
check("清除后读不到", readBinding(frontmatter) === null);
check(
  "schema 不是 1 就不认",
  readBinding({ lazylearn: { schema: 2, subject: "math", examScope: "math1", taxonomyIds: ["t1"] } }) === null,
);
check(
  "没绑知识点就不算绑定",
  readBinding({ lazylearn: { schema: 1, subject: "math", examScope: "math1", taxonomyIds: [] } }) === null,
);
check("frontmatter 里没有这一项就没有绑定", readBinding({ tags: ["x"] }) === null);

console.log("一轮取题");
let round = startRound(["t1", "t2"]);
equal("初始两个知识点都待取", nextTopicIds(round).join(","), "t1,t2");
round = mergePage(round, "t1", { items: [card("q1", "single_choice"), card("q2", "multiple_choice")], nextCursor: "c2" });
round = mergePage(round, "t2", { items: [card("q2", "multiple_choice"), card("q3", "single_choice")], nextCursor: null });
equal("跨知识点去重", round.cards.map((item) => item.id).join(","), "q1,q2,q3");
equal("t2 到底了就不再取", nextTopicIds(round).join(","), "t1");
check("t1 还有下一页", hasMore(round));
round = mergePage(round, "t1", { items: [card("q1", "single_choice"), card("q4", "single_choice")], nextCursor: null });
equal("第二页只补新题", round.cards.map((item) => item.id).join(","), "q1,q2,q3,q4");
check("翻到底就没有下一页", !hasMore(round));
const noChoice: QuestionPage = { items: [card("q5", "solve")], nextCursor: null };
const onlySolve = mergePage(startRound(["t3"]), "t3", noChoice);
equal("解答题不进选择题回合", onlySolve.cards.length, 0);
check("解答题落地后也不再请求", !hasMore(onlySolve));

console.log("会话隔离");
const secrets = new Map<string, string>();
const store: SecretStore = {
  get: (id) => secrets.get(id) ?? null,
  set: (id, value) => {
    secrets.set(id, value);
  },
};
saveToken(store, "https://a.test", "tok-a");
equal("读回 token", readToken(store, "https://a.test"), "tok-a");
check("换服务器读不到别的 token", readToken(store, "https://b.test") === null);
check("secret id 只含小写字母数字与短横线", /^[a-z0-9-]+$/.test(sessionSecretId("https://A.test/x")));
clearToken(store, "https://a.test");
check("登出后读不到", readToken(store, "https://a.test") === null);
check("没填服务地址时不读写密钥", readToken(store, "") === null);

console.log("设置纠正");
equal("缺协议补 https", normalizeBaseUrl("lazylearn.test/"), "https://lazylearn.test");
equal("多余的斜杠去掉", normalizeBaseUrl("http://127.0.0.1:8000//"), "http://127.0.0.1:8000");
equal("科目换了卷种跟着换", scopeFor("cs408", "math1"), "cs408");
equal("卷种合法就不动", scopeFor("math", "math2"), "math2");
const parsed = parseSettings({
  baseUrl: "lazylearn.test",
  subject: "cs408",
  examScope: "math1",
  archiveRoot: "/LazyLearn//",
});
equal(
  "坏配置纠正成可用的",
  [parsed.baseUrl, parsed.subject, parsed.examScope, parsed.archiveRoot].join("|"),
  "https://lazylearn.test|cs408|cs408|LazyLearn",
);
equal("空配置回到默认科目", parseSettings(undefined).subject, DEFAULT_SETTINGS.subject);

console.log("作答状态机");
const single = startAnswer();
check("刚开始没有可交的答案", !canSubmit(single));
const picked = toggleOption(single, "B", false);
equal("单选选中一个", picked.selected.join(","), "B");
check("选了就能交", canSubmit(picked));
equal("单选再点同一个就取消", toggleOption(picked, "B", false).selected.length, 0);
const multi = toggleOption(toggleOption(startAnswer(), "A", true), "C", true);
equal("多选累加", multi.selected.join(","), "A,C");
equal("多选再点同一个就删掉", toggleOption(multi, "A", true).selected.join(","), "C");

const submitting = beginSubmit(multi);
check("飞行中锁定", isLocked(submitting) && !canSubmit(submitting));
equal("飞行中改不了选项", toggleOption(submitting, "D", true).selected.join(","), "A,C");
check("飞行中再点提交不会重发", beginSubmit(submitting).stage === "submitting");

const result = parseSubmitResult({ correct: false, score: 0, method: "key", attemptId: "att-1" });
const submitted = applySubmit(submitting, result);
equal("拿到判分就变成已提交", submitted.stage, "submitted");
equal("已提交留着 attemptId", submitted.result?.attemptId, "att-1");
check("已提交后锁住选项", isLocked(submitted));
check("没在提交中的状态收不到判分", applySubmit(startAnswer(), result).stage === "answering");

const failed = failAnswer(submitting, "网断了");
equal("提交失败回到可答", failed.stage, "answering");
equal("提交失败留一句话", failed.error, "网断了");
check("失败后还能再交", canSubmit(failed));

// 正确答案是 A、C，而他选的是 A、B：三种记号都该出现。
const reveal = parseRevealPayload({ answer: ["A", "C"], analysis: "解析正文", trick: null, aiAnalysis: null });
const misgraded = applySubmit(
  beginSubmit(toggleOption(toggleOption(startAnswer(), "A", true), "B", true)),
  result,
);
const revealed = applyReveal(misgraded, reveal);
equal("揭晓后 stage", revealed.stage, "revealed");
equal("正确答案取出来", correctKeys(revealed).join(","), "A,C");
equal("选对的选项", optionVerdict(revealed, "A"), "correct");
equal("漏选的选项", optionVerdict(revealed, "C"), "missed");
equal("选错的选项", optionVerdict(revealed, "B"), "wrong");
equal("没选的错误选项不给记号", optionVerdict(revealed, "D"), null);
equal("没揭晓就没有记号", optionVerdict(submitted, "A"), null);
check("揭晓不能盖掉还没交的卷", applyReveal(startAnswer(), reveal).stage === "answering");

console.log("参考答案显示");
equal("选择题答案", formatAnswer(["A", "C"]), "A、C");
equal("解答题答案", formatAnswer("由泰勒公式可得"), "由泰勒公式可得");
equal("填空题答案", formatAnswer([{ id: "1", answer: ["2", "2.0"] }]), "1: 2、2.0");
equal("没答案就是空串", formatAnswer(null), "");
equal("数组里的散装项也能念", formatAnswer([["A"], "B"]), "A、B");

console.log("交卷与揭晓的请求");
const submitTransport = new FakeTransport([
  { status: 200, body: JSON.stringify({ correct: true, score: 1, method: "key", attemptId: "att-9" }) },
  { status: 200, body: JSON.stringify({ answer: ["B"], analysis: "因为 B", aiAnalysis: null, trick: null }) },
]);
const answerClient = new LazylearnClient(submitTransport, "https://ll.test", "tok-2");
const submitResult = await answerClient.submitChoice("q1", ["B"]);
equal("判分结果解析", [submitResult.correct, submitResult.attemptId].join("|"), "true|att-9");
const revealPayload = await answerClient.reveal("q1");
equal("揭晓解析", formatAnswer(revealPayload.answer), "B");
equal("交卷走 POST 且正文是 choice 形状", [submitTransport.requests[0]?.method, submitTransport.requests[0]?.body].join("|"), `POST|${JSON.stringify({ answer: { type: "choice", selected: ["B"] } })}`);
equal("揭晓走 GET", [submitTransport.requests[1]?.method, submitTransport.requests[1]?.url].join("|"), "GET|https://ll.test/api/questions/q1/reveal");


console.log("归档笔记的渲染");
const archivedCard: QuestionCard = card("q-77", "single_choice", {
  stem: "题干见图 ![图](/api/media/seed/a.png)",
  options: [
    { key: "A", text: "甲" },
    { key: "B", text: "乙" },
  ],
});
const archivedReveal = parseRevealPayload({
  answer: ["B"],
  analysis: "因为 ![图](/api/media/seed/a.png) 所以选乙",
  trick: "看单位",
  aiAnalysis: null,
});
const mediaMapping = new Map([["/api/media/seed/a.png", "./q-77/assets/a.png"]]);
const managed = renderManaged(archivedCard, archivedReveal, mediaMapping);
check("托管块带上题干", managed.includes("题干见图"), managed);
check("托管块换算媒体引用", managed.includes("](./q-77/assets/a.png)"), managed);
check("托管块带上了正确答案", managed.includes("**正确答案**：B"), managed);
check("托管块带上了解析与技巧", managed.includes("看单位") && managed.includes("所以选乙"), managed);
const withoutReveal = renderManaged(archivedCard, null);
check("取不到解析时留一句话", withoutReveal.includes("解析没取到"), withoutReveal);

const fresh = buildBody(null, managed);
check("新建笔记有托管块", fresh.includes(MANAGED_START) && fresh.includes(MANAGED_END));
check("新建笔记带两个个人段落", PERSONAL_SECTIONS.every((heading) => fresh.includes(heading)), fresh);
const split = splitBody(fresh);
equal("拆出来是 present", split.managed.kind, "present");
equal("拆出来的托管内容与写进去的一致", split.managed.kind === "present" ? split.managed.text.trim() : "", managed.trim());

const withPersonal = fresh.replace(
  `${PERSONAL_SECTIONS[0]}`,
  `${PERSONAL_SECTIONS[0]}\n这段是我自己写的，别动。`,
);
const rebuilt = buildBody(withPersonal, `${managed}\n\n补一条新解析。`);
check("个人段落原样保留", rebuilt.includes("这段是我自己写的，别动。"), rebuilt);
check("托管块被更新", rebuilt.includes("补一条新解析。"), rebuilt);
check("个人段落没被挪进托管块", rebuilt.indexOf("这段是我自己写的") > rebuilt.indexOf(MANAGED_END), rebuilt);

console.log("重复归档与冲突");
const hashOfManaged = contentHash(managed.trim());
equal("同样的内容再归档一次是跳过", decideArchive({ body: fresh, managedHash: hashOfManaged }, managed).action, "skip");
equal("内容变了、哈希对得上 → 覆盖", decideArchive({ body: fresh, managedHash: hashOfManaged }, `${managed}\n新解析`).action, "update");
equal(
  "哈希对不上（用户改过托管块）→ 冲突",
  decideArchive({ body: fresh, managedHash: "deadbeef" }, `${managed}\n新解析`).action,
  "conflict",
);
const broken = fresh.replace(MANAGED_END, "");
equal("标记不成对 → 冲突", decideArchive({ body: broken, managedHash: hashOfManaged }, managed).action, "conflict");
const noBlock = "# 手抄的一道题\n\n我自己写的。\n";
equal("老档案（没有托管块）→ 补上", decideArchive({ body: noBlock, managedHash: null }, managed).action, "update");
check(
  "老档案补托管块时保住原文",
  (decideArchive({ body: noBlock, managedHash: null }, managed).body ?? "").includes("我自己写的。"),
);
const conflict = decideArchive({ body: fresh, managedHash: "deadbeef" }, "换了内容");
equal("冲突时不产出新正文", conflict.body, null);
equal("冲突原因说得清", conflict.reason.includes("托管块"), true);

console.log("归档路径与媒体");
equal("路径按 服务·账号/学科/题号 分层", archivePath("LazyLearn", "ll.test-u1", "math", "q-1"), "LazyLearn/ll.test-u1/math/q-1.md");
equal("路径里的危险字符被清洗", archivePath("LazyLearn", "a:b", "math", "q/1"), "LazyLearn/a_b/math/q_1.md");
equal("账号目录用主机名", accountTagFor("https://lazylearn.test/x", "u1"), "lazylearn.test-u1");
equal("地址不规范时退回原串", accountTagFor("lazylearn.test", "u1"), "lazylearn.test-u1");
const ref = mediaRefOf("/api/media/seed/a.png");
equal("认得站内媒体地址", ref?.objectKey, "seed/a.png");
equal("站外地址不认", mediaRefOf("https://cdn.example.com/a.png"), null);
equal("越界路径不认", mediaRefOf("/api/media/../etc/passwd"), null);
equal("文件名只取末段", assetFileName("chat/u1/deep/a.png"), "a.png");
equal("文本里的媒体地址能全找出来", mediaRefsIn("见 ![](/api/media/seed/a.png) 与 /api/media/seed/b.png").length, 2);
equal("同一个地址只算一次", mediaRefsIn("/api/media/seed/a.png 再来一次 /api/media/seed/a.png").length, 1);
equal("改写只换精确匹配", rewriteMediaRefs("见 /api/media/seed/a.png", mediaMapping), "见 ./q-77/assets/a.png");

console.log("错题本分页");
const errorTransport = new FakeTransport([
  {
    status: 200,
    body: JSON.stringify({
      items: [
        {
          id: "rev-1",
          questionId: "q-9",
          bankSubject: "math",
          dueAt: "2026-10-01T00:00:00+00:00",
          createdAt: "2026-09-01T00:00:00+00:00",
          stats: { correct: 0, wrong: 3 },
          question: { id: "q-9", kind: "single_choice", stem: "题干", options: [{ key: "A", text: "甲" }] },
        },
      ],
      nextCursor: "cursor-2",
    }),
  },
]);
const errorClient = new LazylearnClient(errorTransport, "https://ll.test", "tok-3");
const errorPage = await errorClient.errorCards({ subject: "math", limit: 50 });
equal("错题卡解析出题号", errorPage.items[0]?.questionId, "q-9");
equal("错题卡带上错次", errorPage.items[0]?.wrongCount, 3);
equal("错题卡带上卡面", errorPage.items[0]?.question.stem, "题干");
equal("游标透传", errorPage.nextCursor, "cursor-2");
check("请求带上 subject 与 limit", (errorTransport.requests[0]?.url ?? "").includes("subject=math&limit=50"), errorTransport.requests[0]?.url);
const emptyCursor = await new LazylearnClient(new FakeTransport([{ status: 200, body: JSON.stringify({ items: [], nextCursor: null }) }]), "https://ll.test", "t").errorCards({ subject: "math" });
equal("没有下一页时游标是 null", emptyCursor.nextCursor, null);

console.log("归档触发的请求");
const archiveTransport = new FakeTransport([
  { status: 200, body: JSON.stringify({ answer: ["A"], analysis: "解析", aiAnalysis: null, trick: null }) },
]);
const archiveClient = new LazylearnClient(archiveTransport, "https://ll.test", "tok-4");
await archiveClient.reveal("q-9", { review: true });
equal("复习场景揭晓带 review=1", archiveTransport.requests[0]?.url, "https://ll.test/api/questions/q-9/reveal?review=1");
const mediaReply = { status: 200, body: "", bytes: new Uint8Array([1, 2, 3]).buffer };
const mediaTransport = new FakeTransport([mediaReply]);
const bytes = await new LazylearnClient(mediaTransport, "https://ll.test", "tok-5").media("chat/u1/a.png");
equal("媒体下载走字节而不是文本", new Uint8Array(bytes).join(","), "1,2,3");
equal("媒体地址按对象键拼", mediaTransport.requests[0]?.url, "https://ll.test/api/media/chat/u1/a.png");
equal("媒体请求也带 token", mediaTransport.requests[0]?.headers["Authorization"], "Bearer tok-5");

console.log("提交带幂等键");
const idemTransport = new FakeTransport([
  { status: 200, body: JSON.stringify({ correct: false, score: 0, method: "key", attemptId: "att-1" }) },
  { status: 200, body: JSON.stringify({ correct: false, score: 0, method: "key", attemptId: "att-1", replay: true }) },
]);
const idemClient = new LazylearnClient(idemTransport, "https://ll.test", "tok-6");
const firstSubmit = await idemClient.submitChoice("q1", ["C"], "req-1");
const retried = await idemClient.submitChoice("q1", ["C"], "req-1");
equal("首次提交不带 replay", firstSubmit.replay, false);
equal("重发认得出是重放", retried.replay, true);
equal("两次的 attemptId 一样", [firstSubmit.attemptId, retried.attemptId].join("|"), "att-1|att-1");
equal(
  "请求正文里带 clientRequestId",
  JSON.parse(idemTransport.requests[1]?.body ?? "{}").clientRequestId,
  "req-1",
);
const noKeyTransport = new FakeTransport([{ status: 200, body: JSON.stringify({ correct: true, score: 1, method: "key", attemptId: "att-2" }) }]);
await new LazylearnClient(noKeyTransport, "https://ll.test", "tok-7").submitChoice("q1", ["A"]);
equal("不给键时正文里没有这个字段", "clientRequestId" in JSON.parse(noKeyTransport.requests[0]?.body ?? "{}"), false);

console.log("重试沿用同一个幂等键");
const firstAttempt = beginSubmit(toggleOption(startAnswer(), "B", false));
const firstKey = firstAttempt.requestId;
check("提交前生成了幂等键", typeof firstKey === "string" && firstKey.length > 0);
const afterFailure = failAnswer(firstAttempt, "网断了");
const retry = beginSubmit(afterFailure);
equal("重试用的是同一个键", retry.requestId, firstKey);
check("重试后仍是提交中", retry.stage === "submitting");
check("键不会因为判分成功而重置", applySubmit(firstAttempt, parseSubmitResult({ correct: true, score: 1, method: "key", attemptId: "att-3" })).requestId === firstKey);


console.log("双向同步：谁改了谁说话");
const marker = { noteId: "obs-1", version: 3, hash: fnv1a("本地这一版"), at: null };
const pulled = { id: "note-1", title: "标题", body: "服务端那一版", version: 3, externalId: "obs-1" };
equal("第一次同步（还没本子）→ 推上去", planSync({ marker: null, localHash: "x", server: null }).action, "create");
equal(
  "服务端那篇没了 → 按本地重建",
  planSync({ marker, localHash: marker.hash, server: null }).action,
  "create",
);
equal(
  "两边都没动 → 不用管",
  planSync({ marker, localHash: marker.hash, server: pulled }).action,
  "in-sync",
);
equal(
  "只有本地改了 → 推",
  planSync({ marker, localHash: fnv1a("改过的"), server: pulled }).action,
  "push",
);
equal(
  "只有服务端改了 → 拉",
  planSync({ marker, localHash: marker.hash, server: { ...pulled, version: 4 } }).action,
  "pull",
);
equal(
  "两边都改了 → 冲突，不猜",
  planSync({ marker, localHash: fnv1a("改过的"), server: { ...pulled, version: 4 } }).action,
  "conflict",
);
equal(
  "冲突时选了本地 → 推",
  planSync({ marker, localHash: fnv1a("改过的"), server: { ...pulled, version: 4 }, resolution: "local" }).action,
  "push",
);
equal(
  "冲突时选了服务端 → 拉",
  planSync({ marker, localHash: fnv1a("改过的"), server: { ...pulled, version: 4 }, resolution: "server" }).action,
  "pull",
);
equal("推的时候带上服务端当前版本（条件写）", pushBaseVersion({ action: "push", reason: "" }, pulled), 3);
equal("不推的时候没有 baseVersion", pushBaseVersion({ action: "pull", reason: "" }, pulled), null);

console.log("双向同步：哪一段算同步单位");
const plainNote = "---\ntags: [x]\n---\n正文第一行\n第二行\n";
const plainParts = splitFrontmatter(plainNote);
equal("frontmatter 被摘出去", plainParts.frontmatter, "---\ntags: [x]\n---\n");
equal("普通笔记同步整段正文", syncedPartOf(plainNote, null).trim(), "正文第一行\n第二行");
check("frontmatter 不进哈希", hashOfSyncedPart(plainNote, null) === fnv1a("正文第一行\n第二行"));
const renamed = plainNote.replace("tags: [x]", "tags: [y]");
equal("只改 frontmatter 不算本地改动", hashOfSyncedPart(renamed, null), hashOfSyncedPart(plainNote, null));

const archiveNote = `---\nlazylearn:\n  kind: error-archive\n---\n# 题干\n\n${MANAGED_START}\n题面与解析\n${MANAGED_END}\n\n## 我的错因\n\n当时没想到用泰勒。\n`;
equal(
  "归档笔记只同步托管块之后那一段",
  syncedPartOf(archiveNote, "error-archive").trim(),
  "## 我的错因\n\n当时没想到用泰勒。",
);
const repulled = applySyncedPart(archiveNote, "error-archive", "## 我的错因\n\n网页上补的一句。");
check("拉回来时托管块原样留着", repulled.includes("题面与解析") && repulled.includes(MANAGED_START));
check("拉回来时换掉了错因那一段", repulled.includes("网页上补的一句。"), repulled);
check("拉回来时没留下旧的错因", !repulled.includes("当时没想到用泰勒。"));
check("拉回来时 frontmatter 还在", repulled.startsWith("---\nlazylearn:\n  kind: error-archive\n---\n"));
const noManagedBlock = applySyncedPart("---\ntags: [x]\n---\n老的正文\n", "error-archive", "新的一段");
check(
  "托管块不在时不猜、只接着写",
  noManagedBlock.includes("老的正文") && noManagedBlock.includes("新的一段"),
  noManagedBlock,
);

console.log("双向同步：本子");
const syncFrontmatter: Record<string, unknown> = {};
writeSyncMarkerInto(syncFrontmatter, {
  noteId: "obs-9",
  version: 7,
  hash: "abc12345",
  at: "2026-10-15T00:00:00.000Z",
});
const markerBack = readSyncMarker(syncFrontmatter);
equal("本子写得进读得出", [markerBack?.noteId, markerBack?.version, markerBack?.hash].join("|"), "obs-9|7|abc12345");
check("本子不碰别人那一格", "lazylearn" in syncFrontmatter);
check("版本号不是数字就不认", readSyncMarker({ lazylearn: { sync: { noteId: "obs-1", version: "3", hash: "x" } } }) === null);
check("没本子就是 null", readSyncMarker({ lazylearn: { subject: "math" } }) === null);
check("externalId 前缀稳定", newNoteId("abc").startsWith("obs-"));

console.log("双向同步：打给服务端的请求");
const noteTransport = new FakeTransport([
  {
    status: 200,
    body: JSON.stringify({ items: [{ id: "note-1", title: "T", body: "服务端正文", version: 4, externalId: "obs-1", updatedAt: "2026-10-15T00:00:00Z" }] }),
  },
  {
    status: 200,
    body: JSON.stringify({ id: "note-2", title: "T", body: "新推的", version: 1, externalId: "obs-2", updatedAt: "2026-10-15T00:00:00Z" }),
  },
  {
    status: 409,
    body: JSON.stringify({ detail: "这篇笔记已经被别处改过了", note: { id: "note-1", title: "T", body: "别人的", version: 5, externalId: "obs-1", updatedAt: "x" } }),
  },
]);
const noteClient = new LazylearnClient(noteTransport, "https://ll.test", "tok-9");
const found = await noteClient.findNote("obs-1");
equal("按 externalId 找得到", [found?.id, found?.version].join("|"), "note-1|4");
check("查找带上 externalId", (noteTransport.requests[0]?.url ?? "").includes("externalId=obs-1"), noteTransport.requests[0]?.url);
const created = await noteClient.createNote({ title: "T", body: "新推的", externalId: "obs-2" });
equal("新建带上 externalId", JSON.parse(noteTransport.requests[1]?.body ?? "{}").externalId, "obs-2");
equal("新建返回版本 1", created.version, 1);
try {
  await noteClient.updateNote("note-1", { body: "我这一版", baseVersion: 3 });
  check("版本对不上应当抛 409", false);
} catch (error) {
  check(
    "版本对不上抛 ApiError(409) 并带上服务端的话",
    error instanceof ApiError && error.status === 409 && error.message.includes("改过"),
    error instanceof Error ? error.message : String(error),
  );
}
equal("条件写带 baseVersion 且走 PUT", [noteTransport.requests[2]?.method, JSON.parse(noteTransport.requests[2]?.body ?? "{}").baseVersion].join("|"), "PUT|3");

if (failures > 0) {
  console.error(`\n${failures} 项没过`);
  process.exit(1);
}
console.log("\n冒烟通过：契约、错误分诊、绑定形状、取题去重、会话隔离、作答状态机、双向同步都符合预期。");

