/**
 * @xiciyang/data-core —— 数据集原语 v0（契约冻结于 2026-09-28 长任务 1 / 阶段 B）。
 *
 * 这个库存在的理由：`inference_quantization_dataset_prepare` 已经有一套
 * "内容哈希去重 + 确定性切分 + 去泄漏复核 + 血缘"语义，训练侧必须与它**同口径** ——
 * 否则"校准集与测试集不重叠"这句保证在两侧含义不同。v0 把它冻成共享接口。
 *
 * v0 冻结的导出面（major 变更须暂停报告；minor 允许追加）：
 *   CONTRACT_VERSION
 *   contentHash(text), canonicalRecord(rec), recordHash(rec)
 *   dedupByContent(records, {keyOf})
 *   splitDeterministic(records, {seed, calib, test, keyOf})
 *   assertNoLeakage(calib, test, {keyOf})
 *   lineage({source, revision, seed, calib, test})
 *   piiScan(text) / PII_PATTERNS
 *
 * **本库不做的事**（v0 明确排除）：
 *   - 不下载数据集、不读网络（那是 inference-quantization 的 dataset_prepare 的职责）
 *   - 不做分词/截断（属训练脚本）
 *   - 不引入零依赖之外的任何东西
 *
 * 切分的确定性口径：排序键 = `sha256(seed + '\u0000' + keyOf(rec))` 的十六进制字典序。
 * 用**内容**而不是下标做键 —— 下标在数据集版本变化时会整体错位，
 * 让"同一 seed 得到同一集合"这句承诺失效。
 */

import { createHash } from 'node:crypto'

export const CONTRACT_VERSION = '0.1.0'

export function contentHash(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex')
}

/**
 * 记录的规范化形态：仅保留稳定字段，键序固定。
 * 为什么必须规范化：同一条记录因键序不同会算出不同哈希 → 去重与去泄漏双双失效。
 */
export function canonicalRecord(rec) {
  if (rec === null || typeof rec !== 'object') return rec
  if (Array.isArray(rec)) return rec.map(canonicalRecord)
  const out = {}
  for (const k of Object.keys(rec).sort()) {
    if (rec[k] === undefined) continue
    out[k] = canonicalRecord(rec[k])
  }
  return out
}

/** 记录哈希（内容寻址）= sha256(规范化 JSON)。默认取整条记录；可用 keyOf 只取某字段。 */
export function recordHash(rec, keyOf = null) {
  const v = keyOf ? keyOf(rec) : canonicalRecord(rec)
  const text = typeof v === 'string' ? v : JSON.stringify(canonicalRecord(v))
  return contentHash(text)
}

/**
 * 按内容哈希去重（**保序**：保留首次出现的顺序）。
 * @returns {{kept:any[], dropped:any[], hashes:string[]}}
 */
export function dedupByContent(records, { keyOf = null } = {}) {
  if (!Array.isArray(records)) throw new Error('records 必须是数组')
  const seen = new Set()
  const kept = []
  const dropped = []
  const hashes = []
  for (const rec of records) {
    const h = recordHash(rec, keyOf)
    if (seen.has(h)) { dropped.push({ rec, hash: h, reason: 'duplicate-content' }); continue }
    seen.add(h)
    hashes.push(h)
    kept.push(rec)
  }
  return { kept, dropped, hashes }
}

/**
 * 确定性切分（同一输入 + 同一 seed ⇒ 逐条相同的两个集合）。
 * @returns {{calib:any[], test:any[], seed:number, hash:string, counts:object}}
 */
export function splitDeterministic(records, { seed = 20260923, calib = 128, test = 400, keyOf = null } = {}) {
  if (!Array.isArray(records)) throw new Error('records 必须是数组')
  const n = records.length
  if (!Number.isInteger(calib) || !Number.isInteger(test) || calib < 0 || test < 0) throw new Error('calib/test 必须是非负整数')
  if (calib + test > n) throw new Error(`样本不足：需要 ${calib}+${test}，实际 ${n}（不足时不得静默缩小切分）`)
  const tagged = records.map((rec, i) => ({ rec, i, k: createHash('sha256').update(`${seed}\u0000${recordHash(rec, keyOf)}`).digest('hex') }))
  tagged.sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : a.i - b.i))
  const picked = tagged.slice(0, calib + test)
  const calibSet = picked.slice(0, calib).map((x) => x.rec)
  const testSet = picked.slice(calib).map((x) => x.rec)
  return {
    calib: calibSet,
    test: testSet,
    seed,
    hash: contentHash(JSON.stringify({ seed, calib, test, keys: picked.map((x) => x.k) })),
    counts: { input: n, calib: calibSet.length, test: testSet.length, unused: n - calib - test },
  }
}

