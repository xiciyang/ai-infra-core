/**
 * evaluate —— 训练侧**端点评估原语与遗忘门禁的唯一实现**。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 这个文件为什么存在（长任务 6 / 任务 A：合并四份 evaluate.mjs）
 * ══════════════════════════════════════════════════════════════════════════════
 * `training-{sft,pretrain,rl,qat}/src/evaluate.mjs` 曾经各写一份**同一个算法**
 * （合计 1166 行；`post`/`get`/`evalLM`/`evalMMLU`/`evalUniform`/`measurementCompleteness`
 * /`attachIntegrity`/`forgettingGate` 是同一概念、四个所有者）。四个所有者带来的是
 * **静默分叉**：同一个判据在四个包里各改各的，谁也不知道另外三份是不是同一个语义。
 * 这正是本仓库反复出现的缺陷族（"两个真源"）；合并是**消除分叉**，不是整理代码。
 *
 * ## 与 index.mjs 的边界（为什么 I/O 放在这个文件而不是 index.mjs）
 * `index.mjs` 保持 v0 冻结的**纯函数**测量原语（零 I/O、零依赖）；
 * 本文件是它的**评估壳**：读写端点、抽取逐条测量记录、把数交给 index.mjs 的判据。
 * 两文件的差别有一条可执行判据：本文件是**唯一**允许出现 `fetch` 的地方。
 *
 * ## 合并时必须**逐字保留**的两条缺陷修复（否则等于把缺陷放回去）
 * - **缺陷 14**：`evalLM`/`evalMMLU` 返回 `attempted / succeeded / failed / skipped /
 *   considered / partial / okIndices / firstError`；`evalMMLU` 区分 `failed`（仪器层，非 200）
 *   与 `unparsed`（模型答了话但没给 A/B/C/D）。门禁**基于 `attempted`** 判，把
 *   "测量不完整"与"样本不足"报成**两种不同的理由**。
 * - **缺陷 15**：`measurementCompleteness` **fail-closed** —— `未知 ≠ 完整`，
 *   旧条目（无 `attempted`/`failed`）一律不可复用；理由为
 *   `missing` / `marked-invalid:…` / `<part>:no-integrity-evidence` / `<part>:failed=N/M` /
 *   `<part>:partial` / `no-instrumented-parts` / `unclassified-part:<k>`。
 * - 配对用 **`okIndices` 交集**（不是数组位置），并带
 *   `pairedOn: 'okIndices-intersection' | 'positional-legacy'`。
 *
 * ## 零依赖
 * 只用 Node 内建全局（`fetch` / `AbortController` / `setTimeout`）。不 import 任何第三方包。
 */

import { mean, meanNllFromLogprobs, perplexity, stddev, uniformSignature } from './index.mjs'

/* ═══════════════════════════════ 端点调用原语 ═══════════════════════════════ */

/**
 * POST 一个 JSON 请求。**端点不可达不是异常传播**：返回 `status: 0`，
 * 由调用方按"0 个有效样本"处理 —— 把失败伪装成成功、或让整条评估崩掉，
 * 都会掩盖"测量没成立"这件事（缺陷 14 的教训）。
 */
