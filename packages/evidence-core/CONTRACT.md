# evidence-core 契约 v1.0.0

> 状态：frozen（`CAPABILITY_VERSION = 1.0.0`，`SCHEMA_VERSION = evidence-chain@1`）
> 判据实现：`tests/contract.mjs`（40 项断言，`node ../../scripts/run-all.mjs evidence-core`）

## 职责

把「事实 → 关系 → 演绎 → 案例库」变成可机检的链条，防止推断冒充事实。

## 冻结导出面

- 常量：`CAPABILITY_VERSION` / `SCHEMA_VERSION` / `FACT_KINDS` / `RELATION_TYPES` / `BASIS_KINDS` / `ANCHOR_PREFIXES` / `DEFAULT_RULES`
- 类型：`EvidenceError` / `CaseLibrary`
- 函数：`anchorResolves` / `collectFacts` / `verifyFacts` / `verifyRelations` / `derive` / `decideStop` / `rankDirections` / `weightedFacts` / `checkTraceability` / `top1` / `sha256`

## 四条硬纪律

1. **`kind=inference` 不得进入事实层** —— 推断必须显式建模为关系或演绎。
2. **置信度必须带 `confidenceBasis`** —— 否则它是一个装饰数字。
3. **锚点必须可解析** —— `sha256:` 校验形态；`file:` 校验文件存在；`run:/metric:/lineage:/round:/dataset:` 只校验非空标识（记录在案的轮次未必在本机）。
4. **演绎必须可追溯** —— `checkTraceability` 要求每条结论能回到事实与关系；不可追溯即拒绝。

## 边界

- 不规定数据从哪来；只校验给定证据的形态与可追溯性。
- 不做统计显著性计算（属 `testing-core`），不落盘（属调用方）。
- `anchorResolves` 的 `file:` 判定以进程 cwd 或显式 `root` 为基准；公开测试用仓库内夹具。

## 兼容策略

minor 只允许追加导出；删除导出、改变参数含义或返回形状属 major，须暂停并给出迁移说明。
