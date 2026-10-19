# @ai-infra/audit-core —— 契约 v0（**frozen** 2026-09-28，长任务 1 / 阶段 B）

> append-only 审计哈希链。
> **本文件的「导出面」一节由 `shared/gen-contracts.mjs` 从代码现场读取生成，请勿手改**；
> 人写的判据/边界在生成器的 `NOTES` 表里，改动须显式提交。

**契约版本**：`0.1.1`　**包版本**：`0.0.2`

## 导出面（冻结 —— major 变更须暂停报告，minor 允许追加）

`CHAIN_VARIANTS` · `CONTRACT_VERSION` · `DEFAULT_VARIANT` · `GENESIS` · `KNOWN_PACKAGES` · `VARIANT_IDS` · `appendAudit` · `auditDirFor` · `auditFileFor` · `canonicalJson` · `detectVariant` · `digestArgs` · `discoverChainPackages` · `hashOfBody` · `listShards` · `readAudit` · `schemaFor` · `sha256` · `verifyAllChains` · `verifyChain`

## 判据

- `verifyChain` 默认 **自动识别变体**并把结果写进返回值 —— 于是「这条链用哪个算法」成为可审计事实，而不是调用方必须事先知道的默契。
- **追加的串行化保证（LONGTASK5 补）**：`appendAudit` 把「读头 → 算 prevHash/seq → 追加」整体放在 `withAuditLock` 的临界区内完成，故**并发写者不会用同一个头各写一条**。
- **锁机制**：`O_EXCL` 建锁文件（可移植，不依赖 flock 语义），**只在毫秒级临界区持锁**；陈旧锁按 mtime（10s）接管，避免崩溃写者造成死锁；超时抛 `E_AUDIT_LOCK_TIMEOUT`。
- **为什么不是 CAS**：`state-core` 用 CAS 是因为它做**整份文档读-改-写**；审计链是**追加型**，必须让「头」在 `读头→追加` 期间保持稳定 —— CAS 只能**事后**发现冲突，而那时错行**已经落盘**。两类对象的并发语义不同，处置也应不同。
- **覆盖率由现场决定（LONGTASK5 补）**：`discoverChainPackages` 扫描审计目录，**有链的包就必须被复算**，覆盖范围不再由硬编码名单决定 —— 否则「新增插件忘了改名单」会让检查绿着而对象没被检查。
- 只追加由四件事共同保证：`O_APPEND`（行不交错）+ **`withAuditLock`（头不陈旧）** + 文件模式 `0600` + API 层不存在删改导出。

## 链变体（**实测发现：四个插件不是一个算法，是两个**）

| variant | 公式 | 使用者（实测） |
|---|---|---|
| `canonical-json` | `sha256(canonicalJson(record 去掉 hash))` | `inference-tuning` · `inference-diagnose` |
| `prevhash-canonical-json` | `sha256(prevHash + "\n" + canonicalJson(record 去掉 hash))` | `inference-serving` · `inference-quantization` |

## 已知边界（诚实记录）

- 链能检出**改动 / 插入 / 重排**；**不能**检出「从尾部截断」（截断后的前缀仍是一条自洽的链）。尾部截断须由外部期望计数或把 head 记在别处来发现。**不得**声称链能检出截断。
- **历史缺陷（已修，留档）**：`appendAudit` 曾**承诺**串行化但**未实现**（读头与追加之间有竞态窗口）。实测后果：`training-qat/2026-09-29.jsonl` 第 22 条 prevHash 指向第 20 条（#21 与 #22 相差 1ms，两者用了同一个头），`verifyChain` → `brokenAt: 22`。修复见 `withAuditLock`。
- **链修复协议（LONGTASK5 裁决 ②，今后所有链修复必须走同一流程）**：① **原件永久保留**（改名 `.broken-<ts>` 并旁挂 `.sha256`，**不得自动清理**）；② 断点处插入一条 `chain-repair` 记录，写明断点位置、原因、**原件路径与其 sha256**、修复内容、**重封范围**；③ 断点之后逐条重封（内容不变，只重算 prevHash/hash）；④ 脚本**默认 dry-run**，`--apply` 才落盘；⑤ **不得**用「重写历史抹平」的方式处置 —— 那会把篡改检测一起抹掉。参考实现：`inference-training/checks/repair-audit-chain.mjs`。
- **重封段的原始哈希不可再复现** —— 这是修链的固有代价，已在链内 `chain-repair` 记录中声明；读链者据此可知「哪一段被重封过、为什么、原件在哪」。

## 不做（v0 排除）

- 不管「该记什么字段」（业务字段由调用方给）
- 不做日志轮转/压缩（分片按日期天然切分）

## 契约测试判据（`tests/contract.mjs`）

两个变体对同一条记录给出不同哈希（= 「两个算法」的直接证据）；自建链篡改/插入必须检出并定位；**拿线上真实分片独立复算全部通过**，且检出的变体与登记表一致（谁改算法立刻红）；**覆盖率断言**：`discoverChainPackages` 发现的链数必须 ≥ 名单长度，且复算循环遍历「发现 ∪ 名单」—— 覆盖范围由现场决定，"检查通过"必须同时意味着"检查过"。

跑法：`node shared/run-all.mjs audit-core`（或 `npm test`）。
