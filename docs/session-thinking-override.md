# 会话思维参数覆盖（Draft）

## 范围与权威

- 仅增加 conversation-scoped `ModelProfileRecord.thinkingOverride`（类型区分预算、OpenAI effort、Gemini level、Claude adaptive effort、DeepSeek 模式）。不往 ModelProfile 塞入完整渠道配置。
- 复用 `ModelProfileScopeSet`、配置 authority、现有 record/link 路径与确认快照。非 conversation scope 拒绝思维覆盖；UI 只发送普通数据。
- 模型专属配置**整体替代**渠道设置；专属配置没有 generationConfig 即未设置，不继承渠道的思维数值。选择默认时显示现有有效设置，未设置显示“服务默认”。Gemini/Astra 的现有适配器补值/归一化另作标注，不把参数编辑器示例值当成服务默认。
- 切渠道/模型走现有 selection 入口并清掉覆盖，不进行数字与等级换算。普通 Fork 沿用已有配置复制，复制成目标独立记录；本改动不修改 Fork 实现。
- 子 Agent 的模型选择规则不变；初始化仍只复制模型标识。请求参数解析只查**子会话自身** record，忽略父 Turn 的思维选择；已经设置了子会话覆盖则保留它，嵌套同理。

## 单次请求生效

1. 新 ModelRequest 边界经 authority 加载 `requestGeneration`，使用现有 `settings_snapshot_object_id` 冻结。与 `requestCompression` 是并列数据，不把聊天参数写入压缩配置。
2. 普通 full-request adapter 把冻结 generationConfig 交给 LLM capability，再经现有 provider mapper 生成线级 body。重试/重放读取原快照；已经冻结的请求不会读到后来编辑。
3. 原始 requestBody 同时冻结，保留其无关自定义字段。设置里遇到思维/最大输出相关原始 body 字段时，拒绝新覆盖、显示冲突；可恢复默认使用原 body。不静默压过 custom body，也不改 headers/auth/工具定义。
4. native recipe 使用同一单请求 authority。普通 effort 变更沿用已有 configuration_update；恢复字段省略时丢弃旧动态更新并通过现有 full-request rebase（`thinking_defaults_restored`），不复用旧 anchored effort。不改历史 reasoning/signature 或工具调用标识。
5. 底栏当前选择与最近请求冻结参数摘要分开；服务未返回的实际内部思考预算不伪造。摘要位于已有 stream stats，SQLite worker 仍严格校验允许字段和有界字符串。没有 schema migration、旁路 writer 或真实数据修改。

## 本地能力矩阵

这些是**当前代码的保守编辑能力**，不是远端服务承诺。HTTP/SSE 经既有 mapper；WS 仅项目原有 Responses 支持路径。

| 协议 / 模型族 | 控件和原生字段 | 限制 |
|---|---|---|
| OpenAI-compatible，已知 o1/o3/o4（不含 o1-mini/preview） | effort → `reasoning_effort` | low/medium/high；第三方同名转发仍未真实联调 |
| OpenAI-compatible / Responses，GPT-5 非 chat/pro | 分模型 effort；Responses → `reasoning.effort` | GPT-5 与后续小版本档位分开；不提供 max 的泛化换算 |
| Responses，精确 Astra（复用现有识别） | effort + 原有 native continuation | none/minimal 不作为新选项；现有渠道配置适配为 low 时明确标注 |
| Gemini 2.5 文本 Pro / Flash | `thinkingBudget` | -1 自动；Pro不允许0；Flash允许0；模型范围与输出上限校验；image/audio/live不开放预算快捷入口 |
| Gemini 3.x | `thinkingLevel` | 复用 shared/geminiThinking 按具体型号等级集合；不发送预算 |
| Claude 3.7 Sonnet / 已识别旧4系 | `thinking.budget_tokens` | 明确配置 maxOutputTokens 才开放；整数≥1024且小于最大输出 |
| Claude 已识别4.6+ Opus/Sonnet | adaptive + `output_config.effort` | 与预算互斥；none为关闭；不把 xhigh 强行映射为其他等级 |
| DeepSeek 已识别 reasoner/v4 | `thinking.type` / `reasoning_effort` | none/high/max；不使用 OpenAI 全部档位 |
| 未知别名 / 自定义渠道模型 | 现有默认照常请求；如有思维配置显示“未知能力” | 不把未知当作已验证支持，不新增猜测参数；可在原渠道设置显式配置 |
| 与思维/输出相关 custom body | 保留已有 body，快捷覆盖报冲突 | 失败选择保留，可重试/撤销/恢复默认；不全局阻塞其他会话 |

