# @xiciyang/training-core —— 契约 v0（**frozen** 2026-09-28，长任务 1 / 阶段 B）

> 公共训练循环 / checkpoint / 资源上限 / 审计钩子。
> **本文件的「导出面」一节由 `shared/gen-contracts.mjs` 从代码现场读取生成，请勿手改**；
> 人写的判据/边界在生成器的 `NOTES` 表里，改动须显式提交。

**契约版本**：`0.4.0`　**包版本**：`0.0.1`

## 导出面（冻结 —— major 变更须暂停报告，minor 允许追加）

`BUDGET_DEFAULTS` · `CONTRACT_VERSION` · `DTYPE_POLICY` · `LIMIT_KEYS` · `MODES` · `assertArtifactChanged` · `assertComparableDtype` · `assertInstrumentUsable` · `assertProductDtype` · `assertTrainingPlugin` · `assertWeightFingerprint` · `canonicalJson` · `canonicalize` · `createAuditHook` · `createMonolithicLoop` · `createTrainingLoop` · `enforceLimits` · `fingerprintArtifacts` · `instrumentFromDeployReport` · `listCheckpoints` · `loadCheckpoint` · `normalizeDtype` · `pluginMode` · `readSafetensorsDtypes` · `readTensorDtypes` · `removeCheckpoint` · `saveCheckpoint` · `stateHash`

## 包含（v0）

- 公共训练循环 `createTrainingLoop`（逐步档位）
- 单体循环 `createMonolithicLoop`（v0.2.0 新增）
- 档位判定 `pluginMode` / `MODES`
- 产物级断言 `fingerprintArtifacts` / `assertArtifactChanged`
- checkpoint 生命周期 `saveCheckpoint` / `loadCheckpoint` / `listCheckpoints`
- 资源上限强制 `enforceLimits`
- 审计钩子 `createAuditHook`
- 预算默认值 `BUDGET_DEFAULTS`
- 测量仪器来源 `instrumentFromDeployReport` / `assertInstrumentUsable`（v0.3.0 新增）
- 产物存储 dtype 策略 `DTYPE_POLICY` / `normalizeDtype` / `readSafetensorsDtypes` / `readTensorDtypes` / `assertProductDtype` / `assertComparableDtype`（v0.4.0 新增）

## 不包含（v0 明确排除 —— 让「忘了做」与「主动不做」可区分）

- 具体训练算法（SFT / 预训练 / RL / QAT 各自的实现）—— 属各 `training-*-plugin`
- 数据预处理 / 分词 / 切分 —— 归 `@xiciyang/data-core`
- 评估逻辑（精度/性能测量与门禁）—— 归 `@xiciyang/testing-core`
- 分布式训练策略（DDP / FSDP / TP / PP）—— **v0 不含**，并发恒为 1
- 模型结构定义 / 权重加载器 —— 由插件自己的可选依赖框架提供
- 调度与编排（何时启动下一次训练）—— 属上层

## 判据

