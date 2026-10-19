/**
 * @ai-infra/evidence-core —— **证据链演绎能力**（事实 → 关系 → 演绎 → 案例库）。
 *
 * ## 它在链条里的位置
 * `rsi-loop` 的五个自能力回答"**怎么判**"；本库回答"**凭什么这么判**"：
 * 每一个方向都必须能顺着 **方向 → 演绎步 → 关系 → 事实 → 证据锚点** 一路走回去。
 *
 * ## 四条硬纪律（都是 fail-closed）
 * ① **事实必须可验证**：每条事实必须带**可解析的证据锚点**（`run:` / `file:` / `sha256:` / `metric:`）
 *    与**置信度依据**；`kind:'inference'` **不得**当事实用（"推断冒充事实"直接拒绝）。
 * ② **关系必须有逻辑依据**：`causal` 只认 `basisKind ∈ {controlled-variation, mechanism}`；
 *    仅相关（`correlational`）不得冒充因果。
 * ③ **演绎逐步可追溯**：每一步的 `from` 必须是**事实 id 或更早的步 id**；方向必须由步推出。
 * ④ **排除项必须有证据**：被排除的方向必须给出排除它的**事实锚点**，不许"我觉得不行"。
 *
 * ## 本库**不做什么**（结构性保证，不是口号）
 * `derive()` **没有 `means` 入参** —— 它接不到"候选手段表"，因此**在结构上无法**"从手段集里挑一个"。
 * 方向只能由事实+关系**合成**出来。这是把"方向必须由演绎产生"做成**接口约束**而不是纪律条款。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

export const CAPABILITY_VERSION = '1.0.0'
export const SCHEMA_VERSION = 'evidence-chain@1'

export const FACT_KINDS = Object.freeze(['measurement', 'observation', 'constraint', 'definition', 'refutation'])
export const RELATION_TYPES = Object.freeze(['causal', 'correlational', 'excludes', 'constrains', 'definitional'])
export const BASIS_KINDS = Object.freeze(['controlled-variation', 'mechanism', 'definitional', 'statistical', 'authority'])
export const ANCHOR_PREFIXES = Object.freeze(['run:', 'file:', 'sha256:', 'metric:', 'lineage:', 'round:', 'dataset:'])

export class EvidenceError extends Error {
  constructor(code, message, details = null) { super(message); this.name = 'EvidenceError'; this.code = code; this.details = details }
}

/* ──────────────────────────── ① 事实层 */

/** 证据锚点是否可解析：前缀合法 **且**（sha256 ⇒ 64hex；file ⇒ 文件存在）。 */
export function anchorResolves(anchor, { root = process.cwd() } = {}) {
  if (typeof anchor !== 'string' || anchor.trim() === '') return { ok: false, why: '锚点为空' }
  if (/^sha256:[0-9a-f]{64}$/.test(anchor)) return { ok: true, why: '内容哈希' }
  const pref = ANCHOR_PREFIXES.find((p) => anchor.startsWith(p) && p !== 'sha256:')
  if (!pref) return { ok: false, why: `锚点前缀不合法（需 ${ANCHOR_PREFIXES.join(' / ')}）：${anchor.slice(0, 60)}` }
  if (pref === 'file:') {
    const p = anchor.slice(5).replace(/^~/, process.env.HOME ?? '~')
    if (!existsSync(p)) return { ok: false, why: `file: 锚点指向的文件不存在：${p}` }
    return { ok: true, why: '文件存在' }
  }
  // run:/metric:/lineage:/round:/dataset: —— 必须是"非空标识"，不做存在性断言（记录在案的轮次未必在本机）
  const rest = anchor.slice(pref.length).trim()
  return rest.length > 0 ? { ok: true, why: `${pref} 标识非空` } : { ok: false, why: `${pref} 后为空` }
}

/**
 * 事实收集器：把原始记录归一化成事实，并**逐条**做可验证性机检。
 * 任何一条不合格 ⇒ `ok:false`（fail-closed），不允许"先收下再补证据"。
 */