不声明适用于所有第三方兼容端点。已知名称也可能被中继限制；实际能力报错仍来自原 provider 请求路径。能力白名单需随仓库 adapter 与模型证据更新，不是旧协议 fallback。

## 保存与 UI

- 保存待确认、失败均显式显示；请求确认按 correlationId 和本会话 scope 匹配，迟到旧确认不清掉较新编辑。
- 快速编辑后发送只等待本会话 pending selection，不新增全局/所有 Webview barrier。
- 10秒未收到关联确认进入失败，保留草稿和选择，绝不当作成功。撤销重新通过 authority 写入最后确认的配置（无历史确认时恢复当前模型默认），避免迟到旧写入赢过撤销。
- 这是 ModelProfile scope 消息的确认流程；没有新增全局设置 flush 或存储路径。真实 VS Code 布局/键盘交互仍需 UI 验证。

## 验证方式与边界

- 所有 runtime 数据均在自动创建的系统临时测试目录；provider 编码测试使用 example.invalid dry-run；native 集成只启动 loopback 模拟服务。
- `session-thinking.test.mjs`：普通 full-request adapter → LLM capability → 固定 provider 包实际编码器的 body 矩阵、格式负例、0/none/-1、custom body、空快照及显示归一化。
- `session-thinking-runtime.test.mjs`：首次请求、工具后新请求、队列、同请求瞬时失败重试、重放；真实 child coordinator 从父工具生成子/嵌套任务并检查编码后的 wire body；子自身覆盖继续、跨协议子渠道。
- `session-thinking-store.test.cjs`：真实 Pinia/Vue reactive 输入，经 mock bridge structuredClone 验证无Proxy；作用域等待、失败保留、撤销、超时和乱序确认。不是浏览器布局测试。
- `configuration-authority.test.mjs`：保存重开、两会话隔离、模型专属整体替代、Fork独立及禁止Agent scope覆盖。
- `native-astra-integration.test.mjs`：真实 loopback HTTP/WS 的 native续接、high→恢复省略、恢复默认后重新选medium；不得携带旧 effort/updates/previous_response_id。

### 修复过程（保留失败，不隐去）

| 候选 | 结果与根因 |
|---|---|
| d6a4575 | 首次 build 类型检查失败：局部 thinkingOverride 隐式 any；后续显式标注类型 |
| e7cd3f0 | build、webview typecheck通过；相关93项89通过4失败。新摘要字段遗漏 worker严格白名单，创建ModelRequest报invalid shape。WS/native+run_agent既有64项通过 |
| 42b72bd | 增加单个有界字符串字段校验，不绕过校验；受影响7项6通过，剩余child续聊夹具未合法claim已释放ownership |
| 6421e40 | build、webview typecheck通过；164项162通过、1失败、1取消。新增排队用例误注册在child测试内，父测试结束取消该子测试；没有产品失败断言。后续只将排队用例移到顶层，保留全部断言 |
| ede6170 | 续聊夹具按宿主路径claim；普通runtime+native集成12/12通过，含实际子/嵌套wire隔离与HTTP/WS恢复默认 |

最终候选的构建SHA、完整命令与通过/失败计数见PR交付记录。每轮先固定干净提交再构建，provenance必须匹配；不同SHA的结果不得混成一次通过。

**未运行**：真实 VS Code UI、真实模型API/usage、任意第三方服务兼容性。没有自动安装、合并、修改已安装扩展/globalStorage或用户数据库。依赖安装提示的上游漏洞不在本功能内自动升级修复。
