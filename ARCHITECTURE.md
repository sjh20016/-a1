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

## 叙事数据结构

- `TurnNarrativeContract`：Canonical Truth 的公共发布契约。
- `NarrativeQualityPlan 1.1`：版本化文案档位、事实权重、动态目标长度和段落职责。
- `NarrativePacket 1.0`：从契约和规划生成的最小公开 AI 输入。
- `narrativeMetrics 1.0`：章节长度、段落、句式变化、对白比例、体验分数和告警。
- `narrativeQualityHistory`：最近 20 章体验指标，用于长期质量趋势。

## 下一步拆分

路线图下一阶段应将全局 `Story` 状态逐步收口到每房间 `StoryEngine` 实例，优先拆出：

1. `IntentParser` / `Resolver`
2. `NarrativeContractBuilder`
3. `NarrativePlanner`
4. `NarrativeValidator`
5. `StoryEngine` 房间实例与持久化适配器

拆分期间以 `npm test`、三真人十轮夹具和 `npm run simulate -- --turns 30` 作为行为基线，避免在结构重构时改变既有裁决语义。
