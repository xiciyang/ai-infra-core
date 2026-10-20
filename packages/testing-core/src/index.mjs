/**
 * @xiciyang/testing-core —— 测量原语 v0（契约冻结于 2026-09-28 长任务 1 / 阶段 B）。
 *
 * 这个库存在的理由（NEXT_STEPS §3.3）：
 *   quantization 与 tuning **各写了一份精度测量实现**，两份实现之间只靠推理侧契约层的
 *   一致性检查绑定。共享库是这两份实现的最终归宿 —— v0 先把**接口**与**判据**冻住，
 *   最小实现（`@internal`）随后被训练插件直接调用，避免再长出第三份。
 *
 * v0 冻结的导出面（major 变更须暂停报告；minor 允许追加）：
 *   CONTRACT_VERSION
 *   lnVocab(vocabSize)
 *   meanNllFromLogprobs(logprobs)
 *   uniformSignature({meanNll, perTokenNll, vocabSize, z})
 *   perplexity(meanNll)
 *   relativeChange({baseline, candidate})
 *   dualGate({...})
 *   floatFingerprint(values)
 *
 * **本库不做的事**（v0 明确排除，防止它长成一个框架）：
 *   - 不规定"从哪取数"（同一个判据允许多种取数来源：logprobs / logits / 自行计算的 NLL）
 *   - `index.mjs`（本体）不读文件、不发请求、不起容器（纯函数）
 *   - 不引入任何运行时依赖（零依赖是硬约束，与四个插件一致）
 *
 * v0.2.0（**additive**，minor）：把四个训练插件里同一算法的四份评估实现合并进
 * `./evaluate.mjs`（本库**唯一**允许 `fetch` 的文件，见该文件头）。本体判据**一行未改**。
 */

export const CONTRACT_VERSION = '0.2.0'

/** ln(V)：均匀分布的签名值。V 必须来自模型 config 的 `vocab_size`，**不得硬编码**。 */
export function lnVocab(vocabSize) {
  const v = Number(vocabSize)
  if (!Number.isFinite(v) || v < 2) throw new Error(`vocabSize 非法：${vocabSize}（必须来自模型 config.json 的 vocab_size，且 ≥2）`)
  return Math.log(v)
}

/** 单 token 的 NLL = −log p(token)。输入是自然对数概率。 */
export function nllFromLogprob(logprob) {
  const p = Number(logprob)
  if (!Number.isFinite(p)) throw new Error(`logprob 非法：${logprob}`)
  if (p > 1e-9) throw new Error(`logprob 必须 ≤ 0（自然对数概率），实际 ${p}`)
  return -p
}

/** 样本平均 NLL。空样本必须响亮失败 —— 空样本上的"均值"是 NaN 伪装成的结论。 */
export function meanNllFromLogprobs(logprobs) {
  if (!Array.isArray(logprobs) || logprobs.length === 0) throw new Error('logprobs 必须是非空数组（空样本不得产出结论）')
  let sum = 0
  for (const lp of logprobs) sum += nllFromLogprob(lp)
  return sum / logprobs.length
}

/** 困惑度 = exp(meanNll)。 */
export function perplexity(meanNll) {
  const m = Number(meanNll)
  if (!Number.isFinite(m)) throw new Error(`meanNll 非法：${meanNll}`)
  return Math.exp(m)
}

export function mean(xs) {
  if (!Array.isArray(xs) || xs.length === 0) throw new Error('mean 需要非空数组')
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

/** 样本标准差（n−1 分母；n=1 时为 0）。 */
export function stddev(xs) {
  if (!Array.isArray(xs) || xs.length === 0) throw new Error('stddev 需要非空数组')
  if (xs.length === 1) return 0
  const m = mean(xs)
  const v = xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1)
  return Math.sqrt(v)
}

