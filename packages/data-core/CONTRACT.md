# @ai-infra/data-core —— 契约 v0（**frozen** 2026-09-28，长任务 1 / 阶段 B）

> 数据集原语。
> **本文件的「导出面」一节由 `shared/gen-contracts.mjs` 从代码现场读取生成，请勿手改**；
> 人写的判据/边界在生成器的 `NOTES` 表里，改动须显式提交。

**契约版本**：`0.1.0`　**包版本**：`0.0.1`

## 导出面（冻结 —— major 变更须暂停报告，minor 允许追加）

`CONTRACT_VERSION` · `PII_PATTERNS` · `assertNoLeakage` · `canonicalRecord` · `contentHash` · `dedupByContent` · `lineage` · `piiScan` · `recordHash` · `splitDeterministic` · `validateCnIdCard` · `validateIpv4`

## 判据

- **确定性切分**：排序键 = `sha256(seed + "\u0000" + recordHash(rec))`；用**内容**而不是下标做键（下标在数据集版本变化时整体错位）。同 seed 同输入 ⇒ 逐条相同。
- **去泄漏**：两侧内容哈希交集必须为空，交集以哈希列表形式返回（可复核）。
- **血缘**：`source` 必填（无来源的产物不可追溯）。

## 不做（v0 排除）

- 不下载数据集、不读网络、不分词（那是 `inference_quantization_dataset_prepare` 的职责）
- **不提供自动脱敏**：Step 0 纪律是「发现 PII → 暂停报告，不自行脱敏后继续」；提供自动脱敏函数等于邀请那条被禁止的路径。`piiScan` 只返回模式 id + 命中位置 + 样本哈希。

## 契约测试判据（`tests/contract.mjs`）

键序不同的同一记录必须同哈希；同 seed 同结果、换 seed 变结果；样本不足必须抛错；人为泄漏必须被检出且交集可数；PII 扫描不得回显明文。

跑法：`node shared/run-all.mjs data-core`（或 `npm test`）。
