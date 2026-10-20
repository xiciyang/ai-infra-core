/**
 * @xiciyang/audit-core —— append-only 审计哈希链 v0
 * （契约冻结于 2026-09-28 长任务 1 / 阶段 B）。
 *
 * 这个库存在的理由：这台机器上**已经有四条独立的哈希链实现**
 * （inference-serving / quantization / tuning / inference-diagnose 各一份），
 * 它们靠"人工抄同算法"保持一致。共享库把算法冻成**一处**，
 * 并由契约测试拿**线上真实审计文件**复算 —— 这是"仪表必须与源码对齐"的直接落地。
 *
 * v0 冻结的导出面（major 变更须暂停报告；minor 允许追加）：
 *   CONTRACT_VERSION, GENESIS, schemaFor(pkg)
 *   sha256(input), canonicalJson(value)
 *   auditFileFor({dir,pkg,date}), auditDirFor({root,pkg})
 *   appendAudit({dir, pkg, pkgVersion, entry, date})
 *   readAudit({dir, pkg, date, limit})
 *   verifyChain({dir, pkg, date}), verifyAllChains({dir}), listShards({dir})
 *   digestArgs(args)
 *
 * **本库不做的事**（v0 明确排除）：
 *   - 不管"该记什么字段"（业务字段由调用方给；本库只保证链与只追加）
 *   - 不做日志轮转/压缩（分片按日期天然切分，轮转属运营）
 *   - 不引入运行时依赖
 *
 * 链口径 —— **实测发现：四个插件不是一个算法，是两个**（2026-09-28 本契约测试查出）：
 *
 *   variant `canonical-json`          hash = sha256(canonicalJson(record 去掉 hash))
 *                                     └ 使用者：inference-tuning · inference-diagnose
 *   variant `prevhash-canonical-json` hash = sha256(prevHash + "\n" + canonicalJson(record 去掉 hash))
 *                                     └ 使用者：inference-serving · inference-quantization
 *
 * 两者**各自内部自洽**（都能验自己的链），但同名同目录同格式却用不同的哈希函数 ——
 * 这意味着"拿一个通用校验器验全部四份链"在不传 variant 时**必然失败**。
 * 本条不是推测：用 audit-core 独立复算四个插件的线上分片，不指定 variant 时
 * serving/quantization 的每一条都报"内容被改动"（`tests/contract.mjs` 的线上复算断言就是证据）。
 *
 * v0 的处置（**不掩盖差异，把它钉住**）：
 *   - 两个 variant 都实现，注册在 `CHAIN_VARIANTS`，默认 `canonical-json`；
 *   - `verifyChain` 默认 **autoDetect**：先按每个 variant 试算第一条，再整链复算，
 *     并把 `variant` 写进返回值 —— 于是"这条链用的是哪个算法"本身成为可审计的事实；
 *   - 契约测试断言**每个插件在线的链都能被复算**，且检出的 variant 与登记表一致
 *     （variant 若被谁改掉，测试立刻红）。
 *
 * 其余口径（两 variant 相同）：
 *   每条带 prevHash（同文件上一条的 hash）；首条 prevHash = "0"×64
 *   每日期一分片，**分片之间各自独立成链**
 *   只追加：O_APPEND + 文件模式 0600
 */

import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'

export const CONTRACT_VERSION = '0.1.1'   // LONGTASK5: patch —— appendAudit 串行化（bug fix，接口面未变）
export const GENESIS = '0'.repeat(64)
/** 已知的链命名空间（新增一个包须显式加进来 —— 让"忘了登记"可被发现）。 */
// **LONGTASK5 阶段 1 补**：此前只登记推理侧 4 个包 ⇒ 训练侧 4 条链**从未被复算过**，
// 于是 training-qat 的链在 14:32 已经断了，而"线上链复算"却一直绿。
// 这不是"检查通过"，是"没检查"。四个训练包现在一并登记。
export const KNOWN_PACKAGES = Object.freeze([
  'inference-serving', 'inference-quantization', 'inference-tuning', 'inference-diagnose',
  'training-sft', 'training-pretrain', 'training-rl', 'training-qat',
])

/**
 * 链算法变体登记表。`usedBy` 是**实测**结论（用本库独立复算各包线上分片得出），不是文档口径。
 * 新增一个包时若两个 variant 都验不过，说明它用了第三种算法 —— 契约测试会红，必须显式登记。
 */
