# 修行局架构基线

## 权威边界

`story-core.js` 当前仍是单文件核心，但内部权责已经分层：

| 层 | 负责 | 不负责 |
| --- | --- | --- |
| Intent / Resolver | 解析行动、动态目标、结果和代价 | 文学表达 |
| Interaction / ProjectedState | 多人碰撞、未来位置和时间 | 替玩家做选择 |
| TurnNarrativeContract | 汇总必须落实的公开事实 | 创造新事实 |
| NarrativeQualityPlan | 主次、篇幅、段落、开头和结尾模式 | 改写裁决 |
| NarrativePacket | 向 AI 输出最小公开写作包 | 私密 Delta、隐藏命运和服务端状态 |
| Prose Renderer | 场面、动作、对白、节奏和语言 | 命中、奖励、位置和时间裁决 |
| Validators / Publish Gate | 完整性、事实、自主权、实体、时空和后果验收 | 悄悄修正本地状态 |

## 事务边界

每回合先在锁内生成并保存 `pendingResolution`，再调用 AI。只有叙事通过发布闸门后，系统才应用 Delta、推进 Director、生成下一轮选项并提交章节。失败时保留待提交状态，房主可以重试。

## 每房间运行时边界

`src/application/story-engine.js` 是从全局 facade 向实例化引擎迁移的兼容边界：

- 每个房间独占 `StoryEngine.state`、RNG 绑定、Provider context 与 `SerialQueue`。
- `Room` 通过运行时 `WeakMap` 持有引擎，运行时对象不会进入 JSON 存档。
- 同一引擎上的任务串行；不同引擎不共享执行队列，模型等待可并行。
- `Story.providerFor(state)` 按会话选择 Provider；未迁移的本地/测试入口继续使用 `Story.ai`。
- 旧存档恢复后会重新附着新引擎，不改变磁盘快照格式。

当前 `resolveTurn` 内仍封装 prepare/render/commit 三步。下一次结构拆分应把三步显式化，以便模型等待期间释放房间状态锁，并用 pending version 防止迟到响应提交。

在三段式拆分完成前，`pendingResolution.resolutionEcho` 已作为即时反馈边界：它在 Provider 调用前生成并持久化，只包含公开行动、目标、裁决结果、代价及公开规则修正；RoomView 不会转发 `privateDelta` 或私密收益。

## 篇章生命周期

```text
inactive → voting → active → interlude → active → campaign_completed
                                      ↘ crisis clock → cost ending
```

`ArcScheduler` 在每次成功提交后执行：关闭已完成篇章所属 thread、推进 campaign clock、求值结构化 `wakeWhen`，并在一回合幕间后激活下一幕。公共 Director 快照包含幕次、beat 进度、危机时钟和 ending，但不暴露休眠篇章细节。

## 世界规则契约

七维世界骰由 `WorldRules.compile` 统一投影为四类输出：

- `resolverModifiers`：进入修炼、旅行、交涉、冲突等确定性结果；
- `eventWeights`：为后续本地事件表提供标签权重；
- `turnEffect`：更新每维的 pressure、triggerCount 和 lastTriggeredChapter；
- `explanation`：进入公共 RoomView，向玩家说明规则来源与当前触发次数。

`FactionSystem.afterTurn` 每个成功回合推进一个低成本本地势力行动；它只依赖 seed 和 chapterIndex，不调用模型，也不污染叙事 RNG。

## 叙事数据结构

- `TurnNarrativeContract`：Canonical Truth 的公共发布契约。
- `NarrativeQualityPlan 1.1`：版本化文案档位、事实权重、动态目标长度和段落职责。
- `NarrativePacket 1.0`：从契约和规划生成的最小公开 AI 输入。
- `narrativeMetrics 1.0`：章节长度、段落、句式变化、对白比例、体验分数和告警。
- `narrativeQualityHistory`：最近 20 章体验指标，用于长期质量趋势。

## 下一步拆分

每房间 `StoryEngine` 边界已经建立。后续优先拆出：

1. `IntentParser` / `Resolver`
2. `NarrativeContractBuilder`
3. `NarrativePlanner`
4. `NarrativeValidator`
5. `prepareTurn` / `render` / `commitTurn` 三段式事务

拆分期间以 `npm test`、三真人十轮夹具和 `npm run simulate -- --turns 30` 作为行为基线，避免在结构重构时改变既有裁决语义。