- **产物级断言（共享守卫）**：`assertWeightFingerprint(payload, {what})` —— 检查点 payload 的权重指纹必须**齐备且相对起点确实变了**：缺指纹抛 `E_WEIGHT_FINGERPRINT_MISSING`，与起点相同抛 `E_NO_OP_TRAINING`（**"无法断言"按不通过处理**）。它同时认两套字段名（逐步档位 `fingerprint`/`initFingerprint`、单体档位 `artifactFingerprint`/`initArtifactFingerprint`），因此**一个实现被三个插件共用** —— 此前只有 pretrain 有此防线（实测 `fingerprint-coverage.mjs` 判 4 个插件里 3 个未过）。
- **两档插件接口**（v0.2.0 起）。**逐步档位**（未变）：插件是普通对象 `{ id, algorithm?, prepare?(ctx), step(batch, state) -> {loss, metrics?, done?}, finalize?(ctx), checkpointPayload?(ctx) }`；`step` 只接收 `(batch, state)` 并返回**普通对象**，全程不出现任何框架对象，循环本身不 import 任何训练框架。**单体档位**（新增）：`{ id, algorithm?, monolithic:true, run(ctx) }`，循环交给框架，插件**必须**在每个优化器步调用 `ctx.onStep(info)`。两档**不得同时声明**（装配期 fail-closed）。
- **单体档位的纪律 = 不信任插件、事后核对**：`ctx.onStep` 返回与 `enforceLimits` 同形的 gate（不抛错）；run 结束后 core **复核**实际步数/墙钟/GPU 小时，越限写入 `violations` 并置 `state.budgetViolation`。**0 步也算违规**（`no-steps`）—— 空操作不得当成功。
- **单体档位的等价 hooks**：`onStep` / `onCheckpoint` / `onEval` / `onBudgetExceeded` 四者齐备，与逐步档位一一对应（`hooks.afterStep`↔`onStep`、`type:checkpoint` 事件↔`onCheckpoint`、`enforceLimits` 命中↔`onBudgetExceeded`）；`onEval` 是**新增能力**（逐步档位本无周期评估），并带 `selectionOnly` 标记以区分"选点信号"与"判定"。
- **产物级断言**：`fingerprintArtifacts(dir)` 对权重文件取确定性指纹（相对路径+字节数+内容 sha256 的排序列表再哈希，非权重文件不影响）；`assertArtifactChanged` 在训练前后指纹相同时抛 `E_NO_OP_TRAINING`，指纹缺失抛 `E_ARTIFACT_FINGERPRINT_MISSING`（**"无法断言"按不通过处理**）。**只断言过程抓不到空操作，必须断言权重。**
- **超限行为**：`enforceLimits` **不抛错**（暂停不是异常），返回 `{stop, reason, checks, policy:"pause-and-report"}` —— **自动暂停 + 报告，不自动降级**。
- **checkpoint 往返**：`meta.payloadHash` 是 payload 的内容哈希，加载时复核；不一致抛 `E_CHECKPOINT_CORRUPT`。单体档位的存档同样走 `saveCheckpoint`，故受同一判据约束。
- **产物存储 dtype 策略（v0.4.0 追加，缺陷 16）**：评估产物的**未量化张量** dtype 由 `DTYPE_POLICY.evaluationProduct` 固定（`bfloat16` —— 基座与 PTQ 产物都是 BF16，本机实测；验收是 candidate-vs-base 配对比较，被测产物的存储 dtype 必须等于基线的）。判据落在**产物**上：`readTensorDtypes({dir})` 直接读 safetensors **文件头**按 dtype 计数（零依赖、不加载权重），`assertProductDtype` 在"读不到 / 浮点 dtype 不唯一 / 与策略不符"时分别抛 `E_PRODUCT_DTYPE_UNKNOWN` / `E_PRODUCT_DTYPE_VIOLATION`（**未知 ≠ 合规**）。`assertComparableDtype({baseline,candidate,conversion})`：**只比同 dtype 的产物**，跨 dtype 一律 `E_DTYPE_COMPARISON_REFUSED`（实测仅 F32→BF16 就使 serving 的 dropPct 变化 0.40pp：1.7205%→1.3212%）；调用方先把候选转成基线 dtype 再测量并用 `conversion:{from,to,declaredBy,reason}` 显式声明，声明必须与实测 dtype 对得上（否则 `E_DTYPE_CONVERSION_INVALID` / `E_DTYPE_CONVERSION_UNVERIFIED`）。**不改写历史产物**：记录 + 拒绝，不回填。
- **测量仪器来源（v0.3.0 追加）**：`instrumentFromDeployReport(deployReport)` 把 `inference-serving/deploy-report@1` 归一化成一份小的、JSON 安全的仪器记录（`effectiveConfig` = **真正部署**的那份配置、`degrade{steps,lossy,lossyWarning,tiers[]}`、`requestedConfig`、`degradedFrom`、`lossy`）。**纯函数**：只取叶子字段、绝不嵌入活对象（函数 / 循环引用 / 超深嵌套一律丢弃）；认不出形状或缺报告返回 `null`（**不抛错、也不编造**）。`assertInstrumentUsable(instrument, {runId})` 在 `instrument.lossy === true` 时抛 `E_INSTRUMENT_LOSSY`（带档位 id 与可执行补救），**`instrument == null` 不抛** —— 它只拒绝**已知有损**，"没有记录"由产物里的 `instrument: null` 显式承载。为什么需要：`eval-result@1` 曾只写判决不写仪器，实测一次 RL 测量里部署落进有损档位 `precision`（`dtype=half` + `quantization=fp8`），同一份权重测出 `25/48` 而非 `23/48`、判决翻转，而产物里没有任何字段表明被测模型已被量化。

