/**
 * @xiciyang/training-core —— 公共训练循环 / checkpoint / 资源上限 / 审计钩子 v0
 * （契约冻结于 2026-09-28 长任务 1 / 阶段 B）。
 *
 * ────────────────────────────────────────────────────────────────────────
 * 边界（报告要求第 5 项要求的"包含什么 / 不包含什么"，逐条落地）
 * ────────────────────────────────────────────────────────────────────────
 * **包含**（v0 冻结）：
 *   ① 公共训练循环        `createTrainingLoop` —— step/epoch 记账、停止判据、事件流
 *   ② checkpoint 生命周期  `saveCheckpoint` / `loadCheckpoint` / `listCheckpoints`（含内容哈希校验）
 *   ③ 资源上限强制        `enforceLimits` —— 步数 / 墙钟 / GPU 小时 / 并发，**只暂停不降级**
 *   ④ 审计钩子            `createAuditHook` —— 每次 run 起止与停止原因写链
 *   ⑤ 预算默认值          `BUDGET_DEFAULTS`（长任务 1 的硬约束：≤2 GPU 小时 / ≤500 步 / 并发 1 / ≤0.5B）
 *
 * **不包含**（v0 明确排除，写在这里是为了让"忘了做"与"主动不做"可区分）：
 *   ① 具体训练算法（SFT / 预训练 / RL / QAT 各自的实现）—— 属各 training-*-plugin
 *   ② 数据预处理 / 分词 / 切分 —— 归 `@xiciyang/data-core`
 *   ③ 评估逻辑（精度/性能测量与门禁）—— 归 `@xiciyang/testing-core`
 *   ④ 分布式训练策略（DDP / FSDP / TP / PP）—— **v0 不含**；并发恒为 1
 *   ⑤ 模型结构定义 / 权重加载器 —— 由插件用自己声明为**可选依赖组**的框架提供
 *   ⑥ 调度与编排（何时启动下一次训练）—— 属上层
 *
 * ────────────────────────────────────────────────────────────────────────
 * 与训练插件的接口契约（v0）
 * ────────────────────────────────────────────────────────────────────────
 * 训练插件是一个**普通对象**（不是类、不要求继承）：
 *
 *   {
 *     id: string,                        // 稳定标识，进审计与 checkpoint 元数据
 *     algorithm: 'sft'|'pretrain'|'rl'|'qat'|string,
 *     prepare?(ctx) -> any,              // 一次性准备（加载模型/优化器）；返回值进 ctx.prepared
 *     step(batch, state) -> {loss, metrics?, done?},   // **唯一必须实现的方法**
 *     finalize?(ctx) -> any,             // 收尾（保存最终权重等）
 *     checkpointPayload?(ctx) -> any     // 自定义 checkpoint 内容（默认 {step, state}）
 *   }
 *
 * 关键约束（**就是 mock 策略本身**）：`step` 只接收 `(batch, state)` 并返回一个**普通对象**，
 * 全程**不出现任何框架对象**（无 torch.Tensor、无 Trainer、无 Optimizer 参数），
 * 循环也不 import 任何训练框架。于是：
 *   - 契约测试用 `{ id:'mock', step: async () => ({ loss: 1 }) }` 就能把循环、上限、checkpoint、
 *     审计全部跑通（`tests/contract.mjs` 就是这么做的，零 GPU、零框架、零网络）；
 *   - 真实插件把张量搬运、反向传播、优化器 step 全部封在自己的 `step` 里，
 *     框架依赖写在它自己的 `optionalDependencies` 里（见本库 package.json 的 `optionalDependencies` 声明）。
 *
 * 时间与随机性一律**注入**（`clock` / `batchSource`），循环本身不调 `Date.now()` 之外的全局状态，
 * 否则契约测试无法断言"超时暂停"这类行为。
 */

import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

// v0.4.0：**additive**（minor 允许追加）—— 新增"产物存储 dtype 策略"四个导出
// （`DTYPE_POLICY` / `normalizeDtype` / `readSafetensorsDtypes` / `readTensorDtypes` /
//  `assertProductDtype` / `assertComparableDtype`，见下方"缺陷 16"一节）。
// 既有的档位 / 循环 / 限额 / checkpoint / 审计钩子 / 仪器来源语义**一行未改**。
export const CONTRACT_VERSION = '0.4.0'

/** 长任务 1 的硬约束默认值（超限行为：**自动暂停 + 报告**，不自动降级）。 */
export const BUDGET_DEFAULTS = Object.freeze({
  maxSteps: 500,
  maxEpochs: null,
  maxWallMs: null,
  maxGpuHours: 2,
  concurrency: 1,
  maxParams: 0.5e9,
})

export const LIMIT_KEYS = Object.freeze(['maxSteps', 'maxEpochs', 'maxWallMs', 'maxGpuHours'])

/** 插件档位。v0.2.0 起有两档；**逐步档位保持原样不变**（major 变更只做追加）。 */
export const MODES = Object.freeze({ STEPWISE: 'stepwise', MONOLITHIC: 'monolithic' })

/** 判定插件属于哪一档。`step` 存在 ⇒ 逐步；`monolithic === true` ⇒ 单体。 */
export function pluginMode(plugin) {
  if (!plugin || typeof plugin !== 'object') return null
  if (typeof plugin.step === 'function') return MODES.STEPWISE
  if (plugin.monolithic === true && typeof plugin.run === 'function') return MODES.MONOLITHIC
  return null
}

/** 插件接口的最小形状校验 —— 装配期 fail-closed，不留到第一个 step 才发现。 */
export function assertTrainingPlugin(plugin) {
  const problems = []
  if (!plugin || typeof plugin !== 'object') problems.push('plugin 必须是对象')
  else {
    if (typeof plugin.id !== 'string' || plugin.id === '') problems.push('plugin.id 必须是非空字符串')
    const mode = pluginMode(plugin)
    // 两档同时声明必须**先**判：否则 `pluginMode` 只看 `step` 就会判成逐步档位，
    // 于是"同时声明两档"这个非法形状会被静默接受（契约测试的第一版就抓到了这一条）。
    if (typeof plugin.step === 'function' && plugin.monolithic === true) {
      problems.push('不得同时声明 step 与 monolithic（档位必须唯一，禁止两档之间静默漂移）')
    } else if (mode === null) {
      problems.push('必须实现 `step(batch, state)`（逐步档位），或声明 `{ monolithic: true, run(ctx) }`（单体档位）')
    } else if (mode === MODES.STEPWISE) {
      for (const f of ['prepare', 'finalize', 'checkpointPayload']) {
        if (plugin[f] !== undefined && typeof plugin[f] !== 'function') problems.push(`plugin.${f} 若存在必须是函数`)
      }
    } else {
      // 单体档位：`prepare`/`checkpointPayload` 不适用（循环在插件内部），但 `run` 必须是函数。
      for (const f of ['onEval', 'finalize']) {
        if (plugin[f] !== undefined && typeof plugin[f] !== 'function') problems.push(`单体插件 plugin.${f} 若存在必须是函数`)
      }
    }
  }
  if (problems.length > 0) throw new Error(`训练插件接口不合法（fail-closed）：${problems.join('；')}`)
  return true
}