export function collectFacts(raw, { root = null, prefix = 'F' } = {}) {
  const problems = []
  if (!Array.isArray(raw)) throw new EvidenceError('E_INPUT_SHAPE', 'collectFacts 需要数组')
  const facts = raw.map((f, i) => {
    const id = f?.id ?? `${prefix}-${String(i + 1).padStart(3, '0')}`
    const where = `[${i}] ${id}`
    if (typeof f?.claim !== 'string' || f.claim.trim() === '') problems.push(`${where}: claim 必须是非空字符串（事实得是一句可判断真假的陈述）`)
    if (!FACT_KINDS.includes(f?.kind)) problems.push(`${where}: kind=${JSON.stringify(f?.kind)} 不在 ${FACT_KINDS.join('/')}`)
    if (f?.kind === 'inference') problems.push(`${where}: kind='inference' 不得当事实用 —— **推断不能冒充事实**（推断只能出现在演绎层）`)
    const anchors = Array.isArray(f?.evidence) ? f.evidence : (f?.evidence ? [f.evidence] : [])
    if (anchors.length === 0) problems.push(`${where}: 缺证据锚点（"没有锚点的事实"不是事实，是主张）`)
    for (const a of anchors) {
      const r = anchorResolves(a, { root: root ?? process.cwd() })
      if (!r.ok) problems.push(`${where}: 锚点不可解析 —— ${r.why}`)
    }
    if (typeof f?.confidence !== 'number' || f.confidence < 0 || f.confidence > 1) problems.push(`${where}: confidence 必须是 [0,1] 的数`)
    if (typeof f?.confidenceBasis !== 'string' || f.confidenceBasis.trim() === '') problems.push(`${where}: 缺 confidenceBasis —— **置信度必须说明凭什么**（否则它就是一个装饰数字）`)
    if (typeof f?.source !== 'string' || f.source.trim() === '') problems.push(`${where}: 缺 source（谁产出的）`)
    return {
      id, claim: f?.claim ?? null, kind: f?.kind ?? null,
      value: f?.value ?? null, unit: f?.unit ?? null,
      evidence: anchors, confidence: f?.confidence ?? null,
      confidenceBasis: f?.confidenceBasis ?? null, source: f?.source ?? null,
      meta: f?.meta ?? null,
    }
  })
  const ids = facts.map((f) => f.id)
  const dup = ids.filter((x, i) => ids.indexOf(x) !== i)
  if (dup.length) problems.push(`事实 id 重复：${[...new Set(dup)].join(', ')}（id 是追溯的锚，不可重）`)
  return { schema: SCHEMA_VERSION, ok: problems.length === 0, facts, problems, verifiedBy: 'evidence-core/collectFacts@1' }
}

/** 事实层复核（独立于收集器；对**已落盘**的事实重新判一遍，防"收集时对、落盘后被改"）。 */
export function verifyFacts(facts, { root = null } = {}) {
  const problems = []
  for (const f of facts ?? []) {
    if (!f?.id) { problems.push('有事实缺 id'); continue }
    if (!FACT_KINDS.includes(f.kind)) problems.push(`${f.id}: kind 非法`)
    const anchors = Array.isArray(f.evidence) ? f.evidence : []
    if (anchors.length === 0) problems.push(`${f.id}: 无锚点`)
    for (const a of anchors) { const r = anchorResolves(a, { root: root ?? process.cwd() }); if (!r.ok) problems.push(`${f.id}: ${r.why}`) }
    if (typeof f.confidenceBasis !== 'string' || f.confidenceBasis.trim() === '') problems.push(`${f.id}: 无 confidenceBasis`)
  }
  return { ok: problems.length === 0, problems, count: (facts ?? []).length }
}

/* ──────────────────────────── ② 关系层 */

