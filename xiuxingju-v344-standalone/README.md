# 修行局 V3.4.2

《修行局》是一款多人修仙叙事游戏。本地规则负责确定行动、目标、结果、时间、位置和公开范围，AI 只负责把既定事实组织成可读章节。章节必须通过事实、互动、自主权、完整性和隐私发布闸门后才会提交。

## 当前叙事管线

```text
ActionIntent
→ Resolver / Interaction
→ ProjectedState
→ TurnNarrativeContract
→ NarrativeQualityPlan
→ NarrativePacket（仅公开信息）
→ AI Prose Renderer
→ Semantic / Completeness / Publish Gate
→ Commit
```

V3.4.2 增加了三档版本化文案策略：

- `concise`：凝练，适合快速推进和低延迟模型。
- `balanced`：均衡，完整呈现行动与后果。
- `immersive`：沉浸，默认档位，增加场面反应、段落发展和具体余波。

档位只改变篇幅、段落和表现密度，不改变本地裁决事实。每章会记录 `narrativeMetrics`，包括字符数、段落数、句长变化、对白占比、目标长度状态和体验等级。

## 当前玩法与运行时基线

- 每个房间拥有独立 `StoryEngine`、状态、RNG 绑定、Provider 上下文和串行队列；同房间严格串行，不同房间可以并行等待模型。
- 每局投票选出的三条篇章会组成三幕 campaign。每个 beat 需要累计两次有效推进，篇章之间保留一回合幕间。
- `ArcScheduler` 使用结构化 `wakeWhen` 唤醒后续篇章；篇章完成时同步关闭所属 thread，避免已完成主线继续显示为 active。
- campaign 带 30 格“大劫逼近”时钟。三幕完成产生成功结局；时钟走尽产生明确的代价型结局。
- 七枚世界骰统一编译为 `resolverModifiers / eventWeights / turnEffect / explanation`；规则触发与压力进入持久状态，并通过公共 RoomView 解释。
- 每个已开始的回合都会推进一个确定性的势力行动，改变 `power / control / resources / stance` 之一。
- 所有人锁定后，服务端在请求模型前生成仅含公开事实的 `resolutionEcho`；在线 UI 立即显示行动、目标、结果与代价，正式章节发布后自动清除。
- 旧的全局 `Story` API 仍作为兼容 facade 保留，旧房间快照加载时会自动补齐 campaign 字段。

## 本地运行

需要 Node.js 18 或更高版本。

```bash
npm ci
npm run server
```

默认监听地址和 AI Provider 配置见 [`.env.example`](./.env.example) 与 [`DEPLOY_SERVER.md`](./DEPLOY_SERVER.md)。浏览器入口为 `index.html`，权威联机服务入口为 `server/index.js`。

## AI Provider

服务端使用 OpenAI-compatible Chat Completions 协议。复制 `.env.example` 后配置：

```text
AI_BASE_URL=https://api.deepseek.com
AI_API_KEY=your-session-key
AI_MODEL=deepseek-chat
AI_MAX_TOKENS=4096
```

API Key 不应写入仓库、测试报告或游戏公共上下文。公共 Narration Context 会过滤 `_envelope`、`privateDelta`、隐藏命运、私密收益和隐藏线程。

## 验证与模拟

```bash
npm run check:syntax
npm test
npm run test:v342:three-player
npm run test:v343
npm run simulate -- --seed V343-BASELINE --turns 30
npm run simulate -- --seed CAMPAIGN-MATRIX --seeds 100 --turns 30 --quiet
```

`simulate` 使用确定性本地文案 Provider，不消耗外部 API。单 seed 输出行动、互动、文案质量、篇章激活、最长失活、危机时钟和结局；传入 `--seeds` 时输出多 seed 聚合摘要。它会真实启动三幕篇章，而不是只测没有 Director 的自由回合。

当前 100 seed × 30 回合验收快照见 [`test-fixtures/metrics/phase2-acceptance.json`](./test-fixtures/metrics/phase2-acceptance.json)：98 个成功结局、2 个代价结局、平均 23.35 回合、最长篇章失活 1 回合、叙事失败 0。

三真人十轮压力测试记录见 [`V342_THREE_PLAYER_10ROUND_REPORT.md`](./V342_THREE_PLAYER_10ROUND_REPORT.md)。模块边界和后续拆分方向见 [`ARCHITECTURE.md`](./ARCHITECTURE.md)。

## 发布原则

- 真人行动或强制互动遗漏：拒绝发布。
- 正文过短、段落不足或 Provider 因长度截断：拒绝发布。
- 玩家自主权、目标位置、时间、实体或超自然后果越界：拒绝发布。
- 文风重复、篇幅未达理想目标：记录软告警，供精确返工与质量分析使用。
- AI 失败时保留 `pendingResolution`，不会提交半成品章节或丢失本地裁决。