/**
 * 去泄漏：两个集合的内容哈希交集必须为空。
 * @returns {{ok:boolean, intersection:string[], calibOnly:number, testOnly:number}}
 */
export function assertNoLeakage(calib, test, { keyOf = null } = {}) {
  const h = (arr) => new Set(arr.map((r) => recordHash(r, keyOf)))
  const a = h(calib)
  const b = h(test)
  const intersection = [...a].filter((x) => b.has(x))
  return { ok: intersection.length === 0, intersection, calibOnly: a.size, testOnly: b.size }
}

/** 血缘（来源 / revision / 种子 / 两侧计数与哈希）。 */
export function lineage({ source, revision = null, seed, calib, test, extra = {} } = {}) {
  if (!source) throw new Error('lineage 需要 source')
  return {
    schema: 'ai-infra/lineage@1',
    source,
    revision,
    seed: seed ?? null,
    generatedAt: new Date().toISOString(),
    calib: { count: calib?.length ?? 0, hash: `sha256:${contentHash(JSON.stringify(calib ? calib.map((r) => recordHash(r)) : []))}` },
    test: { count: test?.length ?? 0, hash: `sha256:${contentHash(JSON.stringify(test ? test.map((r) => recordHash(r)) : []))}` },
    ...extra,
  }
}

/* ------------------------------------------------------------------ PII */
/**
 * PII 模式表（**保守**：宁可多报也不漏报；命中即由调用方停下报告，不由本库自行脱敏）。
 *
 * 为什么本库**不**提供"自动脱敏"：Step 0 的纪律是"发现 PII → 暂停报告并记录字段，
 * **不自行脱敏后继续**"。提供一个自动脱敏函数就是在邀请那条被禁止的路径。
 *
 * **每条模式都必须带 `validate`（校验器），不能只靠正则** —— 这是 2026-09-28 本机实测教训：
 * 首版只有正则，`cn-idcard`（`\d{17}[\dXx]`）把数据里自带的 **sha256 内容哈希**（64 位十六进制）
 * 当成了身份证号（十六进制串里很容易出现 18 个连续数字字符）。
 * 这种假阳性会让"PII 检查"变成噪声源 —— **假阳性与假阴性一样会让门禁失去意义**。
 * 校验器是可推导的（身份证有 ISO 7064 校验位；IPv4 每个八位组 ≤255），不是宽容度调参。
 */
export const PII_PATTERNS = Object.freeze([
  { id: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, validate: null },
  { id: 'cn-mobile', re: /(?<!\d)1[3-9]\d{9}(?!\d)/g, validate: null },
  { id: 'cn-idcard', re: /(?<![0-9A-Fa-f])\d{17}[\dXx](?![0-9A-Fa-f])/g, validate: validateCnIdCard },
  { id: 'ipv4', re: /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g, validate: validateIpv4 },
  { id: 'phone-intl', re: /\+\d{1,3}[ -]?\d{6,14}/g, validate: null },
  { id: 'bearer-token', re: /\b(?:sk|ghp|gho|xox[baprs])-?[A-Za-z0-9_-]{16,}\b/g, validate: null },
])

/** 中国居民身份证校验：ISO 7064:1983 MOD 11-2 校验位 + 出生日期可解析。 */
export function validateCnIdCard(s) {
  const t = String(s).toUpperCase()
  if (!/^\d{17}[\dX]$/.test(t)) return false
  const W = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]
  const CODE = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2']
  let sum = 0
  for (let i = 0; i < 17; i += 1) sum += Number(t[i]) * W[i]
  if (CODE[sum % 11] !== t[17]) return false
  const y = Number(t.slice(6, 10)); const m = Number(t.slice(10, 12)); const d = Number(t.slice(12, 14))
  if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return false
  return true
}

/** IPv4 校验：四个八位组都 ≤255（`999.1.1.1` 不是地址，是版本号/编号的一种写法）。 */
export function validateIpv4(s) {
  const parts = String(s).split('.')
  if (parts.length !== 4) return false
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
}

/** 扫描文本里的 PII。返回**命中位置与模式 id**，不返回"脱敏后的文本"。 */
export function piiScan(text) {
  const s = String(text ?? '')
  const findings = []
  let suppressed = 0
  for (const { id, re, validate } of PII_PATTERNS) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(s)) !== null) {
      if (validate && !validate(m[0])) suppressed += 1
      else findings.push({ pattern: id, index: m.index, length: m[0].length, sampleHash: `sha256:${contentHash(m[0]).slice(0, 16)}` })
      if (m.index === re.lastIndex) re.lastIndex += 1
    }
  }
  return { count: findings.length, findings, suppressed, patterns: PII_PATTERNS.map((p) => p.id) }
}