/**
 * 关系验证器。四条机检：
 *   · from/to 指向**存在**的事实；
 *   · `basis` 非空且 `basisKind` 合法；
 *   · **`causal` 只认 controlled-variation / mechanism** —— 相关不等于因果；
 *   · `excludes` 的 to 必须是 kind='refutation' 的事实（"排除"要有**反驳性证据**撑着）。
 */
export function verifyRelations(relations, facts) {
  const problems = []
  const byId = new Map((facts ?? []).map((f) => [f.id, f]))
  for (const r of relations ?? []) {
    const where = `关系 ${r?.id ?? '(无 id)'}`
    if (!r?.id) problems.push('有关系缺 id')
    if (!RELATION_TYPES.includes(r?.type)) { problems.push(`${where}: type=${JSON.stringify(r?.type)} 不在 ${RELATION_TYPES.join('/')}`); continue }
    if (!byId.has(r.from)) problems.push(`${where}: from=${r.from} 不是已知事实`)
    if (!byId.has(r.to)) problems.push(`${where}: to=${r.to} 不是已知事实`)
    if (typeof r.basis !== 'string' || r.basis.trim() === '') problems.push(`${where}: 缺 basis —— **关系必须有逻辑依据**`)
    if (!BASIS_KINDS.includes(r?.basisKind)) problems.push(`${where}: basisKind=${JSON.stringify(r?.basisKind)} 不在 ${BASIS_KINDS.join('/')}`)
    if (r.type === 'causal' && !['controlled-variation', 'mechanism'].includes(r.basisKind)) {
      problems.push(`${where}: **因果必须有对照或机制**（basisKind=${r.basisKind}）—— 仅统计相关不得冒充因果`)
    }
    if (r.type === 'excludes') {
      const to = byId.get(r.to)
      if (to && to.kind !== 'refutation') problems.push(`${where}: excludes 的 to 必须是 kind='refutation' 的事实（实得 ${to.kind}）—— 排除要有反驳证据`)
    }
    for (const a of (Array.isArray(r.evidence) ? r.evidence : [])) {
      const res = anchorResolves(a, { root: process.cwd() })
      if (!res.ok) problems.push(`${where}: 锚点不可解析 —— ${res.why}`)
    }
  }
  return { ok: problems.length === 0, problems, count: (relations ?? []).length }
}

/* ──────────────────────────── ③ 演绎引擎 */

/**
 * **演绎**：从事实+关系合成方向。
 *
 * ⚠️ 注意签名里**没有 `means`/`candidates`** —— 这是刻意的结构性约束：
 * 调用方**无法**把"候选手段表"喂进来，所以"从手段集里挑一个"在这一层**做不到**。
 * 方向由 `rules` 施加在事实+关系上产出；每条方向必须挂到演绎步，每步必须挂到事实。
 *
 * @param {{goal:object, facts:object[], relations:object[], rules?:Function[]}} p
 */
