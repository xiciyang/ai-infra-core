/**
 * training-core 契约测试 —— **零 GPU、零框架、零网络**，这正是 v0 的 mock 策略要证明的事：
 * 用一个纯 JS 的 mock 插件就能把循环、资源上限、checkpoint、审计钩子全部跑通。
 *
 * 如果哪天有人往 training-core 里塞进 `import torch`，这个测试会立刻跑不起来 ——
 * 那就是"mock 策略被破坏"的最早信号。
 */
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  CONTRACT_VERSION, BUDGET_DEFAULTS, LIMIT_KEYS, assertTrainingPlugin, enforceLimits,
  createTrainingLoop, createMonolithicLoop, pluginMode, fingerprintArtifacts, assertArtifactChanged,
  saveCheckpoint, loadCheckpoint, listCheckpoints, createAuditHook, stateHash,
  instrumentFromDeployReport, assertInstrumentUsable,
  DTYPE_POLICY, normalizeDtype, readSafetensorsDtypes, readTensorDtypes, assertProductDtype, assertComparableDtype,
} from '../src/index.mjs'
import { appendAudit, verifyChain } from '../../audit-core/src/index.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

export const NAME = 'training-core 契约（v0 冻结面 + mock 策略）'

/**
 * 造一个**最小的 safetensors 文件**：8 字节小端头长 + JSON header（+ 空数据段）。
 * 本库只读**文件头**里的 dtype，所以合成头足以测判据 —— 零 GPU、零框架、零真实权重。
 */
function fakeSafetensors(file, dtypeCounts) {
  const header = {}
  const meta = {}
  let i = 0
  for (const [dtype, count] of Object.entries(dtypeCounts)) {
    for (let k = 0; k < count; k += 1) {
      header[`t${i}`] = { dtype, shape: [1], data_offsets: [0, 0] }
      i += 1
    }
  }
  const buf = Buffer.from(JSON.stringify({ __metadata__: meta, ...header }), 'utf8')
  const len = Buffer.alloc(8)
  len.writeBigUInt64LE(BigInt(buf.length))
  writeFileSync(file, Buffer.concat([len, buf]))
}

/** 纯 JS mock 插件：没有任何框架对象进出 —— 这就是"不训练也能测"的证明。 */
function mockPlugin(overrides = {}) {
  let n = 0
  return {
    id: 'mock-sft',
    algorithm: 'sft',
    async prepare() { return { preparedFor: 'mock' } },
    async step(batch) { n += 1; return { loss: 1 / (n + 1), metrics: { lr: 1e-4 }, ...(overrides.step ? overrides.step(n) : {}) } },
    async checkpointPayload() { return { n, weightsHash: stateHash({ n }) } },
    async finalize() { return { done: true } },
  }
}

