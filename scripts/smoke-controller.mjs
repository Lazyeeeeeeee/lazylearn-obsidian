import assert from "node:assert/strict";
import { build } from "esbuild";

// 只替换宿主的文件类型；请求、选题和状态转换均运行真实插件实现。
const bundle = await build({
  entryPoints: ["src/study/controller.ts"], bundle: true, write: false,
  platform: "node", format: "esm",
  plugins: [{
    name: "smoke-obsidian",
    setup(builder) {
      builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "smoke" }));
      builder.onLoad({ filter: /.*/, namespace: "smoke" }, () => ({
        contents: 'export class TFile {} export const normalizePath = (path) => path;',
      }));
    },
  }],
});
const { StudyController } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
const file = { path: "A.md", basename: "A", extension: "md" };
const binding = { schema: 1, subject: "math", examScope: "math1", taxonomyIds: ["t1"], boundAt: "2026-10-20T00:00:00Z" };
const question = { id: "q1", kind: "single_choice", subject: "math", stem: "题面", autoGradable: true,
  options: [{ key: "A", text: "甲" }, { key: "B", text: "乙" }] };
const response = (payload, status = 200) => ({ status, text: JSON.stringify(payload), headers: {}, bytes: new ArrayBuffer(0) });
const replies = [];
const requests = [];
const secrets = new Map();
const controller = new StudyController({
  app: { metadataCache: { getFileCache: () => ({ frontmatter: { lazylearn: binding } }) } },
  secrets: { get: (id) => secrets.get(id) ?? "token", set: (id, value) => secrets.set(id, value) },
  settings: () => ({ baseUrl: "https://ll.test", subject: "math", examScope: "math1", archiveRoot: "LazyLearn" }),
  transport: { async send(request) {
    requests.push(request);
    assert.ok(replies.length, `意外请求：${request.url}`);
    return await replies.shift();
  } },
});
controller.setActiveNote(file);
replies.push(response({ id: "user", username: "user", nickname: "User" }), response({ items: [], nextCursor: null }));
await controller.initialize();

replies.push(response({ detail: "暂时不可用" }, 503));
await controller.loadPracticeGroup();
const failedInput = JSON.parse(requests.at(-1).body);
assert.match(controller.snapshot.message, /重试/);
replies.push(response({ questionIds: ["q1"], sessionId: failedInput.requestId }), response({ items: [question] }));
await controller.loadPracticeGroup();
assert.deepEqual(JSON.parse(requests.at(-2).body), failedInput);
assert.equal(controller.snapshot.round.cards[0].id, "q1");
assert.equal(controller.snapshot.round.pending.length, 0);
console.log("  ok   失败重试沿用题组 ID，批量题面正常进入侧栏");

controller.toggleOption(controller.snapshot.round.cards[0], "A");
let finishSubmit;
replies.push(new Promise((resolve) => { finishSubmit = resolve; }));
const submitting = controller.submitAnswer(controller.snapshot.round.cards[0]);
assert.equal("sessionId" in JSON.parse(requests.at(-1).body), false);
replies.push(response({ questionIds: ["q1"], sessionId: "next" }), response({ items: [question] }));
await controller.loadPracticeGroup();
assert.notEqual(JSON.parse(requests.at(-2).body).requestId, failedInput.requestId);
finishSubmit(response({ correct: true, score: 1, method: "exact", attemptId: "old" }));
await submitting;
assert.deepEqual(controller.snapshot.answers, {});
console.log("  ok   换组生成新 ID，旧作答响应不污染新组，提交不误带速刷会话");

replies.push(response({ detail: "Not Found" }, 404));
await controller.loadPracticeGroup();
assert.match(controller.snapshot.message, /尚不支持/);
assert.equal(controller.snapshot.round.cards[0].id, "q1");
console.log("  ok   旧版服务端明确提示并保留当前题目");

let finishGroup;
replies.push(new Promise((resolve) => { finishGroup = resolve; }));
const loading = controller.loadPracticeGroup();
const count = requests.length;
await controller.loadPracticeGroup();
assert.equal(requests.length, count);
controller.setActiveNote(null);
finishGroup(response({ questionIds: ["q1"], sessionId: "stale" }));
await loading;
assert.equal(requests.length, count);
assert.equal(controller.snapshot.round.cards.length, 0);
assert.equal(controller.snapshot.loadingMore, false);
console.log("  ok   重复点击不重发，切换笔记作废迟到题组且不再请求题面");
assert.equal(replies.length, 0);