export function derive({ goal, facts, relations, rules = DEFAULT_RULES, weights = null } = {}) {
  const problems = []
  if (!goal || typeof goal.targetMetric !== 'string' || goal.targetMetric.trim() === '') {
    throw new EvidenceError('E_INPUT_SHAPE', 'goal.targetMetric 必须是非空字符串')
  }
  const fv = verifyFacts(facts)
  const rv = verifyRelations(relations, facts)
  if (!fv.ok || !rv.ok) {
    return { schema: SCHEMA_VERSION, refused: true, code: 'E_PREMISE_INVALID', problems: [...fv.problems, ...rv.problems], steps: [], directions: [], excluded: [], stop: { reason: 'premise-invalid' } }
  }

  const steps = []
  const directions = []
  const excluded = []
  const ctx = { goal, facts, relations, byId: new Map(facts.map((f) => [f.id, f])), weights }

  for (const rule of rules) {
    let out
    try { out = rule(ctx) } catch (e) { problems.push(`规则 ${rule.name || '(匿名)'} 抛错：${e.message}`); continue }
    for (const s of out?.steps ?? []) {
      steps.push({ id: `D${steps.length + 1}`, ...s })
    }
    for (const d of out?.directions ?? []) directions.push(d)
    for (const x of out?.excluded ?? []) excluded.push(x)
  }

  // 排除：被 refutation 事实否掉的方向，**必须**带证据锚点
  for (const r of relations.filter((x) => x.type === 'excludes')) {
    const refut = ctx.byId.get(r.to)
    excluded.push({
      id: `X-${r.id}`, statement: refut?.claim ?? `（被 ${r.id} 排除）`,
      excludedBy: [r.to], evidence: [...(refut?.evidence ?? [])], basis: r.basis,
    })
  }

  // **去重**：同一条被排除的事实可能被多条关系/规则各排除一次；按 `excludedBy[0]` 保序去重。
  const seenX = new Set()
  const dedupExcluded = excluded.filter((x) => {
    const k = (x.excludedBy ?? [])[0] ?? x.id
    if (seenX.has(k)) return false
    seenX.add(k); return true
  })
  const stop = decideStop({ directions, excluded: dedupExcluded, steps })
  const deriv = { schema: SCHEMA_VERSION, refused: false, code: null, problems, goal, steps, directions: rankDirections(directions, weights), excluded: dedupExcluded, stop, weightMode: weights ? 'weighted' : 'legacy-count' }
  const tr = checkTraceability(deriv, facts, relations)
  deriv.traceability = tr
  if (!tr.ok) { deriv.refused = true; deriv.code = 'E_TRACEABILITY_BROKEN' }
  return deriv
}

/** 停止条件（本库自己的两条，与任务书对齐）。 */
export function decideStop({ directions = [], excluded = [], steps = [] } = {}) {
  const live = directions.filter((d) => !d.excluded)
  if (steps.length === 0) return { reason: 'no-derivation-possible', detail: '事实+关系推不出任何一步 ⇒ 证据链无法继续推演' }
  if (live.length === 0) return { reason: 'all-directions-excluded', detail: `全部 ${directions.length + excluded.length} 个方向均被证据排除` }
  return { reason: null, detail: `存活方向 ${live.length} 个` }
}

/**
 * 排序：**不预测效应量**（准则明令），只按**证据支撑强度**排。
 * 依据是"支撑它的步所引用的**独立事实条数**"与"是否建立在对照型因果上"，
 * 而不是"我估计能涨多少"。
 */
export function rankDirections(directions, weights = null) {
  const w = weights instanceof Map ? weights : null
  return [...directions].map((d) => {
    const anchors = Array.isArray(d.factAnchors) ? d.factAnchors : []
    // **加权证据质量**：事实按权重计入；缺权重时退化为"每条计 1"（= 旧版计数，legacy 对照）。
    const mass = w ? anchors.reduce((a, id) => a + (w.get(id) ?? 1), 0) : anchors.length
    return {
      ...d,
      supportCount: Array.isArray(d.supportedBy) ? d.supportedBy.length : 0,
      factAnchors: anchors.length,
      weightedMass: Number(mass.toFixed(4)),
      weightMode: w ? 'weighted' : 'legacy-count',
    }
  }).sort((a, b) => {
    // **可执行性优先**：具体干预（kind='intervention'）排在抽象方向族之前 ——
    // 理由：迭代需要**一个可执行的动作**，而方向族本身不可执行。
    // 这**不是**"从手段集挑"：干预的值来自事实声明的定义域 + 一条纯函数规则（区间二分）。
    const ai = a.kind === 'intervention' ? 0 : 1
    const bi = b.kind === 'intervention' ? 0 : 1
    if (ai !== bi) return ai - bi
    if ((b.weightedMass ?? 0) !== (a.weightedMass ?? 0)) return (b.weightedMass ?? 0) - (a.weightedMass ?? 0)
    if ((b.factAnchors ?? 0) !== (a.factAnchors ?? 0)) return (b.factAnchors ?? 0) - (a.factAnchors ?? 0)
    if ((b.supportCount ?? 0) !== (a.supportCount ?? 0)) return (b.supportCount ?? 0) - (a.supportCount ?? 0)
    return String(a.id) < String(b.id) ? -1 : 1
  })
}