/**
 * 均匀分布签名 —— **测量有效性检查**，不是"模型好不好"的检查。
 *
 * 判据（报告要求第 2 项要求的公式，逐字落地）：
 *
 *     设 lnV = ln(vocab_size)（vocab_size 从模型 config.json 读，**不硬编码**）
 *         n   = 参与统计的 token 数
 *         s   = 每个 token NLL 的样本标准差（n−1 分母）
 *         δ_fp = 2^-9 · lnV          ← 数值表示误差下界（bf16 有 8 位尾数，相对误差 2^-9）
 *         ε   = max(δ_fp, z · s / √n) ← z 默认 3（单侧 ≈1.35e-3 的假阳性率）
 *
 *     判定：**uniform ⟺ |meanNll − lnV| ≤ ε**
 *
 * ε 的三条推导依据（**不是魔数**）：
 *   ① 若输出分布**严格均匀**，则每个 token 的 NLL 恒等于 lnV（样本标准差为 0），
 *      故理论下界为 0 —— ε 不需要任何"经验宽容度"。
 *   ② 实际不可能严格为 0：logits 以 bf16 存储时相对误差约 2^-9，经 log-softmax 传导到
 *      NLL 的量级为 2^-9·lnV；这是**可推导的数值噪声地板**，与模型好坏无关。
 *   ③ 超过地板的部分来自**抽样**：meanNll 是 n 个样本的均值，其标准误为 s/√n；
 *      取 z=3 表示"离 lnV 三倍标准误以上才认定不是均匀"。
 *   ⇒ ε 由"测量本身的噪声"决定，随 (n, s, lnV) 变化，**每次测量重算并随证据一起返回**。
 *
 * 与其他测量有效性检查的关系（报告要求第 2 项要求写明）：
 *   本签名是**有效性的前置闸门**，不替代其他检查，也不被其他检查替代：
 *   - 它回答"模型是不是根本没加载/输出全均匀"（无效测量），
 *     不回答"输出对不对"（那是 parity / 质量探针的职责）。
 *   - 它**必须**与"前向真的跑过"（拿到了 n>0 个 token 的 logprob）同时成立；
 *     n=0 时本函数抛错而不是返回 uniform:true —— 把失败伪装成"均匀"是最坏的一种。
 *   - 它**不**使用 vocab_size 之外的模型信息，故对任何架构同构。
 *
 * @returns {{uniform:boolean, criterion:string, meanNll:number, lnV:number, epsilon:number,
 *            delta:number, n:number, stdNll:number, z:number, fpFloor:number, effectSize:number}}
 */
export function uniformSignature({ meanNll, perTokenNll = null, vocabSize, z = 3 } = {}) {
  const m = Number(meanNll)
  if (!Number.isFinite(m)) throw new Error(`meanNll 非法：${meanNll}`)
  const lnV = lnVocab(vocabSize)
  let n
  let s
  if (Array.isArray(perTokenNll) && perTokenNll.length > 0) {
    n = perTokenNll.length
    s = stddev(perTokenNll.map(Number))
    // 自洽性：调用方给了逐 token 样本，就必须与 meanNll 一致（防止两处口径漂移）
    const m2 = mean(perTokenNll.map(Number))
    if (Math.abs(m2 - m) > Math.max(1e-6, 0.05 * Math.abs(m))) {
      throw new Error(`meanNll(${m}) 与 perTokenNll 的均值(${m2}) 不一致 —— 同一份测量不得有两个口径`)
    }
  } else {
    throw new Error('uniformSignature 需要 perTokenNll（逐 token 样本）：只给均值无法推导 ε，而 ε 不可是魔数')
  }
  if (!(n > 0)) throw new Error('n 必须 > 0（没有样本时不得判定均匀）')
  const fpFloor = Math.pow(2, -9) * lnV
  const sampling = (Number(z) * s) / Math.sqrt(n)
  const epsilon = Math.max(fpFloor, sampling)
  const delta = lnV - m
  return {
    uniform: Math.abs(delta) <= epsilon,
    criterion: '|meanNll − ln(vocab_size)| ≤ max(2^-9·ln(vocab_size), z·std(NLL)/√n)',
    meanNll: m,
    lnV,
    epsilon,
    delta,
    effectSize: delta,
    n,
    stdNll: s,
    z: Number(z),
    fpFloor,
  }
}

