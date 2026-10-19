# @ai-infra/state-core —— 契约 v0（**frozen** 2026-09-28，长任务 1 / 阶段 B）

> 共享状态方言 / schema / 原子写。
> **本文件的「导出面」一节由 `shared/gen-contracts.mjs` 从代码现场读取生成，请勿手改**；
> 人写的判据/边界在生成器的 `NOTES` 表里，改动须显式提交。

**契约版本**：`0.1.0`　**包版本**：`0.0.1`

## 导出面（冻结 —— major 变更须暂停报告，minor 允许追加）

`CONTRACT_VERSION` · `DIALECT_EXPORTS` · `UNSUPPORTED_KEYWORDS` · `YamlError` · `appendLine` · `assertSchemaSupported` · `atomicWrite` · `contentHash` · `hashFileStreaming` · `mkdirp` · `parse` · `parseFile` · `readText` · `stringify` · `validateAgainstSchema` · `withOptimisticWrite`

## 判据

- **方言对齐**：契约测试拿 `~/.ai-infra/state/*.yaml` 真实文件，让 state-core 与三个插件的 parser **各读一遍、结果逐字节相同**。不比较文档口径，比较行为。
- **schema 校验**：与 `inference-contracts/checks/run-all.mjs` 同一套语义（type/const/enum/pattern/required/items/properties）。不支持的 `$ref`/`oneOf`/… **抛错**而不是静默忽略。
- **并发写入裁决**：**乐观并发（CAS on content hash）+ 原子写，不加文件锁**。冲突抛 `ERR_STATE_CONFLICT`；重试策略属调用方。理由：flock 会引入跨 NFS/容器挂载的行为差异，而真正该被发现的是「两个写者同时改同一文件」这一语义冲突，不是把它排队藏起来。

## 不做（v0 排除）

- 不引 YAML 库（沿用原实现的受限子集，零依赖是硬约束）
- 不做文件锁（见上裁决）

## 契约测试判据（`tests/contract.mjs`）

导出集合与三插件相同；真实状态文件四份 parser 结果一致；往返一致且历史引号形态可读；CAS 过期必须抛 `ERR_STATE_CONFLICT`；不支持的 schema 关键字必须抛错。

跑法：`node shared/run-all.mjs state-core`（或 `npm test`）。
