/**
 * evidence-core 契约测试 —— 四条硬纪律 + 追溯性 + 案例库复用，**逐条都要有反例对照**。
 * 纯函数 + 临时目录，不依赖 GPU / 容器 / 网络。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CAPABILITY_VERSION, collectFacts, verifyFacts, verifyRelations, derive, top1,
  checkTraceability, decideStop, CaseLibrary, anchorResolves, EvidenceError,
} from '../src/index.mjs'

export const NAME = 'evidence-core 契约（事实→关系→演绎→案例库 四条硬纪律）'

// 仓库自带的锚点夹具：不依赖任何本机路径，换机器照样可解析。
const HERE = dirname(fileURLToPath(import.meta.url))
const ANCHOR_FIXTURE = join(HERE, '..', 'fixtures', 'cycF-CRITERIA.md')

const HASH = (c) => `sha256:${String(c).repeat(64).slice(0, 64)}`

/** 真实形状的事实集：增益随步数上升、代价随步数上升（受控变差）。 */
const mkFacts = () => [
  { id: 'F-100', claim: '300 步时格式合规 0.470', kind: 'measurement', value: 0.470, unit: 'ratio', evidence: ['run:ts_so3y'], confidence: 0.99, confidenceBasis: 'n=500, attempted=500, failed=0', source: 'training-sft.validate', meta: { role: 'gain', steps: 300 } },
  { id: 'F-200', claim: '300 步时 wikitext NLL Δ=+0.004102', kind: 'measurement', value: 0.004102, unit: 'delta-nll', evidence: ['run:ts_so3y'], confidence: 0.99, confidenceBasis: 'n=200 配对，自身 z·SE=0.002808', source: 'training-sft.validate', meta: { role: 'cost', steps: 300 } },
  { id: 'F-300', claim: '400 步时格式合规 0.584', kind: 'measurement', value: 0.584, unit: 'ratio', evidence: ['run:ts_zlmm'], confidence: 0.99, confidenceBasis: 'n=500', source: 'training-sft.validate', meta: { role: 'gain', steps: 400 } },
  { id: 'F-400', claim: '400 步时 wikitext NLL Δ=+0.013455', kind: 'measurement', value: 0.013455, unit: 'delta-nll', evidence: ['run:ts_zlmm'], confidence: 0.99, confidenceBasis: 'n=200 配对，自身 z·SE=0.003434', source: 'training-sft.validate', meta: { role: 'cost', steps: 400 } },
  { id: 'F-500', claim: '200 步时格式合规 0.312，低于 incumbent 0.348', kind: 'measurement', value: 0.312, unit: 'ratio', evidence: ['run:ts_djja'], confidence: 0.99, confidenceBasis: 'n=500', source: 'training-sft.validate', meta: { role: 'gain', steps: 200 } },
  { id: 'F-600', claim: '200 步时 wikitext NLL Δ=-0.000851（无代价）', kind: 'measurement', value: -0.000851, unit: 'delta-nll', evidence: ['run:ts_djja'], confidence: 0.99, confidenceBasis: 'n=200 配对', source: 'training-sft.validate', meta: { role: 'cost', steps: 200 } },
  { id: 'F-700', claim: '同数据同 seed 同配方，唯一变化量是 maxSteps', kind: 'constraint', value: null, unit: null, evidence: [`file:${ANCHOR_FIXTURE}`], confidence: 0.95, confidenceBasis: '三次运行的 datasetHash / seed / lora 配置逐字相同', source: '人工核对 runs' },
  { id: 'F-800', claim: 'LoRA 秩决定适配器的自由度（可动维度数）', kind: 'definition', value: null, unit: null, evidence: ['metric:lora-rank-degrees-of-freedom'], confidence: 0.9, confidenceBasis: '低秩分解的定义：秩即线性独立方向数', source: 'definition', meta: { role: 'decoupler-candidate' } },
  { id: 'F-900', claim: '在步数轴上的任何新点都同向推动增益与代价（实测 200/300/400/500）', kind: 'refutation', value: null, unit: null, evidence: ['metric:steps-axis-monotone-both', 'run:ts_zlmm'], confidence: 0.95, confidenceBasis: '四个点全部同向；且 300/400/500 的代价均超各自噪声界', source: '证据链演绎' },
]