export const CHAIN_VARIANTS = Object.freeze({
  'canonical-json': {
    id: 'canonical-json',
    description: 'hash = sha256(canonicalJson(record 去掉 hash))',
    usedBy: Object.freeze(['inference-tuning', 'inference-diagnose',
      // LONGTASK5：训练侧四包**实测**为 canonical-json（此前从未被复算，故从未登记）
      'training-sft', 'training-pretrain', 'training-rl', 'training-qat']),
  },
  'prevhash-canonical-json': {
    id: 'prevhash-canonical-json',
    description: 'hash = sha256(prevHash + "\\n" + canonicalJson(record 去掉 hash))',
    usedBy: Object.freeze(['inference-serving', 'inference-quantization']),
  },
})
export const DEFAULT_VARIANT = 'canonical-json'
export const VARIANT_IDS = Object.freeze(Object.keys(CHAIN_VARIANTS))

/** 按变体算一条记录（去掉 hash 字段后）的哈希。 */
export function hashOfBody(body, variant = DEFAULT_VARIANT) {
  if (!CHAIN_VARIANTS[variant]) throw new Error(`未知链变体：${variant}（允许：${VARIANT_IDS.join(', ')}）`)
  if (variant === 'prevhash-canonical-json') return sha256(`${body.prevHash}\n${canonicalJson(body)}`)
  return sha256(canonicalJson(body))
}

/** 从一条记录反推它用的是哪个变体；都不匹配则返回 null（= 第三种算法，必须显式登记）。 */
export function detectVariant(record) {
  const { hash, ...body } = record
  for (const v of VARIANT_IDS) if (hashOfBody(body, v) === hash) return v
  return null
}

export function schemaFor(pkg) {
  if (!pkg) throw new Error('schemaFor 需要 pkg 名')
  return `${pkg}/audit@1`
}

export function sha256(input) {
  return createHash('sha256').update(input).digest('hex')
}

/** 稳定序列化：对象键排序后序列化 —— 键序不稳定会让同一次调用算出两个不同的哈希。 */
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

export function auditDirFor({ root, pkg }) {
  if (!root || !pkg) throw new Error('auditDirFor 需要 { root, pkg }')
  return join(root, 'logs', 'audit', pkg)
}

export function auditFileFor({ root, pkg, date = new Date() }) {
  const day = (date instanceof Date ? date : new Date(date)).toISOString().slice(0, 10)
  return join(auditDirFor({ root, pkg }), `${day}.jsonl`)
}

async function readText(p, fallback = null) {
  try {
    return await fs.readFile(p, 'utf8')
  } catch (err) {
    if (err && err.code === 'ENOENT') return fallback
    throw err
  }
}

async function appendLine(p, line) {
  await fs.mkdir(dirname(p), { recursive: true, mode: 0o700 })
  const fh = await fs.open(p, 'a', 0o600)
  try {
    const buf = Buffer.from(line.endsWith('\n') ? line : `${line}\n`, 'utf8')
    await fh.write(buf)
    return buf.length
  } finally {
    await fh.close()
  }
}

async function lastHashOf(file) {
  const raw = await readText(file, null)
  if (!raw) return GENESIS
  const lines = raw.split('\n').filter((l) => l.trim() !== '')
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const rec = JSON.parse(lines[i])
      if (typeof rec.hash === 'string') return rec.hash
    } catch { /* 跳过损坏行：损坏由 verifyChain 负责报告 */ }
  }
  return GENESIS
}

/** 参数摘要：**只**产出 sha256 与键名列表，绝不返回原文（明文纪律）。 */
export function digestArgs(args) {
  const a = args && typeof args === 'object' ? args : {}
  return { argsDigest: `sha256:${sha256(canonicalJson(a))}`, argsKeys: Object.keys(a).sort() }
}

/**
 * 追加一条审计记录。
 * @returns {Promise<{file, seq, hash, prevHash, auditId}>}
 */