export async function post(endpoint, path, body, { timeoutMs = 120000 } = {}) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(`${endpoint}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* 非 JSON */ }
    return { status: res.status, json, text: text.slice(0, 400) }
  } catch (e) {
    return { status: 0, json: null, text: '', error: String(e?.message ?? e).slice(0, 200) }
  } finally { clearTimeout(t) }
}

/** GET 一个 JSON 端点（用于健康检查 / 模型列表之类的前置探测）。 */
export async function get(endpoint, path, { timeoutMs = 30000 } = {}) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(`${endpoint}${path}`, { signal: ctl.signal })
    return { status: res.status, json: await res.json().catch(() => null) }
  } catch (e) { return { status: 0, json: null, error: String(e?.message ?? e).slice(0, 200) } } finally { clearTimeout(t) }
}

/* ═════════════════════════════════ 指标抽取 ═════════════════════════════════ */

/**
 * 语言建模评估（wikitext / 领域留出集）：按 **echo + logprobs** 取逐 token 对数概率。
 *
 * 返回面是**四个插件原实现的并集**（合并后单一实现在此）：
 *   - 缺陷 14 记账：`attempted / succeeded / failed / skipped / considered / partial /
 *     okIndices / firstError` —— 让"端点失效（failed 高）"与"评估集小（attempted 本来就少）"
 *     在**产物上可区分**。
 *   - 向后兼容统计量：`texts / tokens / meanNll / ppl / perText`。
 *   - `n`（= considered，本来要看多少）与 `nOk`（HTTP 200 数）：training-qat 的产物记账读它们
 *     （`summarize()` 把它们写进 registry / eval-result）；对另外三个插件是**追加字段**，
 *     不改变任何既有读取路径。
 *   - `itemMeanNlls`：`perText` 的别名（qat 原实现产出过这个名字）。
 *
 * 参数 `maxSeqLen` 保留在签名里是为了**向后兼容**（原 sft 版本声明过它）；
 * 它在四个原实现里都**未被使用**（`echo` 请求的长度由输入本身决定），本实现同样不使用。
 */
export async function evalLM({ endpoint, model, rows, limit = 400, maxSeqLen = 512, log = () => {} }) {
  void maxSeqLen
  const perText = []
  const okIndices = []   // 成功行的**原始下标** —— 配对必须按它，不能按数组位置（缺陷 14 附带修）
  let tokens = 0
  let nOk = 0            // HTTP 200 的条数（qat 原实现记账）
  let attempted = 0      // 真正发出的请求数
  let skipped = 0        // 前置条件不满足、未发出的条数（空文本）
  let failed = 0         // 发出但未取到可用 logprobs 的条数
  let firstError = null
  const considered = rows.slice(0, limit)
  for (let i = 0; i < considered.length; i += 1) {
    const text = String(considered[i].t ?? considered[i].text ?? '')
    if (!text.trim()) { skipped += 1; continue }
    attempted += 1
    // eslint-disable-next-line no-await-in-loop
    const res = await post(endpoint, '/v1/completions', {
      model, prompt: text, max_tokens: 0, echo: true, logprobs: 0, temperature: 0,
    }, { timeoutMs: 180000 })
    const lp = res.json?.choices?.[0]?.logprobs?.token_logprobs
    if (res.status === 200) nOk += 1
    if (Array.isArray(lp) && lp.length > 1) {
      const vals = lp.slice(1).filter((x) => typeof x === 'number')
      if (vals.length > 0) { perText.push(meanNllFromLogprobs(vals)); okIndices.push(i); tokens += vals.length; continue }
    }
    failed += 1
    if (firstError === null) {
      firstError = {
        index: i, status: res.status,
        detail: String(res.error ?? '').slice(0, 160) || String(res.text ?? '').slice(0, 160) || `logprobs 不可用（status=${res.status}）`,
      }
    }
    if (failed === 1 || failed % 20 === 0) log(`  lm 失败 ${failed}/${attempted}（status=${res.status}）`)
  }
  const m = perText.length ? mean(perText) : null
  const succeeded = perText.length
  return {
    // ⚠️ `n` 是"本来要看多少"，与 `attempted`（真发出去多少）**独立**（缺陷 14）
    n: considered.length, nOk,
    attempted, succeeded, failed, skipped, considered: considered.length,
    partial: attempted > 0 && succeeded < attempted,
    okIndices, firstError,
    texts: succeeded, tokens, meanNll: m, ppl: m === null ? null : perplexity(m), perText,
    itemMeanNlls: perText,
  }
}

/**
 * MMLU 评估（通用能力 / 遗忘检查）：问答题 → 首个 A/B/C/D 字母。
 *
 * 缺陷 14：`failed` = **仪器层**失败（非 200）；`unparsed` = 模型正常回话但没给出 A/B/C/D
 * （**不是**仪器故障）。旧实现把两者混在 `asked - answered` 里，无法区分"端点坏了"
 * 与"模型答非所问"。
 *
 * `logEvery` 是进度日志的步长（纯诊断输出，不进任何判据）；合并前 sft/pretrain 用 100、
 * rl 用 50，这里统一为 100。
 */
export async function evalMMLU({ endpoint, model, rows, limit = 300, log = () => {}, logEvery = 100 }) {
  const LETTERS = ['A', 'B', 'C', 'D']
  let correct = 0
  let n = 0
  let attempted = 0
  let httpOk = 0
  let failed = 0
  let firstError = null
  const details = []
  const considered = rows.slice(0, limit)
  for (const [i, r] of considered.entries()) {
    const choices = (r.choices ?? []).map((c, idx) => `${LETTERS[idx]}. ${c}`).join('\n')
    const prompt = `Answer the following multiple choice question. Reply with only the letter.\n\nQuestion: ${r.question}\n${choices}\nAnswer:`
    attempted += 1
    // eslint-disable-next-line no-await-in-loop
    const res = await post(endpoint, '/v1/completions', { model, prompt, max_tokens: 4, temperature: 0, seed: 0 }, { timeoutMs: 60000 })
    const ok = res.status === 200
    if (ok) httpOk += 1; else {
      failed += 1
      if (firstError === null) firstError = { index: i, status: res.status, detail: String(res.error ?? '').slice(0, 160) || String(res.text ?? '').slice(0, 160) }
    }
    const text = String(res.json?.choices?.[0]?.text ?? '')
    const m = /\b([ABCD])\b/.exec(text.toUpperCase())
    if (m) {
      n += 1
      if (LETTERS.indexOf(m[1]) === Number(r.answer)) correct += 1
      details.push({ got: LETTERS.indexOf(m[1]), want: Number(r.answer), index: i })
    }
    if (n > 0 && n % logEvery === 0) log(`  mmlu ${n}`)
  }
  return {
    // ── 测量完整性（**缺陷 14**）──
    attempted, httpOk, failed,
    unparsed: httpOk - n,
    partial: attempted > 0 && (failed > 0 || n < httpOk),
    okIndices: details.map((d) => d.index),
    firstError,
    // ── 统计量（向后兼容）──
    n, correct, accuracy: n > 0 ? correct / n : null, answered: n, asked: considered.length,
    considered: considered.length, details,
  }
}

/**
 * 测量完整性判定 —— **纯函数**（**缺陷 15**）。决定一份测量摘要可否进入/复用自基线缓存。
 *
 * 核心纪律：**可复用的前提是"有证据证明它完整"，不是"看起来像完整"。**
 * 没有 `attempted`/`failed` 字段的旧条目一律判为不可复用（`<part>:no-integrity-evidence`）
 * —— **未知不等于完整**（fail-closed）。宁可多测一次基线，也不要拿一份来历不明的基线去判别人的模型。
 */
export function measurementCompleteness(m) {
  if (!m || typeof m !== 'object') return { complete: false, reason: 'missing' }
  if (m.invalid === true) return { complete: false, reason: `marked-invalid${m.invalidReason ? `:${m.invalidReason}` : ''}` }
  // **逐条网络测量**的部件：必须有完整性证据，否则"未知 ≠ 完整"。
  //
  // ⚠️ `task` 于 v0.3.0 从 `KNOWN_OTHER` **移入** `INSTRUMENTED`：它是 `evalTask` 的产物，
  // 而 `evalTask` 对**每一行发一次请求**（`for (const r of rows.slice(0, limit)) { … post(…) … }`）
  // —— 它就是**逐条网络测量**。此前把它归在 `KNOWN_OTHER` 是**分类错误**，
  // 后果是：`task` 上的 `failed=60/260` **不会被报出来**（整个部件被跳过），
  // 于是"端点中途失效"在 `task` 这条度量上**重新变成不可见的**（正是缺陷 14 的形态）。
  const INSTRUMENTED = ['lm', 'mmlu', 'domain', 'task', 'train', 'val', 'perf']
  // 已知但**不是**逐条网络测量的部件（确定性打分 / 有效性探针 / 偏好打分）：
  // 它们各自的失败语义不同（例如 `uniform` 失败本身就是"不成立"），不在此处要求 attempted/failed。
  //
  // 2026-10-02（R5-G5）：`preference`/`prefTrain` 的**生产者已修好**——
  //   · `rl/src/evaluate.mjs` 的 `evalPreference` 现在返回 attempted/succeeded/failed/skipped/partial；
  //   · `rl/src/core.mjs` 的 `summarize()` 不再手列字段丢掉它们（补 `...integrityOf(...)`）。
  // **但分类暂不移入 `INSTRUMENTED`**，理由是本仓库自己定的顺序：
  //   "先修生产者、再移分类"——移完分类后，**已落盘的旧 rl 摘要**会在
  //   `integrity-coverage.mjs` 上变成过渡性红（拿新分类去判旧产物），
  //   而旧产物不可重造（它记录的是当时那次测量的真实形态）。
  // ⇒ **触发条件**：下一次 rl `validate` 产出带证据的摘要后，把这两个键移入 `INSTRUMENTED`
  //    并同步收紧 rl 的持久化夹具。届时 CI 自然变绿，不需要任何宽容度调整。
  const KNOWN_OTHER = ['uniform', 'preference', 'prefTrain', 'crossPlugin']
  // **元字段**（不是测量部件）：`attachIntegrity` 会往摘要里塞 `integrity`，
  // 若把它当"未归类部件"就会被自己加的证据判为不可复用（自相矛盾）。
  const META = ['integrity', 'invalid', 'invalidReason', 'protocol', 'producedBy', 'checkedAt']
  // 理由词表（与 `gen-contracts.mjs` 的文档逐字一致）：
  //   missing / marked-invalid:… / <part>:no-integrity-evidence / <part>:failed=N/M /
  //   <part>:partial / no-instrumented-parts / unclassified-part:<k>
  const parts = []
  let seen = 0
  for (const k of Object.keys(m)) {
    if (INSTRUMENTED.includes(k)) {
      seen += 1
      const snap = m[k]
      if (!snap || typeof snap !== 'object') { parts.push(`${k}:no-integrity-evidence`); continue }
      if (typeof snap.attempted !== 'number' || typeof snap.failed !== 'number') { parts.push(`${k}:no-integrity-evidence`); continue }
      if (snap.failed > 0) parts.push(`${k}:failed=${snap.failed}/${snap.attempted}`)
      if (snap.partial === true) parts.push(`${k}:partial`)
    } else if (META.includes(k)) {
      // 元字段：不属于测量部件
    } else if (KNOWN_OTHER.includes(k)) {
      // 已知但**不是**逐条网络测量：各自的失败语义不同（例如 `uniform` 失败本身就是"不成立"），
      // 不在此处要求 attempted/failed。
    } else {
      // 未归类部件 ⇒ fail-closed 并**点名**（静默跳过等于把它当成不存在）
      parts.push(`unclassified-part:${k}`)
    }
  }
  if (seen === 0) return { complete: false, reason: 'no-instrumented-parts' }
  return parts.length === 0 ? { complete: true, reason: null } : { complete: false, reason: parts.join(', ') }
}

/** 给将要写入缓存的测量摘要**附上完整性证据**（供日后判定可否复用）。 */
export function attachIntegrity(m) {
  const snap = (x) => (x && typeof x === 'object'
    ? { attempted: x.attempted ?? null, succeeded: x.succeeded ?? null, failed: x.failed ?? null, partial: x.partial ?? null }
    : null)
  return { ...m, integrity: { lm: snap(m?.lm), mmlu: snap(m?.mmlu), checkedAt: new Date().toISOString() } }
}

/** 均匀签名（用端点 logprobs）—— "模型确实参与前向"的测量有效性前置闸门。 */
export async function evalUniform({ endpoint, model, prompt, vocabSize, runs = 3 }) {
  const vals = []
  const perRun = []
  for (let i = 0; i < runs; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const res = await post(endpoint, '/v1/completions', { model, prompt, max_tokens: 32, temperature: 0, seed: 0, logprobs: 1 })
    const lp = res.json?.choices?.[0]?.logprobs?.token_logprobs ?? []
    const nums = lp.filter((x) => typeof x === 'number')
    if (nums.length) { vals.push(...nums); perRun.push(JSON.stringify(nums)) }
  }
  if (vals.length < 4) return { ok: false, reason: `有效 logprob 不足（${vals.length} < 4）`, n: vals.length }
  const nll = vals.map((v) => -v)
  const sig = uniformSignature({ meanNll: meanNllFromLogprobs(vals), perTokenNll: nll, vocabSize })
  return { ...sig, ok: sig.uniform === false, runs: perRun.length, bitIdenticalAcrossRuns: new Set(perRun).size === 1, criterion: sig.criterion }
}

/* ══════════════════════════════════ 遗忘门禁 ══════════════════════════════════ */

/** 允许的候选侧标签。**逐插件命名被参数化**，而不是四份代码（合并前 sft/pt/rl 各一份）。 */
export const FORGETTING_SIDES = Object.freeze(['sft', 'pt', 'rl'])

/**
 * 灾难性遗忘门禁（两条**可推导**判据，z 由调用方给定，单侧；默认 1.96）。
 *
 * - MMLU 准确率：Δ = acc_base − acc_cand；SE = sqrt(p1(1−p1)/n1 + p2(1−p2)/n2)；通过 ⟺ Δ ≤ z·SE
 * - wikitext 逐文本 NLL：**配对**比较；Δ = mean(nll_cand − nll_base)；SE = std(差)/√n；通过 ⟺ Δ ≤ z·SE
 *
 * ## 参数化后的调用约定（**向后兼容**：四个插件原来的参数名一字未改）
 *   候选侧的键名就是标签：`sftMmlu`/`sftLm`、`ptMmlu`/`ptLm`、`rlMmlu`/`rlLm`。
 *   只给一侧 ⇒ 自动识别；同时给多侧 ⇒ **抛错**（一次判定只能有一个候选主体），
 *   也可以用 `side: 'pt'` 显式指定。基座侧恒为 `baseMmlu`/`baseLm`。
 *
 * 返回对象的**字段名**跟着标签走（`{sftAcc}` / `{ptAcc}` / `{rlAcc}`、
 * `{sftNll}` / `{pplPt}` …），与合并前的三份实现逐字相同 —— 产物与报告不受影响。
 *
 * 缺陷 14：先判"**测量成立**"，而且必须**基于 attempted** 判 ——
 * 旧实现只看 `n`（= succeeded），于是仪器故障会被当成小样本静态通过。
 *
 * @returns {{pass:boolean, z:number, mmlu:object|null, lm:object|null, reasons:string[]}}
 */
export function forgettingGate(args = {}) {
  const { baseMmlu, baseLm, z = 1.96, minPaired = 30 } = args
  let side = args.side ?? null
  if (side === null) {
    const present = FORGETTING_SIDES.filter((s) => Object.prototype.hasOwnProperty.call(args, `${s}Mmlu`) || Object.prototype.hasOwnProperty.call(args, `${s}Lm`))
    if (present.length === 0) {
      throw new Error('E_FORGETTING_GATE_NO_SIDE: forgettingGate 需要恰好一侧候选测量（sftMmlu/sftLm、ptMmlu/ptLm 或 rlMmlu/rlLm），或用 side="sft"|"pt"|"rl" 显式指定 —— 缺失时不得凭默认侧给出结论')
    }
    if (present.length > 1) {
      throw new Error(`E_FORGETTING_GATE_AMBIGUOUS_SIDE: 同时给了 ${present.join('/')} 多侧候选测量 —— 一次判定只能有一个候选主体（或用 side=… 显式指定）`)
    }
    side = present[0]
  }
  const candMmlu = args[`${side}Mmlu`]
  const candLm = args[`${side}Lm`]
  const reasons = []

  const mmluFailed = { base: baseMmlu?.failed ?? 0, [side]: candMmlu?.failed ?? 0 }
  const lmFailed = { base: baseLm?.failed ?? 0, [side]: candLm?.failed ?? 0 }
  const mmluAttempted = { base: baseMmlu?.attempted ?? baseMmlu?.n ?? 0, [side]: candMmlu?.attempted ?? candMmlu?.n ?? 0 }
  const lmAttempted = { base: baseLm?.attempted ?? (baseLm?.perText?.length ?? 0), [side]: candLm?.attempted ?? (candLm?.perText?.length ?? 0) }

  // ① MMLU 准确率：两比例差的 SE
  let mmlu = null
  if (mmluFailed.base > 0 || mmluFailed[side] > 0) {
    reasons.push(`MMLU **测量不完整**（仪器层失败 base failed=${mmluFailed.base}/attempted=${mmluAttempted.base}、${side} failed=${mmluFailed[side]}/attempted=${mmluAttempted[side]}）⇒ 无法判定（**未通过**）`)
  } else if (baseMmlu?.n > 0 && candMmlu?.n > 0) {
    const p1 = baseMmlu.accuracy; const p2 = candMmlu.accuracy
    const se = Math.sqrt((p1 * (1 - p1)) / baseMmlu.n + (p2 * (1 - p2)) / candMmlu.n)
    const delta = p1 - p2
    const bound = z * se
    mmlu = {
      baseAcc: p1, [`${side}Acc`]: p2, delta, se, bound, pass: delta <= bound,
      n: { base: baseMmlu.n, [side]: candMmlu.n }, attempted: mmluAttempted, failed: mmluFailed,
    }
    if (!mmlu.pass) reasons.push(`MMLU 准确率出现统计显著退化：Δ=${delta.toFixed(4)} > ${bound.toFixed(4)}（z·SE，z=${z}）`)
  } else { reasons.push('MMLU 样本不足，无法判定（**未通过**，不是"没问题"）') }

  // ② wikitext 逐文本 NLL：**配对**比较
  //    配对必须按**成功行的原始下标交集**，不能按数组位置 ——
  //    否则一侧跳过第 k 行会让其后**每一对都错位**（缺陷 14 附带修）。
  let lm = null
  const hasIdx = Array.isArray(baseLm?.okIndices) && Array.isArray(candLm?.okIndices)
  let pairs
  if (hasIdx) {
    const bMap = new Map(baseLm.okIndices.map((ix, k) => [ix, baseLm.perText[k]]))
    const cMap = new Map(candLm.okIndices.map((ix, k) => [ix, candLm.perText[k]]))
    pairs = [...bMap.keys()].filter((ix) => cMap.has(ix)).map((ix) => [bMap.get(ix), cMap.get(ix)])
  } else {
    // 向后兼容：旧产物/缓存里没有 okIndices ⇒ 退化为按位置配对（**并在报告里标明**）
    const n0 = Math.min(baseLm?.perText?.length ?? 0, candLm?.perText?.length ?? 0)
    pairs = Array.from({ length: n0 }, (_, i) => [baseLm.perText[i], candLm.perText[i]])
  }
  const n = pairs.length
  if (lmFailed.base > 0 || lmFailed[side] > 0) {
    reasons.push(`wikitext **测量不完整**（仪器层失败 base failed=${lmFailed.base}/attempted=${lmAttempted.base}、${side} failed=${lmFailed[side]}/attempted=${lmAttempted[side]}）⇒ 无法判定（**未通过**）`)
  } else if (n >= minPaired) {
    const diffs = pairs.map(([b, s]) => s - b)
    const d = mean(diffs); const se = stddev(diffs) / Math.sqrt(n)
    const bound = z * se
    lm = {
      baseNll: baseLm.meanNll, [`${side}Nll`]: candLm.meanNll, deltaNll: d, se, bound, pass: d <= bound, n,
      pplBase: baseLm.ppl, [`ppl${side[0].toUpperCase()}${side.slice(1)}`]: candLm.ppl,
      attempted: lmAttempted, failed: lmFailed,
      pairedOn: hasIdx ? 'okIndices-intersection' : 'positional-legacy',
    }
    if (!lm.pass) reasons.push(`wikitext NLL 出现统计显著退化：Δ=${d.toFixed(4)} > ${bound.toFixed(4)}（z·SE，n=${n}）`)
  } else { reasons.push(`wikitext 配对样本不足（n=${n} < ${minPaired}），无法判定（**未通过**）`) }

  return { pass: Boolean(mmlu?.pass) && Boolean(lm?.pass), z, mmlu, lm, reasons }
}
