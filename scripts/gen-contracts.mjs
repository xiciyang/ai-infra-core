#!/usr/bin/env node
/**
 * gen-contracts.mjs —— 从各库的**实际导出面**生成 `CONTRACT.md` 的冻结清单部分。
 *
 * 为什么要有生成器：导出面写进文档后就是**第二真源**，手抄必然漂移
 * （`inference-diagnose` 的 `docs/judgement-review.md` 已经栽过一次，见其 G8 门禁）。
 * 这里的做法是：导出面**由 `import()` 现场读取**，文档与代码不可能不一致；
 * 人写的部分（判据 / 边界 / 测试口径）放在 `NOTES` 表里，改动须显式提交。
 *
 * 用法：node gen-contracts.mjs [--check]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const LIBS = ['testing-core', 'data-core', 'state-core', 'audit-core', 'sandbox-core', 'training-core']

/** 人写部分：每个库的判据 / 边界 / 测试口径。**只在这里改**。 */
export const NOTES = {
  'testing-core': {
    title: '测量原语（`index.mjs`，纯函数）+ 评估壳（`evaluate.mjs`，端点测量/完整性判定/遗忘门禁）',
    includes: [
      '纯函数测量原语（`index.mjs`，v0 冻结面）：`lnVocab` / `nllFromLogprob` / `meanNllFromLogprobs` / `perplexity` / `mean` / `stddev` / `uniformSignature` / `relativeChange` / `dualGate` / `floatFingerprint`',
      '评估壳（`./evaluate.mjs`，v0.2.0 合并进来）：端点原语 `post` / `get`、逐条测量 `evalLM` / `evalMMLU` / `evalUniform`、完整性判定 `measurementCompleteness` / `attachIntegrity`、遗忘门禁 `forgettingGate`（候选侧标签 `FORGETTING_SIDES = [sft, pt, rl]`）',
    ],
    excludes: ['评估的**调度**（何时测、测多少、用哪个端点）—— 属各 `training-*-plugin` 的 `core.mjs`', '具体判据之外的业务指标抽取（任务 F1、规则奖励）—— 属各插件'],
    criteria: [
      '**均匀签名**：`uniform ⟺ |meanNll − ln(vocab_size)| ≤ max(2^-9·ln(vocab_size), z·std(NLL)/√n)`，z 默认 3；`vocab_size` 由调用方从模型 `config.json` 读入（**不硬编码**）。ε 每次测量重算并随证据返回（`criterion` 字符串逐字给出公式）。',
      '**双重门禁**：先判 validity（测量是否成立），再判数值（精度/性能是否达标）。`reason` 必须能区分「测量不成立」与「数值未达标」。',
      '**相对变化**：`baseline=0` 抛错（不得用 Infinity 冒充结论）。',
      '**缺陷 14（测量完整性可判定）**：`evalLM` / `evalMMLU` 必须返回 `attempted / succeeded / failed / skipped / considered / partial / okIndices / firstError`；`evalMMLU` 必须区分 `failed`（仪器层，非 200）与 `unparsed`（模型答了话但没给 A/B/C/D）。遗忘门禁**基于 `attempted`** 判，把「测量不完整」与「样本不足」报成**两种不同的理由**。',
      '**缺陷 15（完整性判定 fail-closed）**：`measurementCompleteness` 的判据是「**有证据证明完整**」，不是「看起来像完整」。旧条目（无 `attempted`/`failed`）一律不可复用；理由为 `missing` / `marked-invalid:…` / `<part>:no-integrity-evidence` / `<part>:failed=N/M` / `<part>:partial` / `no-instrumented-parts` / `unclassified-part:<k>`。',
      '**配对按下标交集**：遗忘门禁的同名配对必须按成功行的 `okIndices` **交集**，并带 `pairedOn: \'okIndices-intersection\' | \'positional-legacy\'`；无 `okIndices` 的旧产物退化为按位置时必须**在产物里标明**。',
      '**唯一实现**：逐插件的 `sftMmlu`/`ptMmlu`/`rlMmlu` 命名被**参数化**（候选侧标签），不是四份代码；插件侧只许再导出（`export … from`），不得含实现体（CI `C27` 组按 **函数对象同一性** 判定）。',
    ],
    notDoing: ['不规定「从哪取数」（同一判据允许多种取数来源）', '`index.mjs`（本体）不读文件、不发请求、不起容器（纯函数）；`./evaluate.mjs` 是**唯一**允许 `fetch` 的文件', '零运行时依赖（四个插件一致）'],
    testCriteria: 'ε 必须随 `n` 与 `std` 变化；均匀/非均匀各有已知对照；只给均值不给样本必须抛错；双重门禁必须区分两类失败；`baseline=0` 必须抛错。**v0.2.0 追加**：评估壳的八个导出在库内（唯一实现）；候选侧标签闭集；缺陷 15 的 fail-closed 语义（旧条目不可复用、带证据且 failed=0 才可复用、`null ⇒ missing`）在合并后仍成立。',
  },
  'data-core': {
    title: '数据集原语',
    criteria: [
      '**确定性切分**：排序键 = `sha256(seed + "\\u0000" + recordHash(rec))`；用**内容**而不是下标做键（下标在数据集版本变化时整体错位）。同 seed 同输入 ⇒ 逐条相同。',
      '**去泄漏**：两侧内容哈希交集必须为空，交集以哈希列表形式返回（可复核）。',
      '**血缘**：`source` 必填（无来源的产物不可追溯）。',
    ],
    notDoing: [
      '不下载数据集、不读网络、不分词（那是 `inference_quantization_dataset_prepare` 的职责）',
      '**不提供自动脱敏**：Step 0 纪律是「发现 PII → 暂停报告，不自行脱敏后继续」；提供自动脱敏函数等于邀请那条被禁止的路径。`piiScan` 只返回模式 id + 命中位置 + 样本哈希。',
    ],
    testCriteria: '键序不同的同一记录必须同哈希；同 seed 同结果、换 seed 变结果；样本不足必须抛错；人为泄漏必须被检出且交集可数；PII 扫描不得回显明文。',
  },
  'state-core': {
    title: '共享状态方言 / schema / 原子写',
    criteria: [
      '**方言对齐**：契约测试拿 `~/.ai-infra/state/*.yaml` 真实文件，让 state-core 与三个插件的 parser **各读一遍、结果逐字节相同**。不比较文档口径，比较行为。',
      '**schema 校验**：与 `inference-contracts/checks/run-all.mjs` 同一套语义（type/const/enum/pattern/required/items/properties）。不支持的 `$ref`/`oneOf`/… **抛错**而不是静默忽略。',
      '**并发写入裁决**：**乐观并发（CAS on content hash）+ 原子写，不加文件锁**。冲突抛 `ERR_STATE_CONFLICT`；重试策略属调用方。理由：flock 会引入跨 NFS/容器挂载的行为差异，而真正该被发现的是「两个写者同时改同一文件」这一语义冲突，不是把它排队藏起来。',
    ],
    notDoing: ['不引 YAML 库（沿用原实现的受限子集，零依赖是硬约束）', '不做文件锁（见上裁决）'],
    testCriteria: '导出集合与三插件相同；真实状态文件四份 parser 结果一致；往返一致且历史引号形态可读；CAS 过期必须抛 `ERR_STATE_CONFLICT`；不支持的 schema 关键字必须抛错。',
  },
  'audit-core': {
    title: 'append-only 审计哈希链',
    criteria: [
      '`verifyChain` 默认 **自动识别变体**并把结果写进返回值 —— 于是「这条链用哪个算法」成为可审计事实，而不是调用方必须事先知道的默契。',
      '**追加的串行化保证（LONGTASK5 补）**：`appendAudit` 把「读头 → 算 prevHash/seq → 追加」整体放在 `withAuditLock` 的临界区内完成，故**并发写者不会用同一个头各写一条**。',
      '**锁机制**：`O_EXCL` 建锁文件（可移植，不依赖 flock 语义），**只在毫秒级临界区持锁**；陈旧锁按 mtime（10s）接管，避免崩溃写者造成死锁；超时抛 `E_AUDIT_LOCK_TIMEOUT`。',
      '**为什么不是 CAS**：`state-core` 用 CAS 是因为它做**整份文档读-改-写**；审计链是**追加型**，必须让「头」在 `读头→追加` 期间保持稳定 —— CAS 只能**事后**发现冲突，而那时错行**已经落盘**。两类对象的并发语义不同，处置也应不同。',
      '**覆盖率由现场决定（LONGTASK5 补）**：`discoverChainPackages` 扫描审计目录，**有链的包就必须被复算**，覆盖范围不再由硬编码名单决定 —— 否则「新增插件忘了改名单」会让检查绿着而对象没被检查。',
      '只追加由四件事共同保证：`O_APPEND`（行不交错）+ **`withAuditLock`（头不陈旧）** + 文件模式 `0600` + API 层不存在删改导出。',
    ],
    variants: [
      ['`canonical-json`', '`sha256(canonicalJson(record 去掉 hash))`', '`inference-tuning` · `inference-diagnose`'],
      ['`prevhash-canonical-json`', '`sha256(prevHash + "\\n" + canonicalJson(record 去掉 hash))`', '`inference-serving` · `inference-quantization`'],
    ],
    boundary: [
      '链能检出**改动 / 插入 / 重排**；**不能**检出「从尾部截断」（截断后的前缀仍是一条自洽的链）。尾部截断须由外部期望计数或把 head 记在别处来发现。**不得**声称链能检出截断。',
      '**历史缺陷（已修，留档）**：`appendAudit` 曾**承诺**串行化但**未实现**（读头与追加之间有竞态窗口）。实测后果：`training-qat/2026-09-29.jsonl` 第 22 条 prevHash 指向第 20 条（#21 与 #22 相差 1ms，两者用了同一个头），`verifyChain` → `brokenAt: 22`。修复见 `withAuditLock`。',
      '**链修复协议（LONGTASK5 裁决 ②，今后所有链修复必须走同一流程）**：① **原件永久保留**（改名 `.broken-<ts>` 并旁挂 `.sha256`，**不得自动清理**）；② 断点处插入一条 `chain-repair` 记录，写明断点位置、原因、**原件路径与其 sha256**、修复内容、**重封范围**；③ 断点之后逐条重封（内容不变，只重算 prevHash/hash）；④ 脚本**默认 dry-run**，`--apply` 才落盘；⑤ **不得**用「重写历史抹平」的方式处置 —— 那会把篡改检测一起抹掉。参考实现：`inference-training/checks/repair-audit-chain.mjs`。',
      '**重封段的原始哈希不可再复现** —— 这是修链的固有代价，已在链内 `chain-repair` 记录中声明；读链者据此可知「哪一段被重封过、为什么、原件在哪」。',
    ],
    notDoing: ['不管「该记什么字段」（业务字段由调用方给）', '不做日志轮转/压缩（分片按日期天然切分）'],
    testCriteria: '两个变体对同一条记录给出不同哈希（= 「两个算法」的直接证据）；自建链篡改/插入必须检出并定位；**拿线上真实分片独立复算全部通过**，且检出的变体与登记表一致（谁改算法立刻红）；**覆盖率断言**：`discoverChainPackages` 发现的链数必须 ≥ 名单长度，且复算循环遍历「发现 ∪ 名单」—— 覆盖范围由现场决定，"检查通过"必须同时意味着"检查过"。',
  },
  'sandbox-core': {
    title: '三级沙箱行为探测与产物转移',
    criteria: [
      '**行为验证，不是存在性检查**：每层都要真的跑一条命令并看返回值。`process` → 受限子进程；`container` → 真的 `docker run --rm …`；`vm` → 真的启动一次最小 guest。`which` / `command -v` 的结果只作为**补充证据**，**不**参与 `available` 判定 —— 「装了」≠「生效」是本机实测教训。',
      '**降级策略**：`process` 不可用 ⇒ 提升到容器层；`container` / `vm` 不可用 ⇒ **拒绝执行**（`E_SANDBOX_UNAVAILABLE`，带 remediation）。任何情况下**不得**静默降级到 `none`。',
      '**产物转移**：逐文件哈希核对（源/目标双向），不一致即 `verified:false` 并列出不匹配项 —— 只做 `copyFile` 等于把「转移成功」当成「内容一致」。',
    ],
    notDoing: ['不实现沙箱本身（容器/VM 生命周期属各插件的 executor）', '`runner` 一律注入（默认实现用 child_process，测试可替换）'],
    testCriteria: '二进制「在」但跑不起来 ⇒ 仍判不可用；不可用层必须拒绝执行（命令根本没跑）；决策与证据一并返回；哈希不符必须 `verified:false`。',
  },
  'training-core': {
    title: '公共训练循环 / checkpoint / 资源上限 / 审计钩子',
    criteria: [
      '**产物级断言（共享守卫）**：`assertWeightFingerprint(payload, {what})` —— 检查点 payload 的权重指纹必须**齐备且相对起点确实变了**：缺指纹抛 `E_WEIGHT_FINGERPRINT_MISSING`，与起点相同抛 `E_NO_OP_TRAINING`（**"无法断言"按不通过处理**）。它同时认两套字段名（逐步档位 `fingerprint`/`initFingerprint`、单体档位 `artifactFingerprint`/`initArtifactFingerprint`），因此**一个实现被三个插件共用** —— 此前只有 pretrain 有此防线（实测 `fingerprint-coverage.mjs` 判 4 个插件里 3 个未过）。',
      '**两档插件接口**（v0.2.0 起）。**逐步档位**（未变）：插件是普通对象 `{ id, algorithm?, prepare?(ctx), step(batch, state) -> {loss, metrics?, done?}, finalize?(ctx), checkpointPayload?(ctx) }`；`step` 只接收 `(batch, state)` 并返回**普通对象**，全程不出现任何框架对象，循环本身不 import 任何训练框架。**单体档位**（新增）：`{ id, algorithm?, monolithic:true, run(ctx) }`，循环交给框架，插件**必须**在每个优化器步调用 `ctx.onStep(info)`。两档**不得同时声明**（装配期 fail-closed）。',
      '**单体档位的纪律 = 不信任插件、事后核对**：`ctx.onStep` 返回与 `enforceLimits` 同形的 gate（不抛错）；run 结束后 core **复核**实际步数/墙钟/GPU 小时，越限写入 `violations` 并置 `state.budgetViolation`。**0 步也算违规**（`no-steps`）—— 空操作不得当成功。',
      '**单体档位的等价 hooks**：`onStep` / `onCheckpoint` / `onEval` / `onBudgetExceeded` 四者齐备，与逐步档位一一对应（`hooks.afterStep`↔`onStep`、`type:checkpoint` 事件↔`onCheckpoint`、`enforceLimits` 命中↔`onBudgetExceeded`）；`onEval` 是**新增能力**（逐步档位本无周期评估），并带 `selectionOnly` 标记以区分"选点信号"与"判定"。',
      '**产物级断言**：`fingerprintArtifacts(dir)` 对权重文件取确定性指纹（相对路径+字节数+内容 sha256 的排序列表再哈希，非权重文件不影响）；`assertArtifactChanged` 在训练前后指纹相同时抛 `E_NO_OP_TRAINING`，指纹缺失抛 `E_ARTIFACT_FINGERPRINT_MISSING`（**"无法断言"按不通过处理**）。**只断言过程抓不到空操作，必须断言权重。**',
      '**超限行为**：`enforceLimits` **不抛错**（暂停不是异常），返回 `{stop, reason, checks, policy:"pause-and-report"}` —— **自动暂停 + 报告，不自动降级**。',
      '**checkpoint 往返**：`meta.payloadHash` 是 payload 的内容哈希，加载时复核；不一致抛 `E_CHECKPOINT_CORRUPT`。单体档位的存档同样走 `saveCheckpoint`，故受同一判据约束。',
      '**产物存储 dtype 策略（v0.4.0 追加，缺陷 16）**：评估产物的**未量化张量** dtype 由 `DTYPE_POLICY.evaluationProduct` 固定（`bfloat16` —— 基座与 PTQ 产物都是 BF16，本机实测；验收是 candidate-vs-base 配对比较，被测产物的存储 dtype 必须等于基线的）。判据落在**产物**上：`readTensorDtypes({dir})` 直接读 safetensors **文件头**按 dtype 计数（零依赖、不加载权重），`assertProductDtype` 在"读不到 / 浮点 dtype 不唯一 / 与策略不符"时分别抛 `E_PRODUCT_DTYPE_UNKNOWN` / `E_PRODUCT_DTYPE_VIOLATION`（**未知 ≠ 合规**）。`assertComparableDtype({baseline,candidate,conversion})`：**只比同 dtype 的产物**，跨 dtype 一律 `E_DTYPE_COMPARISON_REFUSED`（实测仅 F32→BF16 就使 serving 的 dropPct 变化 0.40pp：1.7205%→1.3212%）；调用方先把候选转成基线 dtype 再测量并用 `conversion:{from,to,declaredBy,reason}` 显式声明，声明必须与实测 dtype 对得上（否则 `E_DTYPE_CONVERSION_INVALID` / `E_DTYPE_CONVERSION_UNVERIFIED`）。**不改写历史产物**：记录 + 拒绝，不回填。',
      '**测量仪器来源（v0.3.0 追加）**：`instrumentFromDeployReport(deployReport)` 把 `inference-serving/deploy-report@1` 归一化成一份小的、JSON 安全的仪器记录（`effectiveConfig` = **真正部署**的那份配置、`degrade{steps,lossy,lossyWarning,tiers[]}`、`requestedConfig`、`degradedFrom`、`lossy`）。**纯函数**：只取叶子字段、绝不嵌入活对象（函数 / 循环引用 / 超深嵌套一律丢弃）；认不出形状或缺报告返回 `null`（**不抛错、也不编造**）。`assertInstrumentUsable(instrument, {runId})` 在 `instrument.lossy === true` 时抛 `E_INSTRUMENT_LOSSY`（带档位 id 与可执行补救），**`instrument == null` 不抛** —— 它只拒绝**已知有损**，"没有记录"由产物里的 `instrument: null` 显式承载。为什么需要：`eval-result@1` 曾只写判决不写仪器，实测一次 RL 测量里部署落进有损档位 `precision`（`dtype=half` + `quantization=fp8`），同一份权重测出 `25/48` 而非 `23/48`、判决翻转，而产物里没有任何字段表明被测模型已被量化。',
    ],
    includes: ['公共训练循环 `createTrainingLoop`（逐步档位）', '单体循环 `createMonolithicLoop`（v0.2.0 新增）', '档位判定 `pluginMode` / `MODES`', '产物级断言 `fingerprintArtifacts` / `assertArtifactChanged`', 'checkpoint 生命周期 `saveCheckpoint` / `loadCheckpoint` / `listCheckpoints`', '资源上限强制 `enforceLimits`', '审计钩子 `createAuditHook`', '预算默认值 `BUDGET_DEFAULTS`', '测量仪器来源 `instrumentFromDeployReport` / `assertInstrumentUsable`（v0.3.0 新增）', '产物存储 dtype 策略 `DTYPE_POLICY` / `normalizeDtype` / `readSafetensorsDtypes` / `readTensorDtypes` / `assertProductDtype` / `assertComparableDtype`（v0.4.0 新增）'],
    excludes: ['具体训练算法（SFT / 预训练 / RL / QAT 各自的实现）—— 属各 `training-*-plugin`', '数据预处理 / 分词 / 切分 —— 归 `@ai-infra/data-core`', '评估逻辑（精度/性能测量与门禁）—— 归 `@ai-infra/testing-core`', '分布式训练策略（DDP / FSDP / TP / PP）—— **v0 不含**，并发恒为 1', '模型结构定义 / 权重加载器 —— 由插件自己的可选依赖框架提供', '调度与编排（何时启动下一次训练）—— 属上层'],
    mockStrategy: '契约测试用 `{ id:"mock-sft", async step(batch){ return { loss: 1/(n+1) } } }` 把循环、上限、checkpoint、审计全部跑通 —— 零 GPU、零框架、零网络。**若有人往 training-core 里塞进 `import torch`，这个测试会立刻跑不起来**，这就是 mock 策略被破坏的最早信号。',
    optionalDeps: ['torch', 'transformers', 'peft', 'trl', 'accelerate'],
    testCriteria: 'mock 插件跑通全循环；数据耗尽必须有上界（否则空转 —— v0 修掉的真实缺陷）；注入 clock 断言墙钟超限暂停；checkpoint 往返哈希一致、被改动必须抛 `E_CHECKPOINT_CORRUPT`；审计链可复算且不含样本内容；导出面不得出现分布式/具体算法入口。**v0.2.0 追加**：四种非法插件形状装配期全拒（含"两档同时声明"）；单体档位步数停在上限、四个等价钩子全触发、checkpoint 可被 loadCheckpoint 读回；**阳性对照**：插件无视 stop 继续跑 ⇒ 事后核对记为越限且如实记账实际步数；0 步入违规；权重指纹逐位不变 ⇒ `E_NO_OP_TRAINING`。**v0.3.0 追加（仪器来源）**：有损 deploy-report ⇒ `lossy=true` 且档位 id 按 history 顺序完整捕获；无损 ⇒ `lossy=false` 且 `tiers=[]`；`degrade.lossy` 漏写但 history 里有有损条目 ⇒ 仍判有损；缺报告 / 非报告形状 ⇒ 全 `null` 且不抛错；含函数与循环引用的入参不抛错且活对象被丢弃（不进记录）；有损 ⇒ 抛 `E_INSTRUMENT_LOSSY` 且信息含档位 id / 补救 / runId；无损与缺失 ⇒ **不抛**（"不知道" ≠ "有损"）。 **v0.4.0 追加（产物 dtype）**：合成 safetensors 头 → BF16 放行 / F32 抛 `E_PRODUCT_DTYPE_VIOLATION` / 浮点 dtype 不唯一或没有未量化浮点或目录不存在 ⇒ `E_PRODUCT_DTYPE_UNKNOWN`；`F8_E4M3` 必须归入**量化**张量（按前缀判会把它当成未量化浮点，从而把所有产物误判成"未知"——已作为回归项钉住）；跨 dtype 比较抛 `E_DTYPE_COMPARISON_REFUSED` 且信息含 0.40pp 效应量；未知 dtype 不得参与比较；显式转换声明的 `from≠to`、`declaredBy`、`reason` 缺一即 `E_DTYPE_CONVERSION_INVALID`。',
  },
}