const mkRelations = () => [
  { id: 'R-1', type: 'causal', from: 'F-700', to: 'F-100', basis: '受控变差：唯一变化量是步数 ⇒ 差异只能归因于步数', basisKind: 'controlled-variation', evidence: [`file:${ANCHOR_FIXTURE}`] },
  { id: 'R-2', type: 'causal', from: 'F-700', to: 'F-200', basis: '同上，受控变差', basisKind: 'controlled-variation', evidence: [`file:${ANCHOR_FIXTURE}`] },
  { id: 'R-3', type: 'causal', from: 'F-800', to: 'F-500', basis: '机制：适配器自由度越多，越容易把基座分布带偏', basisKind: 'mechanism', evidence: ['metric:lora-rank-degrees-of-freedom'] },
  { id: 'R-4', type: 'excludes', from: 'F-900', to: 'F-900', basis: '实测四点在步数轴上同向推动两者 ⇒ 该轴上的新点不构成新方向', basisKind: 'statistical', evidence: ['metric:steps-axis-monotone-both'] },
]

export async function run(t) {
  const dir = mkdtempSync(join(tmpdir(), 'evidence-core-'))
  try {
    t.assert(typeof CAPABILITY_VERSION === 'string', '能力带版本号')

    /* ── ① 事实层：正例 ── */
    const c = collectFacts(mkFacts())
    t.assert(c.ok === true, `真实形状的事实集应通过（问题：${c.problems.join('; ') || '无'}）`)
    t.assert(c.facts.length === 9, `事实条数（实得 ${c.facts.length}）`)
    t.assert(verifyFacts(c.facts).ok === true, '独立复核也应通过')

    /* ── ① 事实层：反例（每条对应一种"用推断冒充事实"的形态）── */
    const noAnchor = collectFacts([{ claim: 'x', kind: 'measurement', value: 1, confidence: 0.9, confidenceBasis: 'b', source: 's' }])
    t.assert(noAnchor.ok === false && noAnchor.problems.some((p) => p.includes('缺证据锚点')), '① 无锚点 ⇒ 拒绝（没锚点的事实是主张）')

    const badAnchor = collectFacts([{ claim: 'x', kind: 'measurement', evidence: ['嘴说的'], confidence: 0.9, confidenceBasis: 'b', source: 's' }])
    t.assert(badAnchor.ok === false && badAnchor.problems.some((p) => p.includes('锚点')), '① 锚点前缀不合法 ⇒ 拒绝')

    const asInference = collectFacts([{ claim: 'x', kind: 'inference', evidence: [HASH('a')], confidence: 0.9, confidenceBasis: 'b', source: 's' }])
    t.assert(asInference.ok === false && asInference.problems.some((p) => p.includes('推断不能冒充事实')), '① kind=inference ⇒ 拒绝（**推断不得当事实**）')

    const noBasis = collectFacts([{ claim: 'x', kind: 'measurement', evidence: [HASH('a')], confidence: 0.9, source: 's' }])
    t.assert(noBasis.ok === false && noBasis.problems.some((p) => p.includes('confidenceBasis')), '① 置信度无依据 ⇒ 拒绝（否则是个装饰数字）')

    t.assert(anchorResolves(HASH('a')).ok === true && anchorResolves('sha256:short').ok === false, 'sha256 锚点长度受限')
    t.assert(anchorResolves('file:/no/such/file/xyz').ok === false, 'file: 锚点必须真实存在（fail-closed）')

    /* ── ② 关系层：正例 ── */
    const rv = verifyRelations(mkRelations(), c.facts)
    t.assert(rv.ok === true, `真实关系集应通过（问题：${rv.problems.join('; ') || '无'}）`)

    /* ── ② 关系层：反例 ── */
    const corrAsCausal = verifyRelations([{ id: 'R-bad', type: 'causal', from: 'F-100', to: 'F-200', basis: '它们一起动', basisKind: 'correlational', evidence: [HASH('a')] }], c.facts)
    t.assert(corrAsCausal.ok === false && corrAsCausal.problems.some((p) => p.includes('因果必须有对照或机制')), '② 相关冒充因果 ⇒ 拒绝')

    const noBasisRel = verifyRelations([{ id: 'R-bad2', type: 'correlational', from: 'F-100', to: 'F-200', evidence: [HASH('a')] }], c.facts)
    t.assert(noBasisRel.ok === false && noBasisRel.problems.some((p) => p.includes('缺 basis')), '② 关系无逻辑依据 ⇒ 拒绝')

    const danglingRel = verifyRelations([{ id: 'R-bad3', type: 'correlational', from: 'F-NOPE', to: 'F-200', basis: 'b', basisKind: 'statistical' }], c.facts)
    t.assert(danglingRel.ok === false, '② 关系指向不存在的事实 ⇒ 拒绝')

    const exclNotRefutation = verifyRelations([{ id: 'R-bad4', type: 'excludes', from: 'F-100', to: 'F-100', basis: 'b', basisKind: 'statistical' }], c.facts)
    t.assert(exclNotRefutation.ok === false && exclNotRefutation.problems.some((p) => p.includes("kind='refutation'")), '② excludes 指向非反驳事实 ⇒ 拒绝（排除要有反驳证据）')

    /* ── ③ 演绎：正例 + 追溯 ── */
    const d = derive({ goal: { targetMetric: 'sft.formatCompliance', direction: 'higher-is-better' }, facts: c.facts, relations: mkRelations() })
    t.assert(d.refused === false, `演绎应成功（${d.code}：${(d.problems ?? []).join('; ')}）`)
    t.assert(d.steps.length >= 1, `至少产出一条演绎步（实得 ${d.steps.length}）`)
    t.assert(d.traceability.ok === true, `追溯性检查应通过（${d.traceability.problems.join('; ') || '无'}）`)
    const t1 = top1(d)
    t.assert(t1.ok === true, '有存活方向 ⇒ top1 可用')
    t.assert(/改变\*\*耦合机制\*\*/.test(t1.direction.statement), `top1 应是"改耦合机制"那条（实得：${t1.direction.statement}）`)
    t.assert(d.directions.some((x) => x.excluded === true), '同一轴上的新点应被排除（有排除项）')
    t.assert(d.excluded.length >= 1 && d.excluded.every((x) => (x.evidence ?? []).length > 0), '**每个排除项都带证据锚点**')

    /* ── ③ 演绎：结构性反例 —— 方向不得来自手段集 ── */
    const tainted = JSON.parse(JSON.stringify(d))
    tainted.directions[0].meansId = 'steps-500'
    t.assert(checkTraceability(tainted, c.facts, mkRelations()).ok === false, '③ 产物里出现 meansId ⇒ 追溯性判**断链**（方向不得来自手段集）')

    // ③b **关系可以当前提**（前置 3 的规则会这么做）：允许；但**未知 id 仍必须断链**
    const relPremise = JSON.parse(JSON.stringify(d))
    relPremise.steps[0].from = ['F-700', 'R-1']
    t.assert(checkTraceability(relPremise, c.facts, mkRelations()).ok === true, '③b 步引用**关系**作前提 ⇒ 允许（关系也是前提）')
    const bogusPremise = JSON.parse(JSON.stringify(d))
    bogusPremise.steps[0].from = ['F-700', 'R-NOT-A-RELATION']
    t.assert(checkTraceability(bogusPremise, c.facts, mkRelations()).ok === false, '③b 引用不存在的关系 ⇒ 仍断链（放宽没有变成"什么都行"）')

    const brokenStep = JSON.parse(JSON.stringify(d))
    brokenStep.steps[0].from = ['F-NOT-A-FACT']
    const bt = checkTraceability(brokenStep, c.facts, mkRelations())
    t.assert(bt.ok === false && bt.problems.some((p) => p.includes('断链')), '③ 步挂在不存在的事实上 ⇒ 断链')

    const orphanDirection = JSON.parse(JSON.stringify(d))
    orphanDirection.directions[0].supportedBy = []
    t.assert(checkTraceability(orphanDirection, c.facts, mkRelations()).ok === false, '③ 方向无支撑步 ⇒ 拒绝（方向必须是演绎出来的）')

    const noEvidenceExclusion = JSON.parse(JSON.stringify(d))
    noEvidenceExclusion.excluded[0].evidence = []
    t.assert(checkTraceability(noEvidenceExclusion, c.facts, mkRelations()).ok === false, '③ 排除项无证据 ⇒ 拒绝')

    /* ── ③ 前提不合格 ⇒ 拒绝演绎（fail-closed） ── */
    const badPremise = derive({ goal: { targetMetric: 'm', direction: 'higher-is-better' }, facts: c.facts, relations: [{}] })
    t.assert(badPremise.refused === true && badPremise.code === 'E_PREMISE_INVALID', '前提不合格 ⇒ 拒绝演绎')

    /* ── 停止条件 ── */
    t.assert(decideStop({ directions: [], excluded: [], steps: [] }).reason === 'no-derivation-possible', '推不出步 ⇒ 证据链无法继续推演')
    t.assert(decideStop({ directions: [{ excluded: true }], excluded: [], steps: [{ id: 'D1' }] }).reason === 'all-directions-excluded', '全被排除 ⇒ 停止')

    /* ── ④ 案例库：存档 / 检索 / **复用** ── */
    const lib = new CaseLibrary(join(dir, 'cases.json'))
    lib.add({ key: 'cycG-tradeoff', facts: c.facts, relations: mkRelations(), derivation: d, outcome: { passed: false }, conclusion: 'sft.formatCompliance 在步数轴上与代价耦合', evidenceRefs: ['run:ts_so3y'] })
    t.assert(lib.cases.length === 1, '案例入库')
    t.assert(lib.stats().neverReused.length === 1, '入库未复用 ⇒ stats 点出来（让"只记录"可见）')
    const hit = lib.search({ contains: '步数轴' })
    t.assert(hit.length === 1, '按关键词检索命中')
    const reused = lib.reuse('cycG-tradeoff', { by: 'cycH-derivation', purpose: '当先验：不要再在步数轴上取点' })
    t.assert(reused.reuseCount === 1, '复用计数递增')
    t.assert(lib.stats().neverReused.length === 0, '复用后不再算"从未复用"')
    t.assert(lib.search({ factId: 'F-100' }).length === 1, '按事实 id 检索命中')

    /* 复用必须记录 by/purpose（不是静默读取） */
    let threw = false
    try { lib.reuse('cycG-tradeoff', { by: 'x' }) } catch (e) { threw = e instanceof EvidenceError && e.code === 'E_INPUT_SHAPE' }
    t.assert(threw === true, '复用缺 purpose ⇒ 拒绝')

    /* 幂等：同 key 覆盖而不是重复入库 */
    lib.add({ key: 'cycG-tradeoff', facts: c.facts, relations: mkRelations(), derivation: d, outcome: { passed: false }, conclusion: 'x' })
    t.assert(lib.cases.length === 1, '同 key 覆盖（幂等），不重复入库')

    /* ── 反向对照：不删掉任何东西也能通过？── */
    // 把"事实可验证"整条拆掉会怎样：这里用**行为对照**证明反例确实会红 ——
    // 若不检查锚点，下面这条会静默通过（它现在被拒）。
    const silentCandidate = collectFacts([{ claim: '格式合规会涨到 0.9', kind: 'measurement', value: 0.9, evidence: ['run:imagined'], confidence: 1, confidenceBasis: '我估计', source: 'assistant' }])
    t.assert(silentCandidate.ok === true, '反向对照：`run:` 前缀的非空标识**可以**通过（本库不做存在性断言）—— 故"可验证"的边界如实写在文档里')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