/** 相对变化（百分比）。baseline 为 0 时响亮失败 —— 除零不得静默成 Infinity。 */
export function relativeChange({ baseline, candidate, direction = 'lower-is-better' } = {}) {
  const b = Number(baseline)
  const c = Number(candidate)
  if (!Number.isFinite(b) || !Number.isFinite(c)) throw new Error('relativeChange 需要有限数')
  if (b === 0) throw new Error('baseline 为 0：相对变化无定义（不得用 Infinity 冒充结论）')
  const raw = ((c - b) / Math.abs(b)) * 100
  // direction=lower-is-better：变差为正；higher-is-better：变差为正
  const worsening = direction === 'lower-is-better' ? raw : -raw
  return { rawPct: raw, worseningPct: worsening, direction }
}

/**
 * 双重门禁：**既判数值达标，也判测量成立**。
 *
 * validity 项不过 → 直接 FAIL（且 `reason` 说明是"测量不成立"而不是"没达标"）。
 * 这两类失败必须可区分：把"没测出来"报成"没达标"会让人去调参，而真正该做的是修测量。
 */
export function dualGate({ accuracy = null, perf = null, validity = [], maxAccuracyDropPct, minPerfGainPct } = {}) {
  const checks = []
  for (const v of validity) {
    checks.push({ kind: 'validity', name: v.name, ok: v.ok === true, detail: v.detail ?? null })
  }
  const validityOk = checks.filter((c) => c.kind === 'validity').every((c) => c.ok)
  if (accuracy) {
    const drop = Number(accuracy.dropPct)
    checks.push({
      kind: 'accuracy',
      name: 'accuracy-drop',
      ok: Number.isFinite(drop) && Number.isFinite(maxAccuracyDropPct) && drop <= maxAccuracyDropPct,
      value: drop,
      threshold: maxAccuracyDropPct,
    })
  }
  if (perf) {
    const gain = Number(perf.gainPct)
    checks.push({
      kind: 'perf',
      name: 'perf-gain',
      ok: Number.isFinite(gain) && Number.isFinite(minPerfGainPct) && gain >= minPerfGainPct,
      value: gain,
      threshold: minPerfGainPct,
    })
  }
  const hard = checks.filter((c) => c.kind !== 'validity')
  const pass = validityOk && hard.length > 0 && hard.every((c) => c.ok)
  const reason = !validityOk
    ? '测量不成立（validity 闸门未过）：本次不得据此下"达标/未达标"结论'
    : pass ? '达标' : '数值未达标'
  return { pass, validityOk, reason, checks }
}

/** 浮点指纹：把一组数值按 IEEE754 位模式哈希 —— 用于判定"逐位相同"，而不是"看起来接近"。 */
export async function floatFingerprint(values) {
  const { createHash } = await import('node:crypto')
  const f32 = new Float32Array(Array.isArray(values) ? values : [values])
  const f64 = new Float64Array(Array.isArray(values) ? values : [values])
  const h32 = createHash('sha256').update(Buffer.from(f32.buffer)).digest('hex')
  const h64 = createHash('sha256').update(Buffer.from(f64.buffer)).digest('hex')
  return { n: f32.length, f32: `sha256:${h32}`, f64: `sha256:${h64}` }
}

/* ═══════════════════ 评估壳（端点 I/O + 抽取 + 遗忘门禁） ═══════════════════ */

/**
 * v0.2.0（**additive**：minor 允许追加）：把四个训练插件里**同一算法的四份拷贝**
 * （`training-{sft,pretrain,rl,qat}/src/evaluate.mjs`）合并到本库，成为**唯一实现**。
 *
 * 边界因此**显式扩展**（诚实记录，不藏在代码里）：
 *   - `index.mjs` 本体仍是冻结的**纯函数**测量原语（零 I/O、零依赖）；
 *   - `./evaluate.mjs` 是它的**评估壳**：读写端点 / 抽取逐条测量记录 /
 *     把数交给本体判。它是本库**唯一**允许出现 `fetch` 的文件。
 *   - 仍然**零运行时依赖**；仍不 import 任何第三方包。
 *
 * 为什么合并（不是整理代码）：同一概念四个所有者必然**静默分叉** ——
 * 判据在四个包里各改各的，谁也无法证明另外三份是同一个语义（本仓库的"两个真源"缺陷族）。
 */
export * from './evaluate.mjs'