/** 资源上限判定。返回**原因**，由调用方决定怎么报告 —— 本函数不抛错（暂停不是异常）。 */
export function enforceLimits(state, limits = {}) {
  const l = { ...BUDGET_DEFAULTS, ...limits }
  const checks = []
  if (Number.isFinite(l.maxSteps) && state.step >= l.maxSteps) checks.push({ limit: 'maxSteps', value: state.step, threshold: l.maxSteps })
  if (Number.isFinite(l.maxEpochs) && state.epoch >= l.maxEpochs) checks.push({ limit: 'maxEpochs', value: state.epoch, threshold: l.maxEpochs })
  if (Number.isFinite(l.maxWallMs) && state.wallMs >= l.maxWallMs) checks.push({ limit: 'maxWallMs', value: state.wallMs, threshold: l.maxWallMs })
  if (Number.isFinite(l.maxGpuHours) && state.gpuHours >= l.maxGpuHours) checks.push({ limit: 'maxGpuHours', value: state.gpuHours, threshold: l.maxGpuHours })
  return {
    stop: checks.length > 0,
    reason: checks.length > 0 ? `budget-exhausted:${checks.map((c) => c.limit).join('+')}` : null,
    checks,
    policy: 'pause-and-report', // **不降级**：超限即停，由上层报告并等裁决
  }
}

