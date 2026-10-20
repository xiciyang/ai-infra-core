# @xiciyang/sandbox-core —— 契约 v0（**frozen** 2026-09-28，长任务 1 / 阶段 B）

> 三级沙箱行为探测与产物转移。
> **本文件的「导出面」一节由 `shared/gen-contracts.mjs` 从代码现场读取生成，请勿手改**；
> 人写的判据/边界在生成器的 `NOTES` 表里，改动须显式提交。

**契约版本**：`0.1.0`　**包版本**：`0.0.1`

## 导出面（冻结 —— major 变更须暂停报告，minor 允许追加）

`CONTRACT_VERSION` · `DEFAULT_DEGRADATION` · `TIERS` · `defaultRunner` · `exportArtifacts` · `hashFile` · `probeTiers` · `requireTier` · `runInTier`

## 判据

- **行为验证，不是存在性检查**：每层都要真的跑一条命令并看返回值。`process` → 受限子进程；`container` → 真的 `docker run --rm …`；`vm` → 真的启动一次最小 guest。`which` / `command -v` 的结果只作为**补充证据**，**不**参与 `available` 判定 —— 「装了」≠「生效」是本机实测教训。
- **降级策略**：`process` 不可用 ⇒ 提升到容器层；`container` / `vm` 不可用 ⇒ **拒绝执行**（`E_SANDBOX_UNAVAILABLE`，带 remediation）。任何情况下**不得**静默降级到 `none`。
- **产物转移**：逐文件哈希核对（源/目标双向），不一致即 `verified:false` 并列出不匹配项 —— 只做 `copyFile` 等于把「转移成功」当成「内容一致」。

## 不做（v0 排除）

- 不实现沙箱本身（容器/VM 生命周期属各插件的 executor）
- `runner` 一律注入（默认实现用 child_process，测试可替换）

## 契约测试判据（`tests/contract.mjs`）

二进制「在」但跑不起来 ⇒ 仍判不可用；不可用层必须拒绝执行（命令根本没跑）；决策与证据一并返回；哈希不符必须 `verified:false`。

跑法：`node shared/run-all.mjs sandbox-core`（或 `npm test`）。