/**
 * 审计链写锁（**LONGTASK5 阶段 1 修的真实缺陷**）。
 *
 * ## 修的是什么
 * `appendAudit` 原来是 `读头 → 算 prevHash/seq → 追加` 三步，**中间没有串行化**。
 * 两个并发写者会各自读到同一个头，各自算出一个"合法"的 prevHash，然后**都追加成功**
 * —— 后写的那条 prevHash 指向的是**上上条**，链在验证时断在该位置。
 *
 * 实测证据（`~/.ai-infra/logs/audit/training-qat/2026-09-29.jsonl`）：
 * ```
 * #21 ts=14:32:10.813Z hash=45fca143b0 prev=c48d5ed463   ← #20 的 hash
 * #22 ts=14:32:10.814Z hash=1650c38575 prev=c48d5ed463   ← 同 1ms，prev 仍是 #20
 * ```
 * `verifyChain` 报 `brokenAt: 22 / "第 22 条的 prevHash 与上一条的 hash 不符"`。
 *
 * ## 为什么是"文件锁"而不是 state-core 那种 CAS
 * `state-core` 拒用 flock 的理由是"整份文档的读-改-写，CAS on content hash 就够"。
 * 审计链是**追加型**：必须让"头"在 `读头 → 追加` 这段里保持稳定，CAS 换不来这个保证
 * （CAS 只能事后发现冲突，而那时错行**已经落盘**）。
 * 故用 `O_EXCL` 建锁文件（可移植、不依赖 flock 语义），**只在毫秒级临界区内持锁**。
 * 陈旧锁（写者崩溃）按 mtime 超时接管，避免死锁。
 */
const AUDIT_LOCK_STALE_MS = 10_000

async function withAuditLock(file, fn) {
  const lock = `${file}.lock`
  await fs.mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const deadline = Date.now() + AUDIT_LOCK_STALE_MS
  for (;;) {
    let fh = null
    try {
      fh = await fs.open(lock, 'wx', 0o600)   // O_EXCL：只有一个写者能拿到
      try { return await fn() } finally {
        await fh.close().catch(() => {})
        await fs.unlink(lock).catch(() => {})
      }
    } catch (e) {
      if (fh) { await fh.close().catch(() => {}); throw e }
      if (e?.code !== 'EEXIST') throw e
      // 陈旧锁接管：写者崩溃时锁文件会留在盘上
      try {
        const st = await fs.stat(lock)
        if (Date.now() - st.mtimeMs > AUDIT_LOCK_STALE_MS) { await fs.unlink(lock).catch(() => {}); continue }
      } catch { continue }
      if (Date.now() > deadline) throw new Error(`E_AUDIT_LOCK_TIMEOUT: 未能在 ${AUDIT_LOCK_STALE_MS}ms 内取得审计链写锁（${lock}）`)
      await new Promise((r) => setTimeout(r, 2 + Math.random() * 3))
    }
  }
}

export async function appendAudit({ root, pkg, pkgVersion = '0.0.0', entry = {}, date = new Date(), variant = DEFAULT_VARIANT } = {}) {
  if (!root || !pkg) throw new Error('appendAudit 需要 { root, pkg }')
  const file = auditFileFor({ root, pkg, date })
  // **读头 → 算 hash → 追加** 必须在同一个锁内完成，否则并发写者会用同一个头各写一条。
  return await withAuditLock(file, async () => {
    const prevHash = await lastHashOf(file)
    const raw = await readText(file, null)
    const seq = raw ? raw.split('\n').filter((l) => l.trim() !== '').length + 1 : 1
    const body = {
      schema: schemaFor(pkg),
      seq,
      ts: new Date().toISOString(),
      pkg,
      pkgVersion,
      ...entry,
      prevHash,
    }
    const hash = hashOfBody(body, variant)
    await appendLine(file, JSON.stringify({ ...body, hash }))
    return { file, seq, hash, prevHash, auditId: `aud_${hash.slice(0, 12)}`, variant }
  })
}

export async function readAudit({ root, pkg, date = new Date(), limit = 0 } = {}) {
  const file = auditFileFor({ root, pkg, date })
  const raw = await readText(file, null)
  if (!raw) return { file, records: [], parseErrors: 0 }
  const records = []
  let parseErrors = 0
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    try { records.push(JSON.parse(line)) } catch { parseErrors += 1 }
  }
  return { file, records: limit > 0 ? records.slice(-limit) : records, parseErrors }
}

