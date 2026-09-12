# AGENTS.md · WisdoMark 工作约定

> 给所有在此仓库上工作的 AI / 协作者的交接文档。开工前先读完本节。
> 完整任务书在仓库外（用户本地维护），此处只固化**不可动摇的约定**。

---

## 一、项目定位

本地运行的「学习资料消化器」：读浏览器收藏夹或粘贴链接 → AI 自动分类归档 → 生成一句话摘要 + 3 个核心观点 → 基于用户自身状况提炼「可行动的下一步」。

**核心卖点**：不是「又一个剪藏 demo」，而是**带评测与护栏的本地 AI 工具**。差异化来自「画像推断 → 可行动清单」和「可量化的失败率评测」。

---

## 二、已拍板的架构决策（不要重新纠结）

| 决策点 | 结论 |
|---|---|
| 产品形态 | 纯 Chrome MV3 插件，**无独立后端** |
| 桌面 exe | **放弃**（逆解析书签文件脆、打包重） |
| 后端语言 | **不要**（FastAPI / Next.js 都不需要），业务逻辑全在 service worker |
| 云端 | **本地优先，零云零费**；云端模型是后期可选项，不是必需 |
| 数据库 | `chrome.storage.local` + IndexedDB；**不用** Neon / PG |
| 部署 | 暂不部署，走本地交付（README + 录屏 + 开源仓库即展示物） |
| 参考项目 Karakeep | **只读设计，禁止复制源码**（AGPL 传染条款） |
| 内容源 | 只做**网页文章**；B 站字幕需 cookie + 接口已停更，**暂缓** |
| 抓正文路径 | **当前页注入**：`chrome.scripting` 运行时注入 content script，抓到 DOM 后再解析 |
| 主机权限 | `host_permissions` 含 `*://*/*`（见下方说明，`activeTab` 已证明不可靠） |
| 评测与插件的关系 | **单一来源**：prompt / 分类体系 / 校验规则放 `shared/`，插件与 Python 脚本读同一份；Python 只做批量调用 + 打分，不重写业务逻辑 |
| 抓正文实现 | 阶段 1 用原生 DOM 提取；Readability 后续再评估 |
| 模型 | 本地 `qwen3:8b` 起步 |

---

## 三、硬约束

| 项 | 内容 |
|---|---|
| 时间 | 每周可支配 10–15 小时，投递窗口 2026-11-20 起 |
| 提交 | commit message **一律中文**；**改动不论大小都单独提交并立即推送**，绝不攒批 |
| 推送后 | `git ls-remote <remote> main` 与本地一致 |
| 依赖 | 不为了解决问题而装新软件，优先零安装 / 轻依赖；新增依赖须先说明为什么必须加 |
| 禁止改动 | **不得改动 `D:\PROJECT\NaviRAG` 的任何文件**（只读参考可以） |
| 语言 | 全中文交流；**代码注释用中文** |

### 双远端推送（GitHub + Gitee）

本仓库有 **两个远端**：`github`（MaPleooo9/WisdoMark）与 `gitee`（iKnowuHateme/wisdo-mark）。
`main` 的上游跟踪只指向其中一个（目前是 `gitee`）。

**因此：`git status` 显示 up to date 只能证明本地与上游那个远端一致，不能证明双端同步。**
每次改动都要**显式**推两个远端，并以 `git ls-remote` 做校验：

```bash
git push github main
git push gitee main
git ls-remote --heads github main
git ls-remote --heads gitee main   # 两行哈希应与 git rev-parse HEAD 相同
```


---

### 运行前置：`OLLAMA_ORIGINS` 必须放行扩展来源

阶段 1 实测踩到：插件状态灯是绿的（探活成功），一消化就报 `HTTP 403`，5ms 返回、模型根本没被调用。

根因是 Ollama 的 **Origin 白名单**，不是插件代码问题：

| 事实 | 说明 |
|---|---|
| Ollama 默认只放行 `localhost` / `127.0.0.1` 等来源 | `chrome-extension://` 不在其中 |
| 它拦的是**带 `Origin` 头**的请求 | 实测：`GET /api/tags` 不带 Origin → 200；带 Origin → 403 |
| 探活为什么能过 | 扩展发的 GET 是「简单请求」，浏览器不附加 Origin |
| 调模型为什么必挂 | `POST` + `Content-Type: application/json` 触发跨源语义，浏览器附上 Origin → 403 |