/**
 * **事实权重**（前置 2）：把"策略"从**删事实**改成**给事实加权**。
 *
 * 为什么必须改：二值过滤会**删掉前提** ⇒ 建立在该事实上的关系失效 ⇒ 演绎整条拒发
 * （实测：`F-AXIS` 被滤掉 ⇒ `R-EXCL-AXIS` 前提失效 ⇒ 零存活方向）。
 * 加权**不删任何事实**，因此关系层永远保持完整、演绎永远活着 —— 策略只能**改变排序**，
 * 不能**切断链条**。这是一条**结构性**保证，不靠纪律。
 *
 * @param {Map<string,number>|object|null} weights
 */
export function weightedFacts(facts, weights) {
  const w = weights instanceof Map ? weights : new Map(Object.entries(weights ?? {}))
  return { facts, weights: w }
}

/**
 * **追溯性检查**（演绎层最核心的机检）：每一步都能走到事实。
 * 任一步的 `from` 既不是事实 id 也不是**更早的**步 id ⇒ 断链 ⇒ 拒绝。
 */
export function checkTraceability(derivation, facts, relations) {
  const problems = []
  const factIds = new Set((facts ?? []).map((f) => f.id))
  const relIds = new Set((relations ?? []).map((r) => r.id))
  const seenSteps = new Set()
  for (const s of derivation?.steps ?? []) {
    if (!s.id) { problems.push('有演绎步缺 id'); continue }
    const from = Array.isArray(s.from) ? s.from : []
    if (from.length === 0) problems.push(`步 ${s.id}: 无 from ⇒ 该步悬空（每一步都必须由事实或更早的步支撑）`)
    for (const src of from) {
      if (factIds.has(src)) continue
      if (relIds.has(src)) continue     // **关系也是前提**：一步常常是"由某条因果/约束推出"
      if (seenSteps.has(src)) continue
      problems.push(`步 ${s.id}: from=${src} 既不是事实、也不是关系、也不是更早的步 ⇒ **断链**`)
    }
    if (typeof s.text !== 'string' || s.text.trim() === '') problems.push(`步 ${s.id}: 缺 text`)
    if (typeof s.rule !== 'string' || s.rule.trim() === '') problems.push(`步 ${s.id}: 缺 rule（这一步用了什么推理规则）`)
    seenSteps.add(s.id)
  }
  const stepIds = seenSteps
  for (const d of derivation?.directions ?? []) {
    const sup = Array.isArray(d.supportedBy) ? d.supportedBy : []
    if (sup.length === 0) problems.push(`方向 ${d.id}: 无 supportedBy ⇒ 方向不是演绎出来的`)
    for (const x of sup) if (!stepIds.has(x)) problems.push(`方向 ${d.id}: supportedBy=${x} 不是本演绎的步 ⇒ 断链`)
    for (const r of (Array.isArray(d.relationRefs) ? d.relationRefs : [])) if (!relIds.has(r)) problems.push(`方向 ${d.id}: relationRefs=${r} 不是已知关系`)
  }
  for (const x of derivation?.excluded ?? []) {
    const ev = Array.isArray(x.evidence) ? x.evidence : []
    if (ev.length === 0) problems.push(`排除项 ${x.id}: **无证据锚点** —— 排除必须有证据，不许"觉得不行"`)
    for (const a of ev) { const r = anchorResolves(a, { root: process.cwd() }); if (!r.ok) problems.push(`排除项 ${x.id}: ${r.why}`) }
  }
  // 方向**不得**引用"候选手段表"这种东西（结构性反例：本库根本没有该入参，此处再兜一层）
  const text = JSON.stringify(derivation ?? {})
  if (/"meansId"\s*:|"candidateMeans"\s*:|"fromMenu"\s*:/.test(text)) {
    problems.push('演绎产物里出现 meansId/candidateMeans/fromMenu ⇒ 方向来自**手段集**而不是演绎 ⇒ 拒绝')
  }
  return { ok: problems.length === 0, problems, steps: stepIds.size, directions: (derivation?.directions ?? []).length, excluded: (derivation?.excluded ?? []).length }
}