## mock 策略（如何在不训练的情况下测试）

契约测试用 `{ id:"mock-sft", async step(batch){ return { loss: 1/(n+1) } } }` 把循环、上限、checkpoint、审计全部跑通 —— 零 GPU、零框架、零网络。**若有人往 training-core 里塞进 `import torch`，这个测试会立刻跑不起来**，这就是 mock 策略被破坏的最早信号。

## 可选依赖组（显式声明）

`torch` / `transformers` / `peft` / `trl` / `accelerate` 见 `package.json` 的 `optionalDependencies`。未列出的框架调用属「引入未声明依赖」。

## 契约测试判据（`tests/contract.mjs`）

mock 插件跑通全循环；数据耗尽必须有上界（否则空转 —— v0 修掉的真实缺陷）；注入 clock 断言墙钟超限暂停；checkpoint 往返哈希一致、被改动必须抛 `E_CHECKPOINT_CORRUPT`；审计链可复算且不含样本内容；导出面不得出现分布式/具体算法入口。**v0.2.0 追加**：四种非法插件形状装配期全拒（含"两档同时声明"）；单体档位步数停在上限、四个等价钩子全触发、checkpoint 可被 loadCheckpoint 读回；**阳性对照**：插件无视 stop 继续跑 ⇒ 事后核对记为越限且如实记账实际步数；0 步入违规；权重指纹逐位不变 ⇒ `E_NO_OP_TRAINING`。**v0.3.0 追加（仪器来源）**：有损 deploy-report ⇒ `lossy=true` 且档位 id 按 history 顺序完整捕获；无损 ⇒ `lossy=false` 且 `tiers=[]`；`degrade.lossy` 漏写但 history 里有有损条目 ⇒ 仍判有损；缺报告 / 非报告形状 ⇒ 全 `null` 且不抛错；含函数与循环引用的入参不抛错且活对象被丢弃（不进记录）；有损 ⇒ 抛 `E_INSTRUMENT_LOSSY` 且信息含档位 id / 补救 / runId；无损与缺失 ⇒ **不抛**（"不知道" ≠ "有损"）。 **v0.4.0 追加（产物 dtype）**：合成 safetensors 头 → BF16 放行 / F32 抛 `E_PRODUCT_DTYPE_VIOLATION` / 浮点 dtype 不唯一或没有未量化浮点或目录不存在 ⇒ `E_PRODUCT_DTYPE_UNKNOWN`；`F8_E4M3` 必须归入**量化**张量（按前缀判会把它当成未量化浮点，从而把所有产物误判成"未知"——已作为回归项钉住）；跨 dtype 比较抛 `E_DTYPE_COMPARISON_REFUSED` 且信息含 0.40pp 效应量；未知 dtype 不得参与比较；显式转换声明的 `from≠to`、`declaredBy`、`reason` 缺一即 `E_DTYPE_CONVERSION_INVALID`。

跑法：`node shared/run-all.mjs training-core`（或 `npm test`）。
