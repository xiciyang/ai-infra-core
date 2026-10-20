# @xiciyang/testing-core —— 契约 v0（**frozen** 2026-09-28，长任务 1 / 阶段 B）

> 测量原语（`index.mjs`，纯函数）+ 评估壳（`evaluate.mjs`，端点测量/完整性判定/遗忘门禁）。
> **本文件的「导出面」一节由 `shared/gen-contracts.mjs` 从代码现场读取生成，请勿手改**；
> 人写的判据/边界在生成器的 `NOTES` 表里，改动须显式提交。

**契约版本**：`0.2.0`　**包版本**：`0.0.1`

## 导出面（冻结 —— major 变更须暂停报告，minor 允许追加）

`CONTRACT_VERSION` · `FORGETTING_SIDES` · `attachIntegrity` · `dualGate` · `evalLM` · `evalMMLU` · `evalUniform` · `floatFingerprint` · `forgettingGate` · `get` · `lnVocab` · `mean` · `meanNllFromLogprobs` · `measurementCompleteness` · `nllFromLogprob` · `perplexity` · `post` · `relativeChange` · `stddev` · `uniformSignature`

## 包含（v0）

- 纯函数测量原语（`index.mjs`，v0 冻结面）：`lnVocab` / `nllFromLogprob` / `meanNllFromLogprobs` / `perplexity` / `mean` / `stddev` / `uniformSignature` / `relativeChange` / `dualGate` / `floatFingerprint`
- 评估壳（`./evaluate.mjs`，v0.2.0 合并进来）：端点原语 `post` / `get`、逐条测量 `evalLM` / `evalMMLU` / `evalUniform`、完整性判定 `measurementCompleteness` / `attachIntegrity`、遗忘门禁 `forgettingGate`（候选侧标签 `FORGETTING_SIDES = [sft, pt, rl]`）

## 不包含（v0 明确排除 —— 让「忘了做」与「主动不做」可区分）

- 评估的**调度**（何时测、测多少、用哪个端点）—— 属各 `training-*-plugin` 的 `core.mjs`
- 具体判据之外的业务指标抽取（任务 F1、规则奖励）—— 属各插件

## 判据

- **均匀签名**：`uniform ⟺ |meanNll − ln(vocab_size)| ≤ max(2^-9·ln(vocab_size), z·std(NLL)/√n)`，z 默认 3；`vocab_size` 由调用方从模型 `config.json` 读入（**不硬编码**）。ε 每次测量重算并随证据返回（`criterion` 字符串逐字给出公式）。
- **双重门禁**：先判 validity（测量是否成立），再判数值（精度/性能是否达标）。`reason` 必须能区分「测量不成立」与「数值未达标」。
- **相对变化**：`baseline=0` 抛错（不得用 Infinity 冒充结论）。
- **缺陷 14（测量完整性可判定）**：`evalLM` / `evalMMLU` 必须返回 `attempted / succeeded / failed / skipped / considered / partial / okIndices / firstError`；`evalMMLU` 必须区分 `failed`（仪器层，非 200）与 `unparsed`（模型答了话但没给 A/B/C/D）。遗忘门禁**基于 `attempted`** 判，把「测量不完整」与「样本不足」报成**两种不同的理由**。
- **缺陷 15（完整性判定 fail-closed）**：`measurementCompleteness` 的判据是「**有证据证明完整**」，不是「看起来像完整」。旧条目（无 `attempted`/`failed`）一律不可复用；理由为 `missing` / `marked-invalid:…` / `<part>:no-integrity-evidence` / `<part>:failed=N/M` / `<part>:partial` / `no-instrumented-parts` / `unclassified-part:<k>`。
- **配对按下标交集**：遗忘门禁的同名配对必须按成功行的 `okIndices` **交集**，并带 `pairedOn: 'okIndices-intersection' | 'positional-legacy'`；无 `okIndices` 的旧产物退化为按位置时必须**在产物里标明**。
- **唯一实现**：逐插件的 `sftMmlu`/`ptMmlu`/`rlMmlu` 命名被**参数化**（候选侧标签），不是四份代码；插件侧只许再导出（`export … from`），不得含实现体（CI `C27` 组按 **函数对象同一性** 判定）。

## 不做（v0 排除）

- 不规定「从哪取数」（同一判据允许多种取数来源）
- `index.mjs`（本体）不读文件、不发请求、不起容器（纯函数）；`./evaluate.mjs` 是**唯一**允许 `fetch` 的文件
- 零运行时依赖（四个插件一致）

## 契约测试判据（`tests/contract.mjs`）

ε 必须随 `n` 与 `std` 变化；均匀/非均匀各有已知对照；只给均值不给样本必须抛错；双重门禁必须区分两类失败；`baseline=0` 必须抛错。**v0.2.0 追加**：评估壳的八个导出在库内（唯一实现）；候选侧标签闭集；缺陷 15 的 fail-closed 语义（旧条目不可复用、带证据且 failed=0 才可复用、`null ⇒ missing`）在合并后仍成立。

跑法：`node shared/run-all.mjs testing-core`（或 `npm test`）。