/** **top-1** = 排序后的第一个存活方向（自动成为迭代方向，不由人挑）。 */
export function top1(derivation) {
  const live = (derivation?.directions ?? []).filter((d) => !d.excluded)
  if (!derivation || derivation.refused || live.length === 0) {
    return { ok: false, code: derivation?.code ?? 'E_NO_DIRECTION', reason: derivation?.stop?.detail ?? '无存活方向' }
  }
  return { ok: true, direction: live[0], rule: '存活方向中**加权证据质量**最大者（权重缺省为 1，即退化为锚点计数）；同分按锚点数、支撑步数、id（全序，与输入顺序无关）' }
}

/* ──────────────────────────── 默认推理规则 */

/** 规则：从**受控变差**的因果链里读出"响应形状"。 */
function ruleResponseShape(ctx) {
  const steps = []; const directions = []; const excluded = []
  const causal = ctx.relations.filter((r) => r.type === 'causal' && r.basisKind === 'controlled-variation')
  if (causal.length === 0) return { steps, directions, excluded }
  const gains = ctx.facts.filter((f) => f.meta?.role === 'gain')
  const costs = ctx.facts.filter((f) => f.meta?.role === 'cost')
  if (gains.length >= 2 && costs.length >= 2) {
    steps.push({
      from: [...gains.map((f) => f.id), ...costs.map((f) => f.id)], rule: 'monotone-shape-comparison',
      text: `目标度量随自变量单调上升，代价也随同一自变量单调上升（受控变差：唯一变化量是自变量）`,
    })
    const refuted = ctx.facts.filter((f) => f.kind === 'refutation')
    for (const r of refuted) {
      excluded.push({ id: `X-${r.id}`, statement: r.claim, excludedBy: [r.id], evidence: [...r.evidence], basis: r.confidenceBasis })
    }
    const decouple = ctx.facts.filter((f) => f.meta?.role === 'decoupler-candidate')
    const refutedByTuning = ctx.facts.filter((f) => f.meta?.role === 'intervention-refuted')
    if (decouple.length > 0 && refutedByTuning.length > 0) {
      // **实测否证**：换旋钮并没有解耦（增益与代价同向下降）⇒ 该族方向被证据排除。
      for (const r of refutedByTuning) {
        excluded.push({ id: `X-${r.id}`, statement: r.claim, excludedBy: [r.id], evidence: [...r.evidence], basis: r.confidenceBasis })
      }
    } else if (decouple.length > 0) {
      directions.push({
        id: 'DIR-decouple', statement: '改变**耦合机制**（自由度/容量），而不是继续在同一自变量上取点',
        supportedBy: [`D${steps.length}`], relationRefs: causal.map((r) => r.id),
        factAnchors: [...decouple.map((f) => f.id), ...causal.map((r) => r.id)],
        excluded: false,
        rationale: '增益与代价由**同一个自变量**驱动 ⇒ 在该自变量上取任何点都同向移动两者；要解耦必须动**另一个**因子',
      })
    }
    directions.push({
      id: 'DIR-same-axis', statement: '继续在同一自变量上取新点',
      supportedBy: [`D${steps.length}`], relationRefs: causal.map((r) => r.id),
      factAnchors: causal.map((r) => r.id), excluded: true,
      rationale: '被证据排除：该自变量上"超过 incumbent"与"不退化"已被实测证明互斥',
    })
  }
  return { steps, directions, excluded }
}