export async function run(t) {
  // v0.4.0：加入"产物存储 dtype 策略"（**additive**：新导出；既有语义未改）
  t.assert(CONTRACT_VERSION === '0.4.0', `CONTRACT_VERSION = 0.4.0（实得 ${CONTRACT_VERSION}）`)
  t.assert(BUDGET_DEFAULTS.maxSteps === 500 && BUDGET_DEFAULTS.maxGpuHours === 2 && BUDGET_DEFAULTS.concurrency === 1,
    `预算默认值 = 长任务约束（${JSON.stringify({ steps: BUDGET_DEFAULTS.maxSteps, gpuHours: BUDGET_DEFAULTS.maxGpuHours, concurrency: BUDGET_DEFAULTS.concurrency })}）`)
  t.assert(JSON.stringify(LIMIT_KEYS) === JSON.stringify(['maxSteps', 'maxEpochs', 'maxWallMs', 'maxGpuHours']), '上限键闭集')

  // ── 接口校验（装配期 fail-closed）──
  t.assert(assertTrainingPlugin(mockPlugin()) === true, '合法插件通过校验')
  let threw = false
  try { assertTrainingPlugin({ id: 'x' }) } catch { threw = true }
  t.assert(threw, '缺 step → 抛错')
  threw = false
  try { assertTrainingPlugin({ step: () => ({}) }) } catch { threw = true }
  t.assert(threw, '缺 id → 抛错')

  // ── 上限判定（暂停不是异常，故不抛错）──
  const g = enforceLimits({ step: 500, epoch: 0, wallMs: 10, gpuHours: 0 }, {})
  t.assert(g.stop === true && g.reason === 'budget-exhausted:maxSteps', `maxSteps 命中（${g.reason}）`)
  t.assert(g.policy === 'pause-and-report', '超限策略 = 暂停并报告（**不降级**）')
  t.assert(enforceLimits({ step: 1, epoch: 0, wallMs: 1, gpuHours: 0 }, {}).stop === false, '未超限不停')

  // ── 循环：mock 插件跑通，事件流与记账正确 ──
  const events = []
  let i = 0
  const loop = createTrainingLoop({
    plugin: mockPlugin(),
    batchSource: () => (i++ < 7 ? { n: i } : null),
    limits: { maxSteps: 100 },
    onEvent: (e) => events.push(e),
  })
  const r1 = await loop.run()
  t.assert(r1.state.step === 7, `按 batchSource 跑满 7 步（实际 ${r1.state.step}）`)
  t.assert(r1.state.losses.length === 7 && r1.state.losses.every((x) => x > 0), 'loss 被记账')
  t.assert(r1.stop.reason === 'data-exhausted', `数据耗尽即停（${r1.stop.reason}）—— 无上界会在 epoch-end 上空转，这是 OOM 缺陷的回归判据`)
  t.assert(events.filter((e) => e.type === 'step').length === 7, 'step 事件逐个发出')
  t.assert(events.filter((e) => e.type === 'stop').length === 1, 'stop 事件恰好一次')
  // 多 epoch：数据耗尽后按 epochs 再跑一轮（batchSource 自行重置）
  let e2 = 0
  const twoEpoch = createTrainingLoop({
    plugin: mockPlugin(),
    batchSource: () => { e2 += 1; return (e2 % 4 === 0) ? null : { n: e2 } },
    limits: { maxSteps: 1000, maxWallMs: 1e9 },
    epochs: 3,
  })
  const r1b = await twoEpoch.run()
  t.assert(r1b.state.epoch === 3 && r1b.stop.reason === 'data-exhausted', `epochs=3 生效（epoch=${r1b.state.epoch}）`)

  // ── 循环：注入 clock 以断言"墙钟超限即暂停" ──
  let tick = 0
  let j = 0
  const clockLoop = createTrainingLoop({
    plugin: mockPlugin(),
    batchSource: () => ({ n: ++j }),
    limits: { maxSteps: 10000, maxWallMs: 1000 },
    clock: () => { tick += 400; return tick },
  })
  const r2 = await clockLoop.run()
  t.assert(r2.stop.stop === true && /maxWallMs/.test(r2.stop.reason), `墙钟超限暂停（${r2.stop.reason}）`)
  t.assert(r2.state.step < 10, `墙钟暂停时步数很少（实际 ${r2.state.step}）`)
  t.assert(r2.state.wallMs >= 1000, '停后记录 wallMs')

  // ── 循环：maxSteps 硬停 + 定期 checkpoint ──
  const tmp = mkdtempSync(join(tmpdir(), 'training-core-'))
  const cpDir = join(tmp, 'checkpoints')
  let k = 0
  const cpLoop = createTrainingLoop({
    plugin: mockPlugin(),
    batchSource: () => ({ n: ++k }),
    limits: { maxSteps: 6, maxWallMs: 1e9 },
    checkpoint: { dir: cpDir, every: 3, keep: 2 },
  })
  const r3 = await cpLoop.run()
  t.assert(r3.stop.reason === 'budget-exhausted:maxSteps', 'maxSteps 到点即停')
  t.assert(r3.checkpoints.length > 0, `产生 checkpoint（${r3.checkpoints.length} 个）`)
  const listed = await listCheckpoints({ dir: cpDir })
  t.assert(listed.length <= 2 && listed.length > 0, `keep=2 生效（实际保留 ${listed.length} 个）`)
  const loaded = await loadCheckpoint({ dir: cpDir, name: listed[0].name })
  t.assert(loaded.hash === listed[0].hash, '加载复核内容哈希一致（往返一致有判据）')
  t.assert(typeof loaded.payload.n === 'number', 'checkpoint payload 可读（自定义 checkpointPayload 生效）')

  // ── checkpoint 损坏必须被检出 ──
  const p = join(cpDir, listed[0].name, 'payload.json')
  const orig = readFileSync(p, 'utf8')
  const fsmod = await import('node:fs')
  fsmod.writeFileSync(p, orig.replace(/"n": ?\d+/, '"n": 999'))
  threw = null
  try { await loadCheckpoint({ dir: cpDir, name: listed[0].name }) } catch (e) { threw = e }
  t.assert(threw && threw.code === 'E_CHECKPOINT_CORRUPT', 'checkpoint 被改动 → E_CHECKPOINT_CORRUPT')
  t.assert(/不要用它继续训练/.test(String(threw.remediation)), '补救指引明确（该 checkpoint 不可信）')
  fsmod.writeFileSync(p, orig)

  // ── 审计钩子：真写进哈希链并可复算（且进度只记摘要）──
  const auditRoot = join(tmp, 'ai-infra')
  const date = new Date('2026-03-01T00:00:00Z')
  const hook = createAuditHook({ append: appendAudit, root: auditRoot, pkg: 'training', pkgVersion: '0.0.1', now: () => date })
  let m = 0
  const auditedLoop = createTrainingLoop({
    plugin: mockPlugin(),
    batchSource: () => (m++ < 120 ? { n: m } : null),
    limits: { maxSteps: 1000, maxWallMs: 1e9 },
    hooks: hook,
  })
  await auditedLoop.run()
  const v = await verifyChain({ root: auditRoot, pkg: 'training', date })
  t.assert(v.ok === true, `审计链可复算（checked=${v.checked}）`)
  t.assert(v.checked === 4, `begin + 2 次进度(50/100) + end = 4 条（实际 ${v.checked}）`)
  const raw = readFileSync(join(auditRoot, 'logs', 'audit', 'training', '2026-03-01.jsonl'), 'utf8')
  t.assert(raw.includes('"phase":"begin"') && raw.includes('"phase":"end"'), '起止都留痕')
  t.assert(!raw.includes('"n":') && !/"batch"/.test(raw), '审计不含样本内容（只记摘要）')
  rmSync(tmp, { recursive: true, force: true })

  // ── 边界声明：v0 明确不做的事，必须能从导出面看出来 ──
  const mod = await import('../src/index.mjs')
  t.assert(!Object.keys(mod).some((k) => /distributed|ddp|fsdp|deepspeed/i.test(k)), '导出面没有任何分布式训练入口（v0 明确不含）')
  t.assert(!Object.keys(mod).some((k) => /sft|rlhf|dpo|qat/i.test(k)), '导出面没有任何具体算法实现（算法归各 training-*-plugin）')
  // ── 依赖声明（题目「约束 7」）：零运行时必需依赖 + 训练框架只作**可选依赖组**显式声明 ──
  // 这是一条**真的会红**的判据，不是声明。原实现写的是
  //   `t.assert(existsSync(process.cwd()+'/training-core/package.json') || true, …)`
  // —— `|| true` 使其恒真，且路径基于 cwd 基本不存在：该断言永远通过，
  // 却宣称验证了可选依赖组，等于把「约束 7」交给一条空检查看守。
  const pkgPath = join(HERE, '..', 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const REQUIRED_OPT = ['torch', 'transformers', 'peft', 'trl', 'accelerate']
  // 训练框架必须是**可选**的，但「可选」有两种合法写法：
  //   ① optionalDependencies：npm 会尝试安装（装库时可能顺带拉 torch 生态，很重）
  //   ② peerDependencies + peerDependenciesMeta.optional：声明兼容面但不自动安装（0.0.2 起采用）
  // 两者都满足「零运行时必需依赖 + 框架不进 dependencies」这条约束；判据必须同时认。
  const optionalNeeded = (p) => {
    const opt = Object.keys(p.optionalDependencies || {})
    const peer = Object.keys(p.peerDependencies || {})
    const meta = p.peerDependenciesMeta || {}
    const optionalPeer = peer.filter((k) => meta[k] && meta[k].optional === true)
    return REQUIRED_OPT.every((k) => opt.includes(k) || optionalPeer.includes(k))
  }
  const depsOk = (p) => optionalNeeded(p) && Object.keys(p.dependencies || {}).length === 0
  t.assert(optionalNeeded(pkg),
    `训练框架作为可选依赖组显式声明（optionalDependencies 或 optional peerDependencies；实际：optional=${Object.keys(pkg.optionalDependencies || {}).join(',') || '（无）'} / peer=${Object.keys(pkg.peerDependencies || {}).join(',') || '（无）'}）`)
  t.assert(Object.keys(pkg.dependencies || {}).length === 0,
    `零运行时必需依赖 —— 训练框架不得进 dependencies（实际：${Object.keys(pkg.dependencies || {}).join(', ') || '（空）'}）`)
  // 已知阳性对照：**证明这条判据不是恒真**。两种真实劣化各喂一次，判据必须报 false。
  t.assert(depsOk({ ...pkg, optionalDependencies: { torch: '>=2' }, peerDependencies: {}, peerDependenciesMeta: {} }) === false,
    '对照：可选依赖组缺项 → 判据必须为 false（证明判据会红）')
  t.assert(depsOk({ ...pkg, dependencies: { torch: '>=2' } }) === false,
    '对照：框架混入 dependencies → 判据必须为 false')

  /* ══════════════ v0.2.0：单体档位（major 变更，长任务 4 预授权） ══════════════ */

  t.assert(pluginMode({ id: 'a', step() {} }) === 'stepwise', '档位判定：有 step ⇒ stepwise')
  t.assert(pluginMode({ id: 'a', monolithic: true, run() {} }) === 'monolithic', '档位判定：monolithic:true + run ⇒ monolithic')
  t.assert(pluginMode({ id: 'a', monolithic: true }) === null, '档位判定：声明 monolithic 但没有 run ⇒ 未知（fail-closed）')

  // 装配期 fail-closed：四种非法形状各喂一次
  const rejects = []
  for (const bad of [
    { id: 'x' },                                         // 两档都不满足
    { id: 'x', monolithic: true },                       // 缺 run
    { id: 'x', monolithic: true, run() {}, step() {} },  // 两档同时声明（禁止静默漂移）
    { id: 'x', monolithic: true, run() {}, onEval: 1 },  // onEval 非函数
  ]) { try { assertTrainingPlugin(bad); rejects.push(false) } catch { rejects.push(true) } }
  t.assert(rejects.every(Boolean), `四种非法插件形状全部在装配期被拒（${JSON.stringify(rejects)}）`)
  t.assert(assertTrainingPlugin({ id: 'ok', monolithic: true, run() {} }) === true, '合法单体插件装配期通过')

  const dir = mkdtempSync(join(tmpdir(), 'tc-mono-'))
  try {
    const seen = { step: 0, eval: 0, checkpoint: 0, budget: 0, stop: 0 }
    const plugin = {
      id: 'mock-monolithic',
      algorithm: 'rl',
      monolithic: true,
      async run(ctx) {
        for (let i = 0; i < 12; i += 1) {
          // eslint-disable-next-line no-await-in-loop
          const gate = await ctx.onStep({ loss: 1 / (i + 1), epoch: 0 })
          // eslint-disable-next-line no-await-in-loop
          if (i === 3) await ctx.onEval({ step: i, split: 'val', metric: 'meanNll', value: 3.1, selectionOnly: true })
          if (gate.stop) break
        }
        return { gpuHours: 0.01 }
      },
    }
    const loop = createMonolithicLoop({
      plugin, limits: { maxSteps: 10 },
      checkpoint: { dir, every: 5, keep: 1 },
      hooks: {
        onStep: () => { seen.step += 1 },
        onEval: () => { seen.eval += 1 },
        onCheckpoint: () => { seen.checkpoint += 1 },
        onBudgetExceeded: () => { seen.budget += 1 },
        onStop: () => { seen.stop += 1 },
      },
    })
    const r = await loop.run()
    t.assert(r.state.step === 10, `限额在单体档位内生效：步数停在上限 10（实得 ${r.state.step}）`)
    t.assert(seen.step === 10 && seen.eval === 1 && seen.budget === 1 && seen.checkpoint >= 1 && seen.stop === 1,
      `等价钩子都被触发（${JSON.stringify(seen)}）`)
    t.assert(r.state.stopReason === 'budget-exhausted:maxSteps', `停止原因正确（${r.state.stopReason}）`)
    t.assert(r.evaluations.length === 1 && r.evaluations[0].selectionOnly === true,
      'onEval 记录到 evaluations 且 selectionOnly 被保留（选点信号 ≠ 判定）')
    // checkpoint 必须能被**同一套** checkpoint-contract 校验并 load 回来
    const cps = await listCheckpoints({ dir })
    t.assert(cps.length >= 1, `单体档位产出了 checkpoint（${cps.length} 个）`)
    // keep:1 ⇒ 只有最后一个存档留下；断言"读回的 step 与存档名一致"（不写死 5，避免与轮转策略耦合）
    const last = cps[cps.length - 1]
    const loaded = await loadCheckpoint({ dir, name: last.name })
    t.assert(loaded?.payload?.step === Number(last.name.replace('step-', '')),
      `checkpoint 可被 loadCheckpoint 校验并读回（${last.name} → payload.step=${loaded?.payload?.step}）`)
    t.assert(typeof loaded?.meta?.payloadHash === 'string', 'checkpoint meta 带 payloadHash（内容哈希，往返可校验）')

    // ── **本档位的核心纪律**：插件不守限额时，事后核对必须抓到（阳性对照） ──
    const rogue = {
      id: 'rogue', monolithic: true,
      async run(ctx) { for (let i = 0; i < 25; i += 1) await ctx.onStep({ loss: 1 }) },
    }
    const rr = await createMonolithicLoop({ plugin: rogue, limits: { maxSteps: 10 } }).run()
    t.assert(rr.violations.length > 0 && rr.state.budgetViolation === true,
      `阳性对照：插件无视 stop 继续跑 ⇒ 事后核对记为越限（violations=${JSON.stringify(rr.violations.map((v) => v.limit))}）`)
    t.assert(rr.state.step === 25, `越限时 core 仍如实记账实际步数（${rr.state.step}），不粉饰`)

    // 空操作对照：一步都不跑也必须是违规
    const idle = { id: 'idle', monolithic: true, async run() { return {} } }
    const ir = await createMonolithicLoop({ plugin: idle, limits: {} }).run()
    t.assert(ir.violations.some((v) => v.limit === 'no-steps'), '空操作（0 步）被判为违规 —— 不允许"什么都没做"当成功')

    // ── 产物级断言：只断言过程抓不到空操作，必须断言权重 ──
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const wdir = join(dir, 'weights')
    mkdirSync(wdir, { recursive: true })
    writeFileSync(join(wdir, 'model.safetensors'), 'AAAA')
    const before = await fingerprintArtifacts(wdir)
    t.assert(typeof before.hash === 'string' && before.hash.startsWith('sha256:'), `权重指纹可计算（${String(before.hash).slice(0, 20)}…）`)
    let noopErr = null
    try { assertArtifactChanged({ before, after: await fingerprintArtifacts(wdir) }) } catch (e) { noopErr = e }
    t.assert(/E_NO_OP_TRAINING/.test(String(noopErr?.message)), '权重逐位不变 ⇒ 抛 E_NO_OP_TRAINING（空操作不得记为成功）')
    writeFileSync(join(wdir, 'model.safetensors'), 'BBBB')
    const after = await fingerprintArtifacts(wdir)
    const okc = assertArtifactChanged({ before, after })
    t.assert(okc.ok === true && okc.before !== okc.after, '权重变了 ⇒ 断言通过，且前后指纹不同')
    let missingErr = null
    try { assertArtifactChanged({ before: null, after }) } catch (e) { missingErr = e }
    t.assert(/E_ARTIFACT_FINGERPRINT_MISSING/.test(String(missingErr?.message)), '"无法断言"按不通过处理（缺指纹 ≠ 没问题）')
    writeFileSync(join(wdir, 'trainer.log'), 'noise')
    t.assert((await fingerprintArtifacts(wdir)).hash === after.hash, '非权重文件（日志）不改变权重指纹')
  } finally { rmSync(dir, { recursive: true, force: true }) }

  /* ═══════ v0.3.0：测量仪器来源（instrument provenance）═══════ */
  // 背景（真缺陷）：eval-result@1 只写判决、不写"用什么仪器测的"。一次 RL 测量里某次部署
  // 落进 serving 的**有损**降级档位 precision（dtype=half + quantization=fp8），同一份权重
  // 于是测出 25/48 而不是 23/48 —— 判决翻转，而产物里没有任何字段说明模型被量化过。
  // 下面这三段是"记录"与"拒绝"两件事各自的判据。

  // ① 有损 deploy-report（形状照 inference-serving/src/deploy.mjs 的 buildReport 逐字段构造）
  const lossyReport = {
    schema: 'inference-serving/deploy-report@1',
    outcome: 'success',
    reused: false,
    endpoint: { url: 'http://127.0.0.1:8901', port: 8901, bindHost: '127.0.0.1', servedModelName: 'rl-tr_x' },
    requestedConfig: { dtype: 'auto', quantization: null, gpuMemoryUtilization: 0.18, maxModelLen: 8192 },
    finalConfig: { dtype: 'half', quantization: 'fp8', gpuMemoryUtilization: 0.18, maxModelLen: 2048 },
    degradedFrom: 'baseline',
    degrade: {
      steps: 3,
      lossy: true,
      lossyWarning: '本次部署使用了有损降级档位（精度），输出质量可能受影响',
      history: [
        { at: '2026-09-29T00:00:00.000Z', tier: 'memory-quota', lossy: false, describe: '降 gpu-memory-utilization' },
        { at: '2026-09-29T00:00:01.000Z', tier: 'parallelism', lossy: false, describe: '降并发' },
        { at: '2026-09-29T00:00:02.000Z', tier: 'precision', lossy: true, describe: 'dtype=half + quantization=fp8' },
      ],
    },
  }
  const li = instrumentFromDeployReport(lossyReport)
  t.assert(li?.lossy === true, `有损报告 ⇒ lossy=true（实得 ${li?.lossy}）`)
  t.assert(JSON.stringify(li?.degrade?.tiers) === JSON.stringify(['memory-quota', 'parallelism', 'precision']),
    `降级档位 id 按 history 顺序完整捕获（实得 ${JSON.stringify(li?.degrade?.tiers)}）`)
  t.assert(li?.effectiveConfig?.dtype === 'half' && li?.effectiveConfig?.quantization === 'fp8',
    '记录的是**真正部署**的那份配置（finalConfig，不是 requestedConfig）')
  t.assert(li?.requestedConfig?.dtype === 'auto' && li?.endpoint?.servedModelName === 'rl-tr_x' && li?.degrade?.steps === 3,
    'code: 请求配置 / 端点 / 步数一并留下（可复核"哪两个不同的仪器"）')

  // ② 无损（基线档位）报告 ⇒ lossy=false，档位表为空
  const lossless = instrumentFromDeployReport({ ...lossyReport, finalConfig: { dtype: 'bfloat16', quantization: null }, degradedFrom: 'baseline', degrade: { steps: 0, lossy: false, lossyWarning: null, history: [] } })
  t.assert(lossless?.lossy === false && lossless?.degrade?.tiers.length === 0, '无损报告 ⇒ lossy=false 且 tiers=[]')

  // ③ fail-closed 的**下界**：`degrade.lossy` 漏写但 history 里有 lossy 条目 ⇒ 仍判有损
  const partial = instrumentFromDeployReport({ schema: 'inference-serving/deploy-report@1', degrade: { history: [{ tier: 'precision', lossy: true }] } })
  t.assert(partial?.lossy === true, '两个来源只要有一个说有损就是有损（不因上游少写一个布尔而放行）')

  // ④ 缺报告 / 形状不对 ⇒ null，且**不抛错**（"没有记录"必须可表达，不能逼调用方编一个）
  let shapeThrew = false
  let missAll = null
  try { missAll = [undefined, null, {}, [], 'x', 42].map((x) => instrumentFromDeployReport(x)) } catch { shapeThrew = true }
  t.assert(shapeThrew === false && missAll.every((x) => x === null), `缺报告 / 非报告形状 ⇒ 全 null 且不抛错（实得 ${JSON.stringify(missAll)}）`)

  // ⑤ 不得嵌入活对象：函数 / 循环引用 / 超深嵌套都只能变成丢弃或 null，绝不进记录
  const live = { schema: 'inference-serving/deploy-report@1', finalConfig: { cb: () => {}, nested: { deep: { deeper: { deepest: { tooDeep: 1 } } } } }, endpoint: {} }
  live.self = live // 循环引用：朴素深拷贝会在这里爆栈
  let liveErr = null
  let liveRec = null
  try { liveRec = instrumentFromDeployReport(live) } catch (e) { liveErr = e }
  t.assert(liveErr === null, `含函数与循环引用的入参不抛错（实得 ${String(liveErr?.message ?? '')}）`)
  t.assert(liveRec?.effectiveConfig?.cb === undefined && JSON.stringify(liveRec).length < 2000,
    `活对象被丢弃而非被序列化（记录长度 ${JSON.stringify(liveRec).length} 字节）`)

  // ⑥ 判据本身：有损 ⇒ 抛 E_INSTRUMENT_LOSSY，且带可执行补救与档位
  let lossyErr = null
  try { assertInstrumentUsable(li, { runId: 'tr_x' }) } catch (e) { lossyErr = e }
  t.assert(lossyErr?.code === 'E_INSTRUMENT_LOSSY', `有损仪器 ⇒ 抛 E_INSTRUMENT_LOSSY（实得 ${lossyErr?.code}）`)
  t.assert(/precision/.test(String(lossyErr?.message)) && /maxModelLen/.test(String(lossyErr?.message)) && /tr_x/.test(String(lossyErr?.message)),
    '错误信息含：档位 id + 可执行补救（maxModelLen/gpuMemoryUtilization）+ runId')
  t.assert(Array.isArray(lossyErr?.details?.tiers) && lossyErr.details.tiers.includes('precision'), 'details.tiers 可被调用方程序化消费')

  // ⑦ 判据的**不抛**一侧：无损与"没有记录"都放行（只拒绝**已知有损**）
  let passErr = null
  let passRes = null
  try { passRes = [assertInstrumentUsable(lossless), assertInstrumentUsable(null), assertInstrumentUsable(undefined)] } catch (e) { passErr = e }
  t.assert(passErr === null && passRes.every((r) => r.ok === true && r.lossy === false),
    `无损 / 缺失记录不抛错（"不知道" ≠ "有损"；缺记录由产物里的 instrument:null 显式承载）`)

  // ═══════════ v0.4.0：产物存储 dtype 策略（缺陷 16） ═══════════
  // 判据落在**产物**上（"只断言过程抓不到空操作，必须断言权重"）：合成 safetensors 头，
  // 让读头 → 判据 → 拒绝/放行 这三步真的跑一遍。
  t.assert(DTYPE_POLICY.evaluationProduct === 'bfloat16', `策略 dtype = bfloat16（实得 ${DTYPE_POLICY.evaluationProduct}）`)
  t.assert(normalizeDtype('F32') === 'float32' && normalizeDtype('torch.bfloat16') === 'bfloat16' && normalizeDtype('BF16') === 'bfloat16',
    'dtype 归一化认得出 safetensors / torch / 短名三种写法')
  t.assert(normalizeDtype('frobnicate') === null && normalizeDtype(undefined) === null, '认不出的 dtype ⇒ null（不猜、不默认）')

  const dtypeRoot = mkdtempSync(join(tmpdir(), 'tc-dtype-'))
  try {
    const mk = (sub, counts) => { mkdirSync(join(dtypeRoot, sub), { recursive: true }); fakeSafetensors(join(dtypeRoot, sub, 'model.safetensors'), counts) }
    mk('bf16', { BF16: 5 })
    mk('f32', { F32: 5 })
    mk('bf16-fp8', { BF16: 290, F8_E4M3: 168 })   // PTQ 的形状
    mk('mixed-float', { BF16: 2, F32: 3 })        // 浮点 dtype 不唯一 ⇒ 未知
    mk('all-quant', { F8_E4M3: 4 })               // 没有未量化浮点 ⇒ 未知
    mk('empty', {})

    const d = {}
    for (const k of ['bf16', 'f32', 'bf16-fp8', 'mixed-float', 'all-quant', 'empty']) d[k] = await readTensorDtypes({ dir: join(dtypeRoot, k) })
    t.assert(d.bf16.floatDtype === 'bfloat16' && d.bf16.floatTotal === 5, `读头：BF16×5 ⇒ floatDtype=bfloat16（实得 ${d.bf16.floatDtype}/${d.bf16.floatTotal}）`)
    // ⚠️ 这条是**回归**：`float8_e4m3fn` 也以 "float" 开头，若按前缀判"未量化浮点"，
    //    这里会得到 2 种浮点 dtype ⇒ 每个产物都被误判成"未知"。
    t.assert(d['bf16-fp8'].floatDtype === 'bfloat16' && d['bf16-fp8'].quantizedCounts.float8_e4m3fn === 168,
      `F8_E4M3 归入**量化**张量而不是未量化浮点（实得 float=${JSON.stringify(d['bf16-fp8'].floatCounts)} quant=${JSON.stringify(d['bf16-fp8'].quantizedCounts)}）`)

    const why = (fn) => { try { fn(); return null } catch (e) { return e } }
    t.assert(why(() => assertProductDtype({ dtypes: d.bf16 })) === null, 'BF16 产物 ⇒ 断言通过')
    t.assert(why(() => assertProductDtype({ dtypes: d['bf16-fp8'] })) === null, 'BF16+F8 产物 ⇒ 断言通过（量化张量不参与 dtype 策略）')
    t.assert(why(() => assertProductDtype({ dtypes: d.f32 }))?.code === 'E_PRODUCT_DTYPE_VIOLATION',
      `F32 产物 ⇒ E_PRODUCT_DTYPE_VIOLATION（实得 ${why(() => assertProductDtype({ dtypes: d.f32 }))?.code}）`)
    t.assert(why(() => assertProductDtype({ dtypes: d['mixed-float'] }))?.code === 'E_PRODUCT_DTYPE_UNKNOWN', '浮点 dtype 不唯一 ⇒ 未知 ⇒ 不通过（未知 ≠ 合规）')
    t.assert(why(() => assertProductDtype({ dtypes: d['all-quant'] }))?.code === 'E_PRODUCT_DTYPE_UNKNOWN', '没有未量化浮点 ⇒ 未知 ⇒ 不通过')
    t.assert(why(() => assertProductDtype({ dtypes: d.empty }))?.code === 'E_PRODUCT_DTYPE_UNKNOWN', '空产物 ⇒ 未知 ⇒ 不通过')
    const missing = await readTensorDtypes({ dir: join(dtypeRoot, 'nope') })
    t.assert(why(() => assertProductDtype({ dtypes: missing }))?.code === 'E_PRODUCT_DTYPE_UNKNOWN',
      '目录不存在 ⇒ 未知 ⇒ 不通过（fail-closed，不静默放行）')

    t.assert(assertComparableDtype({ baseline: { ref: 'b', dtype: 'bfloat16' }, candidate: { ref: 'c', dtype: 'bfloat16' } }).on === 'same-dtype',
      '同 dtype ⇒ 可比（on=same-dtype）')
    const refused = why(() => assertComparableDtype({ baseline: { ref: 'b', dtype: 'bfloat16' }, candidate: { ref: 'c', dtype: 'float32' } }))
    t.assert(refused?.code === 'E_DTYPE_COMPARISON_REFUSED', `跨 dtype ⇒ 拒绝比较（实得 ${refused?.code}）`)
    t.assert(/1\.7205%/.test(String(refused?.message)) && /0\.40/.test(String(refused?.message)), '拒绝信息带上实测效应量（0.40pp / 1.7205%），便于判断代价')
    t.assert(why(() => assertComparableDtype({ baseline: { ref: 'b', dtype: null }, candidate: { ref: 'c', dtype: 'bfloat16' } }))?.code === 'E_PRODUCT_DTYPE_UNKNOWN',
      '任一侧 dtype 未知 ⇒ 拒绝（未知 ≠ 可比）')

    // 显式转换：声明必须与**产物**对得上
    const conv = assertComparableDtype({
      baseline: { ref: 'b', dtype: 'bfloat16' }, candidate: { ref: 'c', dtype: 'bfloat16' },
      conversion: { from: 'float32', to: 'bfloat16', declaredBy: 'ci', reason: 'out-of-band cast then re-measure' },
    })
    t.assert(conv.on === 'declared-conversion' && conv.conversion.from === 'float32' && conv.judgedOn === 'bfloat16',
      '显式声明的转换被记录进判定记录（judgedOn/from/to 齐全）')
    t.assert(why(() => assertComparableDtype({ baseline: { ref: 'b', dtype: 'bfloat16' }, candidate: { ref: 'c', dtype: 'bfloat16' }, conversion: { from: 'float32', to: 'float32', declaredBy: 'ci', reason: 'x' } }))?.code === 'E_DTYPE_CONVERSION_INVALID',
      '声明"转成 float32"而产物是 bfloat16 ⇒ from≠to 校验先拦（E_DTYPE_CONVERSION_INVALID）')
    t.assert(why(() => assertComparableDtype({ baseline: { ref: 'b', dtype: 'bfloat16' }, candidate: { ref: 'c', dtype: 'bfloat16' }, conversion: { from: 'float16', to: 'bfloat16', declaredBy: '', reason: 'x' } }))?.code === 'E_DTYPE_CONVERSION_INVALID',
      '声明缺 declaredBy/reason ⇒ 无效（"显式"必须有主体与理由）')

    // 读头本身：真实文件格式（8 字节长度 + JSON header）
    const one = await readSafetensorsDtypes(join(dtypeRoot, 'bf16', 'model.safetensors'))
    t.assert(one.counts.bfloat16 === 5, `readSafetensorsDtypes 按 dtype 计数（实得 ${JSON.stringify(one.counts)}）`)
  } finally { rmSync(dtypeRoot, { recursive: true, force: true }) }
}
