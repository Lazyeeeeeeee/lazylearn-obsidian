# LazyLearn Obsidian 插件

把笔记里的知识点绑到懒学题库：就地看题、作答、判分、看解析，做错的题归档回笔记。
这是 Obsidian 插件的独立公开仓库。问题反馈与版本发布在本仓库管理。

现在能走通的完整动线：登录 → 绑定知识点 → 拉选择题 → 点选项 → 提交判分 → 看解析 →
把错题归档成一篇笔记（题面、选项、答案、解析进托管块，你自己写的那段留在块外），
或者一次把整本错题导入 vault。笔记还能**双向同步**（见下一节）。助教 SSE 还没做。

## 下载

从 [Releases](https://github.com/Lazyeeeeeeee/lazylearn-obsidian/releases/latest) 下载 main.js、manifest.json、styles.css，放入笔记库的 .obsidian/plugins/lazylearn/ 后启用。需要 Obsidian 1.11.4 或更新版本。

## 装到 vault

开发时最省事：把本仓库直接软链/复制成 `<vault>/.obsidian/plugins/lazylearn`，
或者构建后拷三个文件：

```powershell
cd lazylearn-obsidian
npm ci
npm run build
# 把 main.js、manifest.json、styles.css 复制到 <vault>/.obsidian/plugins/lazylearn/
```

然后在 Obsidian 里「设置 → 社区插件 → 重新载入 → 启用 LazyLearn」。
`manifest.json` 的 `minAppVersion` 是 `1.11.4`：会话存在 `app.secretStorage`，这个 API 从那一版才有。

## 用

1. 设置里填服务地址（例如 `https://lazylearn.example.com`），用懒学账号登录。
   密码只用于换 token，不写进 `data.json`、不进日志；token 进 Obsidian 的 SecretStorage。
2. 设置里选科目与卷种（首版：数学一/二/三、408）。
3. 打开一篇笔记 → 命令面板执行「LazyLearn: 绑定当前笔记的知识点」→ 搜知识点回车。
   同科目再绑一次是**追加**（一篇笔记可以挂多个知识点）；换科目/卷种重绑会**替换**掉旧的。
4. 侧栏（ribbon 图标或命令「打开练题侧栏」）按绑定拉 6 道选择题，「再来 6 题」按 cursor 继续。
5. 单选点一个、多选点多个 → 「提交」判分 → 「看解析」揭晓答案与解析。
   交过卷就锁住选项：单选/多选是**一次判定**，改答案只能重新拉一批。

> 交卷会带一个幂等键（`clientRequestId`）：第一次生成，失败重发沿用同一个。
> 服务端据此保证同一笔只落一条 Attempt、只回流一次复习，所以「超时了再点一次提交」
> 是安全的，不会变成「今天多错了一道」。

绑定只写笔记的 frontmatter，**正文不会上传**：

```yaml
lazylearn:
  schema: 1
  subject: math
  examScope: math1
  taxonomyIds:
    - <服务端知识点 id>
  boundAt: 2026-10-15T02:00:00.000Z
```

清除：命令面板「LazyLearn: 清除当前笔记的知识点绑定」。

## 命令

| 命令 | 作用 |
| --- | --- |
| 打开练题侧栏 | 右侧栏显示当前笔记的绑定与题目 |
| 绑定当前笔记的知识点 | 搜知识点，写进 frontmatter |
| 清除当前笔记的知识点绑定 | 删掉 frontmatter 里的 `lazylearn` |
| 重新拉取当前笔记的题目 | 丢掉本地那批，按绑定重拉第一页 |
| 归档本轮做错的题 | 把这一轮判为错的题各写一篇笔记 |
| 导入错题本 | 扫描整本错题，逐题归档（可取消） |
| 双向同步当前笔记 | 本地与服务端两边比一版，谁能覆盖谁由判定说话 |

侧栏每张卡上还有一个「归档」按钮，给单题用——归档不要求先在插件里作答，
原站做错的题一样收得进来。

## 双向同步

命令面板「LazyLearn: 双向同步当前笔记」，侧栏也有那颗按钮。

- **第一次同步 = 显式开启**。在此之前插件一个字节正文都不上传；点了之后这篇笔记才在懒学
  建一份对应（frontmatter 里落一个 `lazylearn.sync.noteId`，服务端存成 `externalId`）。
- **判定只看两个数**：服务端版本号，和「上次同步时那一段内容的哈希」。
  只有本地改了 → 推；只有服务端改了 → 拉；两边都改了 → **停下报冲突**，弹一次选择框
  （用本地覆盖 / 用服务端覆盖），插件不替你挑。
- **frontmatter 不参与同步**：标签、别名、绑定、同步本子都是本地的，服务端只拿正文。
- **归档笔记只同步错因那一段**：题面/解析是服务端下发的，同步上去只会制造一份会漂移的
  副本；托管块里的内容永远由插件管，块外的「我的错因」「下次怎么识别」才是双向的那一段。
- 服务端那边靠 `baseVersion` 做条件写：对不上回 409 并带回当前那一版。所以「读到之后
  别人又写了」不会被静默覆盖。

> 同步是**手动**触发的：没有后台定时、没有文件监听自动推。一篇笔记改动多了要自己点一下
> （首版故意保守：自动推之前在真 vault 里先跑顺）。

## 校验

```powershell
cd lazylearn-obsidian
npm ci
npm run typecheck   # tsc --noEmit
npm run smoke       # 10 秒，不联网：契约、错误分诊、绑定形状、取题去重、会话隔离、
                    #              作答状态机、归档渲染与冲突判定、媒体改写、幂等键沿用
npm run build       # 产出 main.js
npm run dev         # 监听 src/，改完自动重打包
```

## 代码结构

| 路径 | 干什么 |
| --- | --- |
| `src/main.ts` | 注册命令/侧栏/设置，事件绑定 |
| `src/api/client.ts` | HTTP 客户端与错误分诊（401 清会话、429 报额度） |
| `src/api/contracts.ts` | 服务端下发结构的最小镜像 + 运行时校验 |
| `src/api/obsidian-transport.ts` | 唯一的真实传输：`requestUrl`（无 CORS，但不支持流式读取） |
| `src/auth/session.ts` | token 的 SecretStorage 存取，按服务地址隔离 |
| `src/study/binding.ts` | frontmatter 绑定形状（纯函数） |
| `src/study/bind-topic.ts` | 读写笔记 frontmatter（`processFrontMatter`） |
| `src/study/practice.ts` | 一轮取题的去重与翻页（纯函数） |
| `src/study/answering.ts` | 一道题的作答状态机（纯函数） |
| `src/study/controller.ts` | 侧栏状态机：会话、绑定、取题、作答、归档 |
| `src/export/render-note.ts` | 归档笔记的渲染与覆盖判定（纯函数：托管块、哈希、路径） |
| `src/export/archive.ts` | 归档落地：索引、原子写入、认证下载附件、冲突上报 |
| `src/api/media.ts` | 题干媒体的识别与引用改写（纯函数） |
| `src/sync/plan.ts` | 双向同步的判定：谁改了、该推还是该拉（纯函数） |
| `src/sync/marker.ts` | frontmatter 里的同步本子（纯函数） |
| `src/sync/note-sync.ts` | 同步落地：读笔记 → 问服务端 → 写回 |
| `src/views/StudyView.tsx` | React 侧栏，题干走 `MarkdownRenderer`（LaTeX 由 Obsidian 渲染） |

## 还没做

- **同步是手动的**：没有后台定时、没有文件监听自动推；也只有开着笔记时才能同步。
- 同步不做正文合并：两边都改就得选一边（正文的合并猜错一次就是吃掉用户写的东西）。
- 幂等键只活在这一次会话里：插件重载（重启 Obsidian）后，同一笔提交会拿到新键。
  要彻底解决得把待提交的键落到磁盘，等需要离线作答队列时一起做。
- 解答题：只能归档，不能在侧栏作答（首版范围）。
- 英语：科目与卷种只开放数学与 408。
- 助教对话：`requestUrl` 不提供流式读取，SSE 得另找通道。
- 移动端：`manifest.json` 是 `isDesktopOnly: true`。

## 仓库管理

主分支为 main；日常修改通过分支和 Pull Request 管理。每次推送和 PR 都会运行冒烟与构建检查。发布前同步插件元数据与 package.json 的版本，再推送同版本的 v* 标签。

公开源码不代表授予开源许可；当前保留原有 UNLICENSED 授权状态。