/** 规则：定义性关系直接给出方向（少见，但必须有入口）。 */
function ruleDefinitional(ctx) {
  const steps = []; const directions = []
  for (const r of ctx.relations.filter((x) => x.type === 'definitional')) {
    const a = ctx.byId.get(r.from); const b = ctx.byId.get(r.to)
    steps.push({ from: [r.from, r.to], rule: 'definitional-substitution', text: `${a?.claim ?? r.from} ⇔ ${b?.claim ?? r.to}（定义等价）` })
    directions.push({ id: `DIR-def-${r.id}`, statement: `按定义把目标改述为「${b?.claim ?? r.to}」`, supportedBy: [`D${steps.length}`], relationRefs: [r.id], factAnchors: [r.from, r.to, r.id], excluded: false, rationale: r.basis })
  }
  return { steps, directions }
}

/**
 * 规则：**从方向族推出具体干预**（前置 3）。
 *
 * ## 为什么它不违反"方向必须由演绎产生"
 * 它**不读任何候选表**。具体值是这样来的：
 *   ① 从一条 `meta.role='mechanism-parameter'` 的**事实**里读出该机制的**定义域**
 *      （`{name, current, min}` —— 例如 LoRA 秩：当前 8，下限 1）；
 *   ② 用一条**纯函数规则**（区间二分）在定义域上取值；
 *   ③ 每一步都挂到事实 id 上，因此仍受追溯性检查约束。
 * ⇒ 换一个机制参数（学习率 / 步数 / 目标模块），同一条规则照样工作 —— 这是**规则**，不是清单。
 *
 * ## 它**拒绝**预测效应量
 * 产物只给**定性**预期（"自由度下降 ⇒ 漂移倾向下降"）与**可证伪的测量计划**，
 * 不给"预计涨 X 个点"。任务书明令"不预测效应量，从证据推断"。
 */
function ruleInterventionSynthesis(ctx) {
  const steps = []; const directions = []
  const params = ctx.facts.filter((f) => f.meta?.role === 'mechanism-parameter')
  const dofFacts = ctx.facts.filter((f) => f.meta?.role === 'decoupler-candidate' || /自由度|degrees of freedom/i.test(f.claim ?? ''))
  const mech = ctx.relations.filter((r) => r.type === 'causal' && r.basisKind === 'mechanism')
  if (params.length === 0 || dofFacts.length === 0 || mech.length === 0) return { steps, directions }

  // **被实测否证过的机制参数不再合成**：`meta.role='intervention-refuted'` 的事实指名了它。
  const refutedParams = new Set(ctx.facts.filter((f) => f.meta?.role === 'intervention-refuted').map((f) => f.meta?.parameter).filter(Boolean))
  for (const p of params) {
    const { name, current, min } = p.meta
    if (typeof current !== 'number' || typeof min !== 'number' || !(min < current)) continue
    if (refutedParams.has(name)) continue   // 已执行过并否证 ⇒ 不再重复提议同一干预
    // ② 区间二分（纯函数规则；定义域来自事实，不是候选表）
    const mid = Math.floor((current + min) / 2)
    steps.push({
      from: [p.id, ...dofFacts.map((f) => f.id), ...mech.map((r) => r.id)],
      rule: 'interval-bisection-on-fact-declared-domain',
      text: `机制参数 ${name} 的**定义域来自事实**：current=${current}，min=${min} ⇒ 二分取 ${mid}（自由度从 ${current} 降到 ${mid}）`,
    })
    directions.push({
      id: `DIR-${name}-${mid}`,
      statement: `把 ${name} 从 ${current} 降到 ${mid}（自由度减半），以此**改变耦合机制**而不是在步数轴上再取点`,
      supportedBy: [`D${steps.length}`],
      relationRefs: mech.map((r) => r.id),
      factAnchors: [p.id, ...dofFacts.map((f) => f.id), ...mech.map((r) => r.id)],
      excluded: false,
      kind: 'intervention',
      parameter: { name, from: current, to: mid, min },
      qualitativeExpectation: '自由度下降 ⇒ 适配器可偏离基座的方向数减少 ⇒ **漂移倾向下降**（定性）',
      measurementPlan: '同数据同 seed 同步数，只改该参数；用同一把含代价维度的判据判决',
      refusesEffectSize: true,
      rationale: '增益与代价由**同一个自变量**驱动；要解耦必须动**另一个**因子，而这里是该因子的定义域上的最小可分辨变化',
    })
  }
  return { steps, directions }
}