export const FILE_ORDER = LIBS

function renderFor(lib, mod, notes, pkg) {
  const L = []
  L.push(`# @ai-infra/${lib} —— 契约 v0（**frozen** 2026-09-28，长任务 1 / 阶段 B）`)
  L.push('')
  L.push(`> ${notes.title}。`)
  L.push('> **本文件的「导出面」一节由 `shared/gen-contracts.mjs` 从代码现场读取生成，请勿手改**；')
  L.push('> 人写的判据/边界在生成器的 `NOTES` 表里，改动须显式提交。')
  L.push('')
  L.push(`**契约版本**：\`${mod.CONTRACT_VERSION}\`　**包版本**：\`${pkg.version}\``)
  L.push('')
  L.push('## 导出面（冻结 —— major 变更须暂停报告，minor 允许追加）')
  L.push('')
  const names = Object.keys(mod).filter((k) => k !== 'default').sort()
  L.push(names.map((n) => `\`${n}\``).join(' · '))
  L.push('')
  if (notes.includes) {
    L.push('## 包含（v0）')
    L.push('')
    for (const x of notes.includes) L.push(`- ${x}`)
    L.push('')
  }
  if (notes.excludes) {
    L.push('## 不包含（v0 明确排除 —— 让「忘了做」与「主动不做」可区分）')
    L.push('')
    for (const x of notes.excludes) L.push(`- ${x}`)
    L.push('')
  }
  L.push('## 判据')
  L.push('')
  for (const c of notes.criteria) L.push(`- ${c}`)
  L.push('')
  if (notes.variants) {
    L.push('## 链变体（**实测发现：四个插件不是一个算法，是两个**）')
    L.push('')
    L.push('| variant | 公式 | 使用者（实测） |')
    L.push('|---|---|---|')
    for (const [a, b, c] of notes.variants) L.push(`| ${a} | ${b} | ${c} |`)
    L.push('')
  }
  if (notes.boundary) {
    L.push('## 已知边界（诚实记录）')
    L.push('')
    for (const b of notes.boundary) L.push(`- ${b}`)
    L.push('')
  }
  if (notes.mockStrategy) {
    L.push('## mock 策略（如何在不训练的情况下测试）')
    L.push('')
    L.push(notes.mockStrategy)
    L.push('')
  }
  if (notes.optionalDeps) {
    L.push('## 可选依赖组（显式声明）')
    L.push('')
    L.push(`${notes.optionalDeps.map((d) => `\`${d}\``).join(' / ')} 见 \`package.json\` 的 \`optionalDependencies\`。未列出的框架调用属「引入未声明依赖」。`)
    L.push('')
  }
  if (notes.notDoing) {
    L.push('## 不做（v0 排除）')
    L.push('')
    for (const x of notes.notDoing) L.push(`- ${x}`)
    L.push('')
  }
  L.push('## 契约测试判据（`tests/contract.mjs`）')
  L.push('')
  L.push(notes.testCriteria)
  L.push('')
  L.push('跑法：`node shared/run-all.mjs ' + lib + '`（或 `npm test`）。')
  L.push('')
  return L.join('\n')
}

export async function render() {
  const out = {}
  for (const lib of FILE_ORDER) {
    const mod = await import(`./libs/${lib}/src/index.mjs`)
    const pkg = JSON.parse(readFileSync(join(HERE, 'libs', lib, 'package.json'), 'utf8'))
    out[lib] = renderFor(lib, mod, NOTES[lib], pkg)
  }
  return out
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const docs = await render()
  const check = process.argv.includes('--check')
  let drift = 0
  for (const [lib, text] of Object.entries(docs)) {
    const p = join(HERE, 'libs', lib, 'CONTRACT.md')
    const have = existsSync(p) ? readFileSync(p, 'utf8') : null
    if (check) {
      if (have !== text) { console.error(`DRIFT ${lib}/CONTRACT.md`); drift += 1 }
    } else {
      writeFileSync(p, text)
      console.log(`written libs/${lib}/CONTRACT.md`)
    }
  }
  if (check) {
    console.log(drift === 0 ? 'CONTRACT.md 与代码一致（导出面无漂移）' : `${drift} 个文件漂移`)
    process.exit(drift === 0 ? 0 : 1)
  }
}