**表现具有欺骗性：状态灯绿 + 一用就失败**，极易误判成模型或代码问题。

解法（一次性环境配置，非代码改动）：

```bash
setx OLLAMA_ORIGINS "chrome-extension://*"
# 然后完全退出 Ollama（托盘右键退出）再重新打开
```

`OLLAMA_ORIGINS` 是**追加**到默认白名单，不会破坏 localhost 访问。

代码侧已做的配合：`src/background/llm.js` 的 `describeHttpFailure()` 会把 403 直接翻译成这句可操作提示，
不让用户只看到一个裸状态码。**以后新增 Ollama 调用路径时，错误都要过这个函数。**

> 备选方案（未采用，仅记录）：用 `declarativeNetRequest` 删掉请求的 `Origin` 头可绕开，但需要额外权限且属于钻空子，不如环境变量正规。

---

## 四、代码约定

- **原生 JS 起步，暂不引入构建工具**；先跑通再工程化。
- `service worker` 会被浏览器随时回收 —— **状态一律落 `chrome.storage`，不要依赖内存变量跨事件存活**。
- 权限最小化：用 `scripting` **运行时按需注入**，不写静态 `content_scripts`。
  但 **`host_permissions` 必须含 `*://*/*`**，不能只靠 `activeTab` —— 原因见下节。

### 为什么必须放 `*://*/*`，不能靠 `activeTab`

阶段 0 实测踩到：侧栏点「抓取正文」报
`Cannot access contents of url "..." Extension manifest must request permission to access this host`。

根因两条，都是结构性的，不是配置笔误：

1. **`activeTab` 是"一次性"授权**：只在用户点扩展图标那一刻授予，且扩展 UI 常驻时第二次调用就失效。侧栏恰恰是常驻 UI，用户何时点抓取不可预测 —— 这个组合天生不稳。
2. **`activeTab` 覆盖不到"收藏夹里的链接"**：那根本不是当前标签页。阶段 1 的核心输入就是收藏链接，`activeTab` 从设计上就用不上。

**结论**：`host_permissions` 必须包含 `*://*/*`。

**后续可选的工程化方向**（未做，别当成已完成）：改成 `optional_host_permissions` + `chrome.permissions.request()`，
由侧栏按钮手势触发按需申请。好处是安装时不显示「读取所有网站数据」，权限叙事更干净；
代价是引入「未授权 / 已授权 / 被拒」三态 UI。留到阶段 4 打磨期再评估。
- Ollama 调用统一走 service worker，侧栏只通过 `chrome.runtime.sendMessage` 通信。
- 结构化输出：Ollama `format: json` + 解析校验 + 失败重试（有次数上限）。

---

## 五、工作方式

1. **按阶段交付**，每阶段完成后停下等验证，不要一次生成整个项目。
2. 遇到未拍板的取舍，**给 2 个具体方案并说明推荐哪个**，不要列抽象选项。
3. 输出用表格 / 结构化列表，少写长段落。
4. 每完成一个可运行的改动，**提醒用户单独提交并推送**。
5. 任何结论标注：哪些是**已验证事实**，哪些是**推断**。

---

## 六、当前阶段

**阶段 1 · 最小闭环**（代码完成，等浏览器验收）。

验收标准：粘贴一个链接，侧栏渲染出合法 JSON 的摘要 + 3 个观点。

阶段划分与验收标准见 `README.md` 的阶段进度表。

### 阶段 1 已落地的结构

```
shared/prompt.json           prompt 模板 + 调用参数（唯一来源）
shared/output-schema.json    输出结构与校验规则（唯一来源）
src/background/shared.js     加载 shared/、模板渲染、结构校验
src/background/llm.js        Ollama 探活与 /api/chat
src/background/digest.js     消化流水线（解析 → 校验 → 重试 → trace）
src/background/page.js       标签页与抓正文
src/background/service-worker.js  消息路由 + 落 storage
```

**改 prompt / 模型参数 / 校验规则，一律改 `shared/` 下的 JSON，不要写进 JS。**
阶段 3 的 Python 评测脚本会读同一份文件 —— 两边必须对同一份 JSON 解释一致。

`attempts[]` 里每次尝试的原始输出与错误原因是阶段 3 失败分类的唯一数据来源，**不要为了省空间把它删掉**。