export const DEFAULT_RULES = Object.freeze([ruleResponseShape, ruleInterventionSynthesis, ruleDefinitional])

/* ──────────────────────────── ④ 案例库 */

/**
 * **案例库**：事实集 → 推导链 → 方向 → 验证结果 → 结论。
 * 纪律："案例库必须被**复用**，不是只记录" ⇒ 提供 `reuse()` 并**记录复用次数**；
 * `stats()` 会把"入库后从未被复用"的案例点出来（让"只记录"这件事**可见**）。
 */
export class CaseLibrary {
  constructor(file) { this.file = file; this.cases = loadCases(file) }

  /** 存档一个案例。`key` 用于检索去重（同 key 覆盖 ⇒ 幂等）。 */
  add({ key, facts, relations, derivation, outcome, conclusion, evidenceRefs = [] }) {
    if (!key) throw new EvidenceError('E_INPUT_SHAPE', '案例必须有 key')
    const rec = {
      key, at: new Date().toISOString(),
      factIds: (facts ?? []).map((f) => f.id),
      relationIds: (relations ?? []).map((r) => r.id),
      top1: top1(derivation).direction?.statement ?? null,
      derivationSteps: (derivation?.steps ?? []).length,
      outcome: outcome ?? null, conclusion: conclusion ?? null,
      evidenceRefs, reusedBy: [], reuseCount: 0,
      fingerprint: sha256(JSON.stringify({ key, facts: (facts ?? []).map((f) => [f.id, f.value]), derivation: derivation?.steps ?? [] })),
    }
    const i = this.cases.findIndex((c) => c.key === key)
    if (i >= 0) this.cases[i] = rec; else this.cases.push(rec)
    this.#save()
    return rec
  }

  /** 检索：按事实 id / 关键词 / 目标度量匹配（**只返回已存档的真实案例**）。 */
  search({ factId = null, contains = null, metric = null } = {}) {
    return this.cases.filter((c) => {
      if (factId && !c.factIds.includes(factId)) return false
      if (metric && !(c.conclusion ?? '').includes(metric) && !(c.top1 ?? '').includes(metric)) return false
      if (contains && !JSON.stringify(c).toLowerCase().includes(String(contains).toLowerCase())) return false
      return true
    })
  }

  /** 复用一条案例：**必须给出复用者与用途**，并回传该案例的结论（供新演绎当先验）。 */
  reuse(key, { by, purpose }) {
    const c = this.cases.find((x) => x.key === key)
    if (!c) throw new EvidenceError('E_CASE_NOT_FOUND', `案例不存在：${key}`)
    if (!by || !purpose) throw new EvidenceError('E_INPUT_SHAPE', '复用必须记录 by 与 purpose（复用不是静默读取）')
    c.reusedBy.push({ by, purpose, at: new Date().toISOString() })
    c.reuseCount += 1
    this.#save()
    return { key, conclusion: c.conclusion, top1: c.top1, reuseCount: c.reuseCount }
  }

  stats() {
    const dead = this.cases.filter((c) => c.reuseCount === 0).map((c) => c.key)
    return { total: this.cases.length, reused: this.cases.length - dead.length, neverReused: dead }
  }

  #save() { mkdirSync(dirname(this.file), { recursive: true }); writeFileSync(this.file, JSON.stringify({ schema: SCHEMA_VERSION, cases: this.cases }, null, 2)) }
}

function loadCases(file) { try { return JSON.parse(readFileSync(file, 'utf8')).cases ?? [] } catch { return [] } }
export function sha256(s) { return `sha256:${createHash('sha256').update(s).digest('hex')}` }