export function canonicalize(value) {
  return sortDeep(value)
}
export function canonicalJson(value) {
  return JSON.stringify(sortDeep(value))
}
function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep)
  if (v && typeof v === 'object') {
    const out = {}
    for (const k of Object.keys(v).sort()) {
      if (v[k] === undefined) continue
      out[k] = sortDeep(v[k])
    }
    return out
  }
  return v
}
export function stateHash(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`
}

/**
 * 公共训练循环。
 *
 * @param {object} p
 * @param {object} p.plugin         训练插件（见文件头接口契约）
 * @param {Function|AsyncFunction} p.batchSource  (state) -> batch | null（null = 本轮数据耗尽）
 * @param {object} [p.limits]        资源上限（默认 BUDGET_DEFAULTS）
 * @param {object} [p.checkpoint]    {dir, every, keep} 定期存档
 * @param {Function} [p.onEvent]     (event) => void 事件流（step/epoch/stop）
 * @param {Function} [p.clock]       () => ms，注入以便测试断言墙钟暂停
 * @param {Function} [p.hooks]       {beforeStep, afterStep, onStop} 审计钩子挂点
 * @param {number} [p.epochs]        数据耗尽后最多跑几个 epoch（默认 1；`limits.maxEpochs` 优先）
 */
export function createTrainingLoop({
  plugin,
  batchSource,
  limits = {},
  checkpoint = null,
  onEvent = () => {},
  clock = () => Date.now(),
  hooks = {},
  epochs = 1,
} = {}) {
  assertTrainingPlugin(plugin)
  if (typeof batchSource !== 'function') throw new Error('batchSource 必须实现（契约测试用 mock 队列，真插件用自己的 DataLoader）')
  const L = { ...BUDGET_DEFAULTS, ...limits }
  // 数据耗尽后最多跑几个 epoch。**必须有上界**：batchSource 在数据耗尽后恒返回 null，
  // 若 maxEpochs 与 epochs 都不设限，循环会在"epoch-end → continue"上永不退出（空转）。
  // 这是 v0 修掉的一个真实缺陷：契约测试第一次跑就 OOM 了。
  const EPOCHS = Number.isFinite(L.maxEpochs) ? L.maxEpochs : (Number.isFinite(epochs) ? epochs : 1)
  const state = { step: 0, epoch: 0, wallMs: 0, gpuHours: 0, plugin: plugin.id, algorithm: plugin.algorithm ?? null, losses: [], stopReason: null }
  const t0 = clock()
  const checkpoints = []

  async function run() {
    let prepared
    if (plugin.prepare) prepared = await plugin.prepare({ state, limits: L })
    const ctx = { state, limits: L, prepared: prepared ?? null }
    let stop = null
    for (;;) {
      state.wallMs = clock() - t0
      const gate = enforceLimits(state, L)
      if (gate.stop) { stop = gate; break }
      // eslint-disable-next-line no-await-in-loop
      const batch = await batchSource(state)
      if (batch === null || batch === undefined) {
        state.epoch += 1
        onEvent({ type: 'epoch-end', epoch: state.epoch, step: state.step })
        if (state.epoch >= EPOCHS) { stop = { stop: true, reason: 'data-exhausted', checks: [{ limit: 'epochs', value: state.epoch, threshold: EPOCHS }] }; break }
        continue
      }
      if (hooks.beforeStep) await hooks.beforeStep({ state, batch })
      // eslint-disable-next-line no-await-in-loop
      const out = await plugin.step(batch, state)
      if (!out || typeof out !== 'object') throw new Error(`plugin.step 必须返回对象（实际 ${typeof out}）`)
      state.step += 1
      if (Number.isFinite(out.loss)) state.losses.push(out.loss)
      onEvent({ type: 'step', step: state.step, epoch: state.epoch, loss: out.loss ?? null, metrics: out.metrics ?? null })
      if (hooks.afterStep) await hooks.afterStep({ state, batch, out })
      if (out.done === true) { stop = { stop: true, reason: 'plugin-done', checks: [] }; break }
      if (checkpoint && Number.isFinite(checkpoint.every) && checkpoint.every > 0 && state.step % checkpoint.every === 0) {
        // eslint-disable-next-line no-await-in-loop
        const cp = await saveCheckpoint({ dir: checkpoint.dir, name: `step-${String(state.step).padStart(6, '0')}`, payload: plugin.checkpointPayload ? await plugin.checkpointPayload(ctx) : { step: state.step, state: { losses: state.losses } }, meta: { plugin: plugin.id, algorithm: state.algorithm, step: state.step, epoch: state.epoch } })
        checkpoints.push(cp)
        onEvent({ type: 'checkpoint', step: state.step, name: cp.name, hash: cp.hash })
        if (Number.isFinite(checkpoint.keep) && checkpoints.length > checkpoint.keep) {
          // eslint-disable-next-line no-await-in-loop
          await removeCheckpoint(checkpoint.dir, checkpoints.shift().name)
        }
      }
    }
    state.wallMs = clock() - t0
    state.stopReason = stop?.reason ?? null
    if (plugin.finalize) await plugin.finalize({ ...ctx, stop })
    if (hooks.onStop) await hooks.onStop({ state, stop })
    onEvent({ type: 'stop', reason: state.stopReason, step: state.step, wallMs: state.wallMs })
    return { state: { ...state }, stop, checkpoints }
  }

  return { run, state, limits: L, pluginId: plugin.id }
}

/* ══════════════════════ 单体档位（v0.2.0 新增；major 变更，已预授权） ══════════════════════ */

/**
 * 单体循环。
 *
 * ## 为什么需要它（不是"图省事"）
 * 冻结的逐步档位要求插件实现 `step(batch, state)`，即**循环必须由 training-core 拥有**。
 * 但主流 RL / QAT 框架（TRL 的 `GRPOTrainer.train()`、torchao 的 QAT 流程）自带
 * dataloader / 生成 / 优势估计 / KL / 优化器步 / checkpoint，**不暴露单步 API**。
 * 于是只有两条路：把框架重写一遍（丢掉落地的实现，并引入数值漂移），
 * 或者给 training-core 加一个**单体档位**。用户已裁决走后者（长任务 4 裁决 ②）。
 *
 * ## 这个档位的纪律：**不信任插件，改为事后核对**
 * 单体档位把循环让给插件，于是"插件到底有没有守限额"不能靠约定 —— 必须**核实测**：
 *   - `ctx.onStep(info)` 必须在**每个优化器步**被调用一次；core 用它推进 `state.step`
 *     并在其中判定限额，超限时把 `stop` 回传给插件（**不抛错**，与逐步档位同一条原则）。
 *   - run 结束后 core **复核**：实际步数 / 墙钟 / GPU 小时若越过限额，记 `violations`
 *     并把 `state.budgetViolation` 置真（**违规被记录，而不是被容忍**）。
 *   - `ctx.shouldStop()` / `ctx.signal` 给插件一条可立即中断框架循环的通道。
 *
 * ## 与逐步档位的 hooks 等价表
 * | 逐步档位 | 单体档位 |
 * |---|---|
 * | `hooks.afterStep` | `hooks.onStep`（由 `ctx.onStep` 触发） |
 * | `onEvent({type:'checkpoint'})` | `hooks.onCheckpoint`（由 `ctx.onCheckpoint` 或 core 自动存档触发） |
 * | （逐步档位没有周期评估） | `hooks.onEval`（由 `ctx.onEval` 触发）—— **新增能力**，见契约版本节 |
 * | `enforceLimits` 命中即 break | `hooks.onBudgetExceeded`（由 `ctx.onStep` 命中时触发） |
 *
 * ⚠️ 逐步档位本身**未改动**（major 变更只做追加）；上表第 3 行是**能力增强**而非语义分叉。
 */
export function createMonolithicLoop({
  plugin,
  limits = {},
  checkpoint = null,
  onEvent = () => {},
  clock = () => Date.now(),
  hooks = {},
} = {}) {
  assertTrainingPlugin(plugin)
  if (pluginMode(plugin) !== MODES.MONOLITHIC) {
    throw new Error(`createMonolithicLoop 只接受单体插件（{monolithic:true, run}），实得 ${pluginMode(plugin) ?? '未知档位'}`)
  }
  const L = { ...BUDGET_DEFAULTS, ...limits }
  const state = {
    step: 0, epoch: 0, wallMs: 0, gpuHours: 0,
    plugin: plugin.id, algorithm: plugin.algorithm ?? null,
    losses: [], stopReason: null, mode: MODES.MONOLITHIC,
  }
  const t0 = clock()
  const checkpoints = []
  const evaluations = []
  const violations = []
  const budgetEvents = []
  const abort = new AbortController()
  let stopGate = null

  async function rotate() {
    if (!Number.isFinite(checkpoint?.keep)) return
    while (checkpoints.length > checkpoint.keep) {
      // eslint-disable-next-line no-await-in-loop
      await removeCheckpoint(checkpoint.dir, checkpoints.shift().name)
    }
  }

  async function doCheckpoint(reason) {
    if (!checkpoint?.dir) return null
    const name = `step-${String(state.step).padStart(6, '0')}`
    const cp = await saveCheckpoint({
      dir: checkpoint.dir,
      name,
      payload: {
        step: state.step, state: { losses: state.losses }, reason,
        // 产物级断言所需的指纹也进 payload ⇒ checkpoint 往返可校验（checkpoint-contract 三项判据）
        artifactFingerprint: typeof plugin.artifactFingerprint === 'function' ? await plugin.artifactFingerprint() : null,
        // **起点指纹**：没有它 `assertArtifactChanged` 用不了（缺 before ⇒ E_ARTIFACT_FINGERPRINT_MISSING）。
        // 此前默认 payload 只有"当前指纹"、没有"起点"，于是单体档位插件（qat）无从做空操作断言。
        initArtifactFingerprint: typeof plugin.initArtifactFingerprint === 'function' ? await plugin.initArtifactFingerprint() : null,
      },
      meta: { plugin: plugin.id, algorithm: state.algorithm, step: state.step, epoch: state.epoch, mode: MODES.MONOLITHIC },
    })
    checkpoints.push(cp)
    onEvent({ type: 'checkpoint', step: state.step, name: cp.name, hash: cp.hash, reason })
    if (hooks.onCheckpoint) await hooks.onCheckpoint({ state, checkpoint: cp, reason })
    await rotate()
    return cp
  }

  const ctx = {
    state, limits: L, signal: abort.signal,
    /** **必须**在每个优化器步调用一次。返回与 `enforceLimits` **同形**的 gate（不抛错）。 */
    async onStep(info = {}) {
      state.step += 1
      if (Number.isFinite(info.epoch)) state.epoch = info.epoch
      state.wallMs = Number.isFinite(info.wallMs) ? info.wallMs : clock() - t0
      if (Number.isFinite(info.gpuHours)) state.gpuHours = info.gpuHours
      if (Number.isFinite(info.loss)) state.losses.push(info.loss)
      onEvent({ type: 'step', step: state.step, epoch: state.epoch, loss: info.loss ?? null, metrics: info.metrics ?? null })
      if (hooks.onStep) await hooks.onStep({ state, info })
      const gate = enforceLimits(state, L)
      if (gate.stop && !stopGate) {
        stopGate = gate
        budgetEvents.push({ at: state.step, ...gate })
        abort.abort()
        if (hooks.onBudgetExceeded) await hooks.onBudgetExceeded({ state, gate })
      }
      if (checkpoint?.dir && Number.isFinite(checkpoint.every) && checkpoint.every > 0 && state.step % checkpoint.every === 0) {
        await doCheckpoint('interval')
      }
      return stopGate ?? gate
    },
    /** 周期评估上报。`selectionOnly: true` ⇒ 只作选点信号、不作判定（training-eval-contract §5.2）。 */
    async onEval(info = {}) {
      const rec = {
        step: info.step ?? state.step, split: info.split ?? null, metric: info.metric ?? null,
        value: Number.isFinite(info.value) ? info.value : null, unit: info.unit ?? null,
        selectionOnly: info.selectionOnly === true,
      }
      evaluations.push(rec)
      onEvent({ type: 'eval', ...rec })
      if (hooks.onEval) await hooks.onEval({ state, eval: rec })
      return rec
    },
    onCheckpoint: (reason = 'plugin') => doCheckpoint(reason),
    onBudgetExceeded: (gate) => (hooks.onBudgetExceeded ? hooks.onBudgetExceeded({ state, gate }) : undefined),
    shouldStop: () => stopGate !== null,
    stopReason: () => stopGate?.reason ?? null,
  }

  async function run() {
    const t0r = clock()
    let outcome = null
    try {
      outcome = await plugin.run(ctx)
    } finally {
      if (clock() - t0r > 0) state.wallMs = clock() - t0r
      if (Number.isFinite(outcome?.gpuHours)) state.gpuHours = outcome.gpuHours
      state.stopReason = stopGate?.reason ?? outcome?.stopReason ?? 'plugin-done'

      // ── **事后核对**：不信任插件"应该会守限额"，核实测（本档位的核心纪律）
      const post = enforceLimits(state, L)
      for (const c of post.checks) violations.push({ ...c, phase: 'post-run' })
      if (state.step === 0) violations.push({ limit: 'no-steps', value: 0, threshold: 1, phase: 'post-run', note: 'run 结束但没有任何 onStep —— 空操作训练' })
      state.budgetViolation = violations.length > 0

      state.wallMs = clock() - t0
      if (plugin.finalize) await plugin.finalize({ ...ctx, outcome })
      if (hooks.onStop) await hooks.onStop({ state, stop: stopGate, outcome, violations })
      onEvent({ type: 'stop', reason: state.stopReason, step: state.step, wallMs: state.wallMs, violations: violations.length })
    }
    return {
      state: { ...state, evaluations, budgetEvents },
      stop: stopGate ?? { stop: false, reason: state.stopReason, checks: [] },
      checkpoints, evaluations, violations, outcome,
    }
  }

  return { run, state, limits: L, pluginId: plugin.id, mode: MODES.MONOLITHIC, ctx }
}

/* ═══════════════ 产物级断言（"只断言过程抓不到空操作，必须断言权重"） ═══════════════ */

const WEIGHT_RE = /\.(safetensors|bin|pt|pth|ckpt|gguf)$/i

/**
 * 对一组**权重文件**取确定性指纹：对 (相对路径, 字节数, 内容 sha256) 的排序列表再哈希。
 *
 * 为什么不能只看"损失下降了"：损失是**过程量** —— 一个什么都没写盘的 run 也能打印出下降的 loss。
 * 训练真正在乎的量是**权重变了没有**，故断言落在指纹上。
 */
export async function fingerprintArtifacts(dir) {
  if (!dir) throw new Error('fingerprintArtifacts 需要 dir')
  let entries = []
  try { entries = await fs.readdir(dir, { recursive: true, withFileTypes: true }) } catch { return { dir, files: [], hash: null } }
  const files = []
  for (const e of entries) {
    if (!e.isFile()) continue
    const abs = join(e.parentPath ?? e.path ?? dir, e.name)
    if (!WEIGHT_RE.test(e.name)) continue
    // eslint-disable-next-line no-await-in-loop
    const buf = await fs.readFile(abs)
    files.push({ rel: abs.slice(dir.length + 1), bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') })
  }
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  return { dir, files, hash: files.length ? `sha256:${createHash('sha256').update(canonicalJson(files)).digest('hex')}` : null }
}

/**
 * 产物级断言：训练产出必须与训练前**不同**。
 * 相同 ⇒ 抛 `E_NO_OP_TRAINING`（fail-closed：空操作绝不能被当成"训练成功"）。
 * 指纹缺失同样不通过 —— "无法断言"不等于"没问题"。
 */
/**
 * **检查点权重指纹守卫（共享实现）** —— 三个训练插件此前各写一份（sft 有、rl/qat 无）。
 *
 * fail-closed 两条：
 *   ① 指纹**缺失** ⇒ 抛（"无法断言"不等于"没问题"）；
 *   ② 与起点**相同** ⇒ 抛 `E_NO_OP_TRAINING`（空操作绝不能被记成训练成功）。
 *
 * 为什么放在共享库而不是各插件各写一份：本仓库已经吃过"原则只固化在一处"的亏
 * （`fingerprint` 只在 pretrain 有，sft/rl/qat 三种形状）。**一个实现，三处使用。**
 */
export function assertWeightFingerprint(payload, { what = '权重' } = {}) {
  const fp = payload?.fingerprint ?? payload?.artifactFingerprint
  const init = payload?.initFingerprint ?? payload?.initArtifactFingerprint
  if (typeof fp !== 'string' || fp.trim() === '' || typeof init !== 'string' || init.trim() === '') {
    throw new Error(`E_WEIGHT_FINGERPRINT_MISSING: ${what} 的指纹缺失（fingerprint=${fp ?? null}, initFingerprint=${init ?? null}）—— 无法断言，按不通过处理`)
  }
  return assertArtifactChanged({ before: { hash: init }, after: { hash: fp }, what })
}

export function assertArtifactChanged({ before, after, what = 'weights' } = {}) {
  if (!before?.hash || !after?.hash) {
    throw new Error(`E_ARTIFACT_FINGERPRINT_MISSING: ${what} 的指纹缺失（before=${before?.hash ?? null}, after=${after?.hash ?? null}）—— 无法断言，按不通过处理`)
  }
  if (before.hash === after.hash) {
    throw new Error(`E_NO_OP_TRAINING: ${what} 在训练前后**逐位相同**（${after.hash}）—— 这是一次空操作，不得记为训练成功`)
  }
  return { ok: true, before: before.hash, after: after.hash, changedFiles: after.files?.length ?? null }
}

/* ═══════════════ 测量仪器来源（instrument provenance，v0.3.0 新增） ═══════════════ */

/**
 * ## 为什么需要这一节（真实缺陷，不是假想）
 *
 * `eval-result@1` 只写**判决**，不写"这个判决是用**什么仪器**测出来的"。
 * 实测后果：一次 RL 测量里，某次部署落进了 `inference-serving` 的**有损**降级档位
 * `precision`（`degradeStep=3`，该档位自标 `lossy: true`，`apply()` 把配置改写成
 * `dtype: 'half'` + `quantization: 'fp8'`）。**同一份策略权重**于是测出
 * `25/48 = 52.1%` 而不是 `23/48 = 47.9%` —— 门禁判决直接**翻转**，
 * 而 `eval-result.json` 里**没有哪怕一个字段**表明被测模型已经被量化过。
 *
 * 信息在上游**本来就有**：`inference-serving` 的 `deploy.mjs` `buildReport(...)` 返回
 * `inference-serving/deploy-report@1`，带 `finalConfig`（**真正部署的那份配置**）、
 * `degrade { steps, lossy, lossyWarning, history[] }`、`requestedConfig`、`degradedFrom`。
 * serving 侧甚至早就把教训写在 `buildReport` 上方：**"报告撒谎比没报告更糟"**
 * （早期它报告的是基线 standard，于是降过级的部署里报告写着
 * `gpu-memory-utilization=0.95` 而实际跑的是 `0.13`）。
 * 训练侧只是**没有把这份报告带下去**。本节就是"把它带下去"的那一步。
 *
 * ## 纪律
 *   - **纯函数**：只读入参、只取叶子字段，绝不嵌入活对象
 *     （serving / Cordis 对象不是 JSON，`JSON.stringify` 它们不是"记录"，是"泄漏内部"）。
 *   - **不得编造**：不是 deploy-report 形状的入参返回 `null`；缺字段一律记 `null`，
 *     不猜、也不拿默认值把它填成一份"看起来合理"的记录。
 */

/** 只保留 JSON 叶子（字符串 / 数字 / 布尔 / null 及它们的浅层容器），丢弃函数与活对象。 */
function leafOnly(value, depth = 0) {
  if (value === null || value === undefined) return null
  const t = typeof value
  if (t === 'string' || t === 'boolean') return value
  if (t === 'number') return Number.isFinite(value) ? value : null
  if (t !== 'object' || depth >= 4) return null // 深于 4 层 / 非普通对象：丢弃，不冒险序列化
  if (Array.isArray(value)) return value.map((v) => leafOnly(v, depth + 1))
  const out = {}
  for (const k of Object.keys(value)) {
    const v = leafOnly(value[k], depth + 1)
    if (v !== null || value[k] === null) out[k] = v
  }
  return out
}

const asStr = (v) => (typeof v === 'string' && v !== '' ? v : null)

/**
 * 把 `inference-serving` 的 deploy-report 归一化成一份**小的、JSON 安全的**仪器记录。
 *
 * @param {unknown} deployReport `inference_serving_deploy` 信封里的 `report` 字段
 * @returns {null | {
 *   servedBy: 'inference-serving', deployReportSchema: string|null, outcome: string|null,
 *   reused: boolean, endpoint: {url: string|null, servedModelName: string|null}|null,
 *   requestedConfig: object|null, effectiveConfig: object|null, degradedFrom: string|null,
 *   degrade: {steps: number, lossy: boolean, lossyWarning: string|null, tiers: string[]},
 *   lossy: boolean,
 * }} 认不出形状 / 缺报告 ⇒ `null`（**不抛错**，也**不编造**）
 */
export function instrumentFromDeployReport(deployReport) {
  if (!deployReport || typeof deployReport !== 'object' || Array.isArray(deployReport)) return null
  // 形状不像 deploy-report ⇒ null。"没有记录"是诚实的；一份看起来合理的假记录不是。
  const looksLikeReport = typeof deployReport.schema === 'string'
    || (deployReport.degrade && typeof deployReport.degrade === 'object')
    || (deployReport.finalConfig && typeof deployReport.finalConfig === 'object')
  if (!looksLikeReport) return null

  const degrade = deployReport.degrade && typeof deployReport.degrade === 'object' ? deployReport.degrade : null
  const history = Array.isArray(degrade?.history) ? degrade.history : []
  const tiers = history
    .map((h) => (h && typeof h === 'object' ? asStr(h.tier) : null))
    .filter((x) => x !== null)
  // `buildReport` 自己算过 `degrade.lossy`；这里**再按 history 复核一次**：
  // 两个来源只要有一个说有损，就是有损（fail-closed，不因为上游少写一个布尔就放行）。
  const lossy = degrade?.lossy === true || history.some((h) => h && typeof h === 'object' && h.lossy === true)
  const ep = deployReport.endpoint && typeof deployReport.endpoint === 'object' ? deployReport.endpoint : null

  return {
    servedBy: 'inference-serving',
    deployReportSchema: asStr(deployReport.schema),
    outcome: asStr(deployReport.outcome),
    reused: deployReport.reused === true,
    endpoint: ep ? { url: asStr(ep.url), servedModelName: asStr(ep.servedModelName) } : null,
    requestedConfig: leafOnly(deployReport.requestedConfig),
    effectiveConfig: leafOnly(deployReport.finalConfig),
    degradedFrom: asStr(deployReport.degradedFrom),
    degrade: {
      steps: Number.isFinite(degrade?.steps) ? degrade.steps : tiers.length,
      lossy,
      lossyWarning: asStr(degrade?.lossyWarning),
      tiers,
    },
    lossy,
  }
}

/**
 * fail-closed：**不得在"有损仪器"上验收测量结果**。
 *
 * `instrument?.lossy === true` ⇒ 抛 `E_INSTRUMENT_LOSSY`（带 tiers 与可执行的补救）。
 * 调用方必须让这次 run 停下：在量化 / 降精度后的仪器上测出来的数字**不得被签收**。
 *
 * **边界（刻意如此）**：`instrument == null`（没有记录）**不抛**。
 * 它是"不知道"，不是"已知有损"。本函数只拒绝**已知有损**，
 * 不用"缺证据"把 run 判死 —— 那会把"覆盖不足"伪装成"安全"的反面（过度拒绝），
 * 也会让所有历史 / 缓存路径一律红。缺记录这件事由产物里的 `instrument: null` 显式承载。
 *
 * @param {object|null} instrument `instrumentFromDeployReport(...)` 的返回值
 * @param {{runId?: string|null}} [ctx]
 */
export function assertInstrumentUsable(instrument, { runId = null } = {}) {
  if (instrument?.lossy !== true) {
    return { ok: true, lossy: false, tiers: Array.isArray(instrument?.degrade?.tiers) ? instrument.degrade.tiers : [] }
  }
  const tiers = Array.isArray(instrument.degrade?.tiers) ? instrument.degrade.tiers : []
  const tierText = tiers.length > 0 ? tiers.join(' → ') : '未知档位'
  const err = new Error(
    `E_INSTRUMENT_LOSSY: 测量仪器经过**有损**降级（tiers=${tierText}${runId ? `, run=${runId}` : ''}）—— `
    + '在量化 / 降精度后的仪器上测出的数字不得被签收：同一份权重在有损仪器上已实测出过判决翻转（25/48 vs 23/48）。'
    + `补救（按代价从低到高）：① 调低 maxModelLen；② 调低 gpuMemoryUtilization；③ 换更小的模型；`
    + `④ 换**已经量化好的**产物（让 serving 无需为省内存自行降精度）。然后**重新测量**，不得复用本次数字。`
    + (instrument.degrade?.lossyWarning ? `（serving 的告警原文：${instrument.degrade.lossyWarning}）` : ''),
  )
  err.code = 'E_INSTRUMENT_LOSSY'
  err.remediation = '调低 maxModelLen / gpuMemoryUtilization，或换更小、或已量化的产物，使部署不再落入有损降级档位；然后重新测量'
  err.details = {
    runId,
    tiers,
    degradedFrom: instrument.degradedFrom ?? null,
    effectiveConfig: instrument.effectiveConfig ?? null,
    lossyWarning: instrument.degrade?.lossyWarning ?? null,
  }
  throw err
}

/* ═════════════ 产物存储 dtype 策略（缺陷 16，v0.4.0 新增） ═════════════ */

/**
 * ## 为什么需要这一节（真机实测，不是假想）
 *
 * QAT 产物把**未量化张量**存成 **F32**，而基座与 PTQ 产物存 **BF16**。
 * 同一份权重、同一会话、同一数据集、同一仪器（serving）下，**只把 dtype F32→BF16**
 * 就使测得的 `dropPct` 从 **1.7205% 变成 1.3212%**（0.40 pp）—— 见
 * `DUAL_PATH_CALIBRATION_REPORT.md` §4。⇒ **产物的存储 dtype 是一个会影响测量的变量**，
 * 而它此前**没有被任何门禁建模**：`eval-result` 只写判决，不写"判决是在什么 dtype 上测的"。
 *
 * 本节的纪律（与 `instrumentFromDeployReport` 同族，都是"测量仪器来源"）：
 *   ① **策略固定**：评估产物的未量化张量 dtype = `DTYPE_POLICY.evaluationProduct`；
 *   ② **断言落在产物上**：dtype 从**权重文件头**读出来，不是从流程报告里抄
 *      （"只断言过程抓不到空操作，必须断言权重"）；
 *   ③ **跨 dtype 比较必须显式声明**，否则**拒绝**（fail-closed）—— 沉默地比一个 F32 产物
 *      与一个 BF16 基线，等于把 0.40pp 的 dtype 效应混进 Δ 里，而且无人看得出。
 *   ④ **不改写历史产物**：已经产出的东西是什么就是什么 —— 记录 + 拒绝，不回填。
 *
 * ### 为什么策略选 `bfloat16`
 *   ① 基座模型 `config.json` 的 `torch_dtype` 是 `bfloat16`（本机实测 290/290 张量 BF16）；
 *   ② PTQ 产物（fp8-dynamic，`inference-quantization`）同样是 **BF16 未量化 + F8_E4M3 量化**
 *      （290 BF16 + 168 F8_E4M3）；
 *   ③ 验收判据是 **candidate vs base** 的配对比较 ⇒ 被测产物的存储 dtype 必须等于**基线**的，
 *      否则"测得的差"里混进一个与训练/量化无关的 dtype 效应；
 *   ④ BF16 是**父模型自己的**存储精度：QAT 产物不比它的父模型更精确，也不比同族任何产物更特殊。
 *      （F32 会让 QAT 成为注册表里唯一一个 F32 产物 —— 与它要对比的每一个对象都不同。）
 */

/** 评估产物的存储 dtype 策略（**冻结**；改它必须显式改这里，并让 CI 的 dtype 断言跟着走）。 */
export const DTYPE_POLICY = Object.freeze({
  evaluationProduct: 'bfloat16',
  why: '基座与 PTQ 产物都存 BF16（本机实测）；验收判据是 candidate-vs-base 的配对比较，'
    + '被测产物的存储 dtype 必须等于基线的。实测仅把 dtype F32→BF16 就使 serving 测得的 dropPct 变化 0.40pp（1.7205%→1.3212%）。',
  /** 参与"未量化张量"判定的浮点 dtype（其余（F8_E4M3 / I8 / U8 …）按量化张量看待）。 */
  floatDtypes: Object.freeze(['float64', 'float32', 'float16', 'bfloat16']),
})

const DTYPE_ALIASES = {
  f64: 'float64', double: 'float64', float64: 'float64',
  f32: 'float32', float: 'float32', float32: 'float32',
  f16: 'float16', half: 'float16', float16: 'float16',
  bf16: 'bfloat16', bfloat16: 'bfloat16',
  'torch.float64': 'float64', 'torch.float32': 'float32', 'torch.float16': 'float16', 'torch.bfloat16': 'bfloat16',
  'torch.double': 'float64', 'torch.float': 'float32', 'torch.half': 'float16',
}

/** dtype 字符串归一化。**认不出就返回 `null`** —— 不猜、不默认（"未知 ≠ 合规"）。 */
export function normalizeDtype(value) {
  if (typeof value !== 'string') return null
  return DTYPE_ALIASES[value.trim().toLowerCase()] ?? null
}

/** safetensors 头里的 dtype 记号 → 归一化名。 */
const ST_TO_CANON = {
  F64: 'float64', F32: 'float32', F16: 'float16', BF16: 'bfloat16',
  F8_E4M3: 'float8_e4m3fn', F8_E5M2: 'float8_e5m2',
  I64: 'int64', I32: 'int32', I16: 'int16', I8: 'int8', U8: 'uint8', BOOL: 'bool',
}

/** 「未量化浮点」的 dtype 闭集（来自策略，单一真源）。`float8_*` **不在其中**（那是量化权重）。 */
const FLOAT_DTYPES = new Set(DTYPE_POLICY.floatDtypes)

/**
 * 读一个 safetensors **文件头**，按 dtype 计数。
 *
 * 为什么读头就够：safetensors 的开头是「8 字节小端 header 长度 + JSON header」，
 * 每个张量的 `dtype` 就写在里面 —— 不需要加载任何权重数据，**零依赖、恒定开销**。
 * 认不出的容器（`.bin` / 缺文件）一律**上报为读不到**，而不是当作合规。
 */
export async function readSafetensorsDtypes(file, { fs: fsImpl = fs } = {}) {
  const fh = await fsImpl.open(file, 'r')
  try {
    const lenBuf = Buffer.alloc(8)
    const r1 = await fh.read(lenBuf, 0, 8, 0)
    if (!r1 || r1.bytesRead !== 8) throw new Error(`E_SAFETENSORS_HEADER: 读不到 8 字节头（${file}）`)
    const n = Number(lenBuf.readBigUInt64LE(0))
    if (!Number.isFinite(n) || n <= 0 || n > 512 * 1024 * 1024) throw new Error(`E_SAFETENSORS_HEADER: header 长度非法（${n}；${file}）`)
    const hdr = Buffer.alloc(n)
    const r2 = await fh.read(hdr, 0, n, 8)
    if (!r2 || r2.bytesRead !== n) throw new Error(`E_SAFETENSORS_HEADER: header 截断（${file}）`)
    const parsed = JSON.parse(hdr.toString('utf8'))
    const counts = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (k === '__metadata__') continue
      const raw = v && typeof v === 'object' ? v.dtype : null
      const canon = ST_TO_CANON[raw] ?? null
      counts[canon ?? `unknown:${String(raw)}`] = (counts[canon ?? `unknown:${String(raw)}`] ?? 0) + 1
    }
    return { file, counts }
  } finally { await fh.close() }
}

/**
 * 读一个**产物目录**的存储 dtype 分布（对 `*.safetensors` 逐个读头）。
 *
 * @returns {{dir:string, files:Array<{name:string,counts:object}>, floatCounts:object,
 *            quantizedCounts:object, floatTotal:number, unreadable:string[],
 *            floatDtype:string|null, singleFloatDtype:boolean}}
 *   `floatDtype` 只在"恰好一种浮点 dtype"时给出；多种/没有 ⇒ `null`（**未知 ≠ 合规**）。
 */
export async function readTensorDtypes({ dir, fs: fsImpl = fs } = {}) {
  if (!dir) throw new Error('readTensorDtypes 需要 { dir }')
  let names = []
  try { names = (await fsImpl.readdir(dir)).filter((f) => f.endsWith('.safetensors')).sort() } catch { names = [] }
  const files = []
  const unreadable = []
  const floatCounts = {}
  const quantizedCounts = {}
  for (const name of names) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const { counts } = await readSafetensorsDtypes(join(dir, name), { fs: fsImpl })
      files.push({ name, counts })
      for (const [d, c] of Object.entries(counts)) {
        // 头里的记号已归一化过（ST_TO_CANON）。
        // ⚠️ 判"未量化浮点"必须用**显式集合**，不能用 `startsWith('float')` ——
        //    `float8_e4m3fn` 也以 float 开头，但它是**量化**权重（本机实测 168 张），
        //    误判会把每个产物的浮点 dtype 种类数算成 2，从而把全部产物判成"未知"。
        const isFloat = FLOAT_DTYPES.has(d)
        const bucket = isFloat ? floatCounts : quantizedCounts
        bucket[d] = (bucket[d] ?? 0) + c
      }
    } catch (e) { unreadable.push(`${name}:${String(e?.message ?? e).slice(0, 80)}`) }
  }
  const floatKeys = Object.keys(floatCounts)
  return {
    dir, files, floatCounts, quantizedCounts,
    floatTotal: floatKeys.reduce((a, k) => a + floatCounts[k], 0),
    unreadable,
    floatDtype: floatKeys.length === 1 ? floatKeys[0] : null,
    singleFloatDtype: floatKeys.length === 1,
  }
}

/**
 * **产物级断言**（fail-closed）：评估产物的未量化张量必须全部是策略 dtype。
 *
 * 与 `assertArtifactChanged` 同一族纪律："只断言过程抓不到空操作，必须断言权重"。
 * 这里断言的是**权重文件的存储 dtype** —— 从产物读出来的，不是从流程报告里抄的。
 *
 * @throws `E_PRODUCT_DTYPE_UNKNOWN`（读不到 / 没有浮点张量 / 浮点 dtype 不唯一）
 * @throws `E_PRODUCT_DTYPE_VIOLATION`（读到了明确的、非策略的 dtype）
 */
export function assertProductDtype({ dtypes, expected = DTYPE_POLICY.evaluationProduct, what = '评估产物' } = {}) {
  const exp = normalizeDtype(expected)
  if (!exp) throw new Error(`E_PRODUCT_DTYPE_UNKNOWN: 策略 dtype 本身非法（${expected}）`)
  if (!dtypes || dtypes.floatTotal === 0 || dtypes.singleFloatDtype !== true) {
    const err = new Error(`E_PRODUCT_DTYPE_UNKNOWN: ${what} 的存储 dtype 读不出来`
      + `（浮点张量数=${dtypes?.floatTotal ?? 0}，浮点 dtype 种类=${JSON.stringify(dtypes?.floatCounts ?? null)}，`
      + `不可读文件=${JSON.stringify(dtypes?.unreadable ?? null)}）—— "未知 ≠ 合规"，按不通过处理`)
    err.code = 'E_PRODUCT_DTYPE_UNKNOWN'
    err.details = { what, dir: dtypes?.dir ?? null, floatCounts: dtypes?.floatCounts ?? null, unreadable: dtypes?.unreadable ?? null }
    throw err
  }
  const observed = dtypes.floatDtype
  if (observed !== exp) {
    const err = new Error(`E_PRODUCT_DTYPE_VIOLATION: ${what} 的未量化张量存成 **${observed}**，策略要求 **${exp}**`
      + `（${DTYPE_POLICY.why}）。补救：用 ${exp} 重新导出产物后**重新测量** —— 不得改写历史产物，也不得在跨 dtype 上比较`)
    err.code = 'E_PRODUCT_DTYPE_VIOLATION'
    err.details = { what, dir: dtypes.dir, observed, expected: exp, floatCounts: dtypes.floatCounts, policy: DTYPE_POLICY.evaluationProduct }
    throw err
  }
  return { ok: true, dtype: exp, floatTotal: dtypes.floatTotal, files: dtypes.files.map((f) => f.name), dir: dtypes.dir }
}

/**
 * **跨 dtype 比较的显式规则**（fail-closed）。
 *
 * 规则（一句话）：**只比同 dtype 的产物**。
 *   基线 dtype ≠ 候选 dtype ⇒ **拒绝**（`E_DTYPE_COMPARISON_REFUSED`），
 *   无论调用方多想比 —— 沉默地比会把 0.40pp 的 dtype 效应混进 Δ，而产物上看不出来。
 *
 * 显式转换通道：调用方**先把候选产物转成基线的 dtype**（产物自己的存储因此变成 `to`），
 * 再用 `conversion: { from, to, declaredBy, reason }` **声明**这次转换。判据是
 * **声明必须与产物对得上**：`to` 必须等于实测 dtype（否则"转换没真的发生"⇒
 * `E_DTYPE_CONVERSION_UNVERIFIED`），`from` 必须不等于实测 dtype（否则原文与现状矛盾）。
 * 转换本身**不由本函数执行**：本函数只判"能不能比、按什么比"。
 *
 * @returns {{comparable:true, on:'same-dtype'|'declared-conversion', judgedOn:string,
 *            base:string, candidate:string, conversion:object|null}}
 */
export function assertComparableDtype({ baseline, candidate, conversion = null } = {}) {
  const b = normalizeDtype(baseline?.dtype)
  const c = normalizeDtype(candidate?.dtype)
  if (!b || !c) {
    const err = new Error(`E_PRODUCT_DTYPE_UNKNOWN: 跨 dtype 比较前两边的 dtype 都必须是**已知**的`
      + `（base=${baseline?.dtype ?? null}@${baseline?.ref ?? '?'}、candidate=${candidate?.dtype ?? null}@${candidate?.ref ?? '?'}）—— "未知 ≠ 可比"`)
    err.code = 'E_PRODUCT_DTYPE_UNKNOWN'
    err.details = { base: baseline ?? null, candidate: candidate ?? null }
    throw err
  }
  if (b !== c) {
    const err = new Error(`E_DTYPE_COMPARISON_REFUSED: 基线存成 **${b}**、候选存成 **${c}** —— **跨 dtype 不得比较**`
      + `（实测：仅把 dtype F32→BF16 就使 serving 测得的 dropPct 从 1.7205% 变成 1.3212%，0.40pp）。`
      + `补救：先把候选的未量化张量转成 **${b}**（= 基线的 dtype）并重新测量，`
      + `再用 conversion:{from:'${c}',to:'${b}',declaredBy,reason} 显式声明这次转换。`)
    err.code = 'E_DTYPE_COMPARISON_REFUSED'
    err.details = { base: { ref: baseline?.ref ?? null, dtype: b }, candidate: { ref: candidate?.ref ?? null, dtype: c }, measuredEffectPp: 0.40 }
    throw err
  }
  if (conversion !== null && conversion !== undefined) {
    const from = normalizeDtype(conversion?.from)
    const to = normalizeDtype(conversion?.to)
    const declaredBy = typeof conversion?.declaredBy === 'string' && conversion.declaredBy !== '' ? conversion.declaredBy : null
    const reason = typeof conversion?.reason === 'string' && conversion.reason !== '' ? conversion.reason : null
    if (!from || !to || from === to || !declaredBy || !reason) {
      const err = new Error('E_DTYPE_CONVERSION_INVALID: conversion 必须是 {from,to,declaredBy,reason} 且 from≠to、两者都是可识别的 dtype'
        + `（实得 ${JSON.stringify({ from: conversion?.from ?? null, to: conversion?.to ?? null, declaredBy, reason }) }）`)
      err.code = 'E_DTYPE_CONVERSION_INVALID'
      err.details = { conversion: conversion ?? null }
      throw err
    }
    if (to !== c) {
      const err = new Error(`E_DTYPE_CONVERSION_UNVERIFIED: 声明"已转成 ${to}"，但产物实测是 **${c}** —— 声明与产物不符（转换没有真的发生）`)
      err.code = 'E_DTYPE_CONVERSION_UNVERIFIED'
      err.details = { declared: to, measured: c }
      throw err
    }
    if (from === c) {
      const err = new Error(`E_DTYPE_CONVERSION_UNVERIFIED: 声明"从 ${from} 转来"，但产物实测仍是 **${c}** —— 原文与现状矛盾`)
      err.code = 'E_DTYPE_CONVERSION_UNVERIFIED'
      err.details = { declaredFrom: from, measured: c }
      throw err
    }
    return { comparable: true, on: 'declared-conversion', judgedOn: b, base: b, candidate: c, conversion: { from, to, declaredBy, reason } }
  }
  return { comparable: true, on: 'same-dtype', judgedOn: b, base: b, candidate: c, conversion: null }
}

/* ------------------------------------------------------- checkpoint 生命周期 */

const CP_SCHEMA = 'ai-infra/checkpoint@1'
const CP_META = 'meta.json'
const CP_PAYLOAD = 'payload.json'

async function mkdirp(d) { await fs.mkdir(d, { recursive: true, mode: 0o700 }); return d }

/**
 * 保存 checkpoint（v0 形态：一个目录 = meta.json + payload.json）。
 * `meta.payloadHash` 是 payload 的**内容哈希** —— 加载时必须复核，
 * 否则"往返一致"只是一句没有判据的承诺。
 */
export async function saveCheckpoint({ dir, name, payload, meta = {} } = {}) {
  if (!dir || !name) throw new Error('saveCheckpoint 需要 { dir, name }')
  const cpDir = join(dir, name)
  await mkdirp(cpDir)
  // 注意：canonicalJson 返回的是**字符串**，必须用 canonicalize（对象）再 stringify，
  // 否则 payload.json 里存的会是一个被转义的 JSON 串。这是 v0 契约测试第一次跑就抓到的缺陷。
  const payloadText = `${JSON.stringify(canonicalize(payload ?? null), null, 2)}\n`
  await fs.writeFile(join(cpDir, CP_PAYLOAD), payloadText, { mode: 0o600 })
  const payloadHash = stateHash(payload ?? null)
  const metaObj = { schema: CP_SCHEMA, name, createdAt: new Date().toISOString(), payloadHash, ...meta }
  await fs.writeFile(join(cpDir, CP_META), `${JSON.stringify(metaObj, null, 2)}\n`, { mode: 0o600 })
  return { dir: cpDir, name, hash: payloadHash, meta: metaObj }
}

/** 加载 checkpoint 并**复核内容哈希**：不一致即抛（往返不一致是缺陷，不是警告）。 */
export async function loadCheckpoint({ dir, name } = {}) {
  const cpDir = join(dir, name)
  const text = await fs.readFile(join(cpDir, CP_PAYLOAD), 'utf8')
  const meta = JSON.parse(await fs.readFile(join(cpDir, CP_META), 'utf8'))
  const payload = JSON.parse(text)
  const actual = stateHash(payload)
  if (meta.payloadHash !== actual) {
    const err = new Error(`checkpoint 内容与 meta 不符：meta=${meta.payloadHash} 实际=${actual}`)
    err.code = 'E_CHECKPOINT_CORRUPT'
    err.remediation = '该 checkpoint 已在磁盘上被改动或写入被截断 —— 不要用它继续训练；从上一个完整 checkpoint 或原始权重重启'
    throw err
  }
  return { payload, meta, hash: actual }
}

export async function listCheckpoints({ dir } = {}) {
  let names = []
  try { names = await fs.readdir(dir) } catch (err) { if (err && err.code === 'ENOENT') return []; throw err }
  const out = []
  for (const n of names.sort()) {
    try {
      const meta = JSON.parse(await fs.readFile(join(dir, n, CP_META), 'utf8'))
      out.push({ name: n, hash: meta.payloadHash, step: meta.step ?? null, createdAt: meta.createdAt ?? null, meta })
    } catch { /* 不是 checkpoint 目录：跳过 */ }
  }
  return out
}

export async function removeCheckpoint(dir, name) {
  await fs.rm(join(dir, name), { recursive: true, force: true })
}

/* --------------------------------------------------------------- 审计钩子 */

/**
 * 审计钩子工厂 —— 把"每次 run 的起止与停止原因"写进哈希链。
 * `append` 由调用方注入（通常是 `@xiciyang/audit-core` 的 `appendAudit`），
 * 这样本库**不依赖** audit-core（保持零依赖），但也不自己重写一遍链算法。
 */
export function createAuditHook({ append, root, pkg = 'training', pkgVersion = '0.0.0', now = () => new Date() }) {
  if (typeof append !== 'function') throw new Error('createAuditHook 需要注入 append（来自 @xiciyang/audit-core）')
  return {
    async beforeStep({ state, batch }) {
      if (state.step === 0) await append({ root, pkg, pkgVersion, entry: { capability: state.plugin, action: 'train', phase: 'begin', algorithm: state.algorithm, batchSize: Array.isArray(batch) ? batch.length : (batch?.size ?? null) }, date: now() })
    },
    async afterStep({ state, out }) {
      // 只记**摘要**：loss 与步号；不记样本内容（明文纪律）
      if (state.step % 50 === 0) await append({ root, pkg, pkgVersion, entry: { capability: state.plugin, action: 'train', phase: 'progress', step: state.step, loss: Number.isFinite(out?.loss) ? Number(out.loss.toFixed(6)) : null }, date: now() })
    },
    async onStop({ state, stop }) {
      await append({ root, pkg, pkgVersion, entry: { capability: state.plugin, action: 'train', phase: 'end', step: state.step, epoch: state.epoch, wallMs: state.wallMs, gpuHours: state.gpuHours, stopReason: state.stopReason, stopChecks: stop?.checks ?? [] }, date: now() })
    },
  }
}