/**
 * 复算整链。任何一条被改动、删除、重排都会失败。
 *
 * `variant` 省略时自动识别（拿第一条试算 `CHAIN_VARIANTS` 里的每个变体），
 * 识别结果写进返回值 —— 于是"这条链用的是哪个算法"成为可审计的事实，
 * 而不是调用方必须事先知道的默契。
 *
 * @returns {{ok, checked, brokenAt, reason, parseErrors, file, variant, head?}}
 */
export async function verifyChain({ root, pkg, date = new Date(), variant = null } = {}) {
  const { file, records, parseErrors } = await readAudit({ root, pkg, date })
  if (parseErrors > 0) {
    return { ok: false, checked: records.length, brokenAt: null, reason: `${parseErrors} 行不是合法 JSON（记录被破坏或截断）`, parseErrors, file, variant }
  }
  let v = variant
  if (v === null) {
    if (records.length === 0) return { ok: true, checked: 0, brokenAt: null, reason: null, parseErrors, file, variant: null, head: GENESIS }
    v = detectVariant(records[0])
    if (v === null) {
      return { ok: false, checked: records.length, brokenAt: 1, reason: '第 1 条不匹配任何已登记的链变体（第三种算法？必须在 CHAIN_VARIANTS 里显式登记）', parseErrors, file, variant: null }
    }
  }
  let prev = GENESIS
  for (let i = 0; i < records.length; i += 1) {
    const { hash, ...body } = records[i]
    if (body.prevHash !== prev) {
      return { ok: false, checked: records.length, brokenAt: i + 1, reason: `第 ${i + 1} 条的 prevHash 与上一条的 hash 不符（链断了）`, parseErrors, file, variant: v }
    }
    if (hashOfBody(body, v) !== hash) {
      return { ok: false, checked: records.length, brokenAt: i + 1, reason: `第 ${i + 1} 条内容被改动（按变体 ${v} 重算不一致）`, parseErrors, file, variant: v }
    }
    prev = hash
  }
  return { ok: true, checked: records.length, brokenAt: null, reason: null, parseErrors, file, variant: v, head: prev }
}

/**
 * **动态发现**所有存在审计链的包（LONGTASK5 裁决 ③）。
 *
 * ## 为什么必须有它（而不是维护一份名单）
 * 原来 `KNOWN_PACKAGES` 是硬编码的 4 个推理侧包。训练侧四个包上线后**没人想起来加**，
 * 于是它们的链**从未被复算** —— `training-qat` 的链在 14:32 就断了，而"线上链复算"一直绿。
 * 补成 8 个只是**症状修复**：下一个新包仍会重演。
 *
 * 根因修复是**让覆盖范围由现场决定**：审计目录下**有链的包**就应该被复算。
 * 这样"新插件加入"自动纳入覆盖，不再依赖谁记得改名单。
 *
 * `KNOWN_PACKAGES` 仍保留（作为"历史上存在过、可能暂时没有当日分片"的补充），
 * 但**覆盖判定以本函数的返回为准**。
 */
export async function discoverChainPackages({ root } = {}) {
  if (!root) throw new Error('discoverChainPackages 需要 { root }')
  const base = join(root, 'logs', 'audit')
  let entries = []
  try { entries = await fs.readdir(base, { withFileTypes: true }) } catch (err) {
    if (err && err.code === 'ENOENT') return []
    throw err
  }
  const out = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    let files = []
    // eslint-disable-next-line no-await-in-loop
    try { files = await fs.readdir(join(base, e.name)) } catch { continue }
    if (files.some((f) => f.endsWith('.jsonl'))) out.push(e.name)
  }
  return out.sort()
}

export async function listShards({ root, pkg } = {}) {
  try {
    const files = await fs.readdir(auditDirFor({ root, pkg }))
    return files.filter((f) => f.endsWith('.jsonl')).sort()
  } catch (err) {
    if (err && err.code === 'ENOENT') return []
    throw err
  }
}

/** 校验所有日期分片（跨文件不建链，各自独立成链）。 */
export async function verifyAllChains({ root, pkg } = {}) {
  const shards = await listShards({ root, pkg })
  const results = []
  for (const f of shards) {
    const day = f.replace(/\.jsonl$/, '')
    // eslint-disable-next-line no-await-in-loop
    const r = await verifyChain({ root, pkg, date: new Date(`${day}T00:00:00Z`) })
    results.push({ day, ...r })
  }
  return { ok: results.every((r) => r.ok), schema: schemaFor(pkg), shards: results.length, results }
}
