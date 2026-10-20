/**
 * @xiciyang/state-core —— 共享状态方言 / schema 校验 / 原子写 / 乐观并发 v0
 * （契约冻结于 2026-09-28 长任务 1 / 阶段 B）。
 *
 * 这个库存在的理由（NEXT_STEPS §3.3）：
 *   三个推理插件**各写了一份 `src/util/yaml.mjs`**（312 行，几乎逐字相同），
 *   靠 `inference-contracts` 的 C1–C5 才没有漂移成三种方言。
 *   共享库是这三份实现的最终归宿。
 *
 * v0 冻结的导出面（major 变更须暂停报告；minor 允许追加）：
 *   YamlError, parse, stringify, parseFile        ← **与三个插件 yaml.mjs 的导出集合逐一对应**
 *   validateAgainstSchema(doc, schema)            ← 与 inference-contracts/checks 同一套语义
 *   atomicWrite(file, text), readText, appendLine, mkdirp
 *   contentHash(text), withOptimisticWrite(...)
 *
 * **本库不做的事**（v0 明确排除）：
 *   - 不引入任何运行时依赖（零依赖是硬约束；沿用原实现自带的受限 YAML 子集，不引 yaml 库）
 *   - 不引入文件锁（见下"并发"一节的裁决）
 *
 * 并发写入的裁决（报告要求第 8 项）：**乐观并发（compare-and-swap on content hash）+ 原子写**，
 * **不加文件锁**。理由（本机实测得出）：
 *   三插件现状是"atomicWrite（同目录 tmp + rename）"，即"原子但最后写者胜"。
 *   加 flock 会引入跨 NFS/容器挂载的行为差异，而这三个包真正的并发场景是
 *   **同一插件的一次运行内串行写**；跨插件并发写同一文件在语义上本就是冲突，该被**检出**而不是排队。
 *   故 v0 提供 `withOptimisticWrite(file, mutator, {expectedHash})`：
 *   读 → 比对期望哈希 → 变 → 原子写；哈希不符即抛 `ERR_STATE_CONFLICT`。
 *   需要排队语义的调用方自己重试（重试策略属调用方，不属编解码层）。
 */

import { promises as fs } from 'node:fs'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'

export { YamlError, parse, stringify, parseFile } from './dialect.mjs'
import { parse as _parse } from './dialect.mjs'

/** 本库契约版本（major 变更须暂停报告）。 */
export const CONTRACT_VERSION = '0.1.0'

/** 与三个插件 `util/yaml.mjs` 相同的一份**方言导出集合**（C2 的对应物）。 */
export const DIALECT_EXPORTS = Object.freeze(['YamlError', 'parse', 'parseFile', 'stringify'])

export function contentHash(text) {
  return `sha256:${createHash('sha256').update(String(text)).digest('hex')}`
}

export async function mkdirp(dir) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  return dir
}

export async function readText(p, fallback = null) {
  try {
    return await fs.readFile(p, 'utf8')
  } catch (err) {
    if (err && err.code === 'ENOENT') return fallback
    throw err
  }
}

/**
 * 原子写：同目录临时文件 + rename。
 * 同目录是必须的 —— 跨设备 rename 会退化并失去原子性。
 */
export async function atomicWrite(p, content, { mode = 0o600 } = {}) {
  const dir = dirname(p)
  await mkdirp(dir)
  const tmp = join(dir, `.${createHash('sha256').update(`${process.pid}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 12)}.tmp`)
  await fs.writeFile(tmp, content, { mode })
  try {
    await fs.rename(tmp, p)
  } catch (err) {
    await fs.rm(tmp, { force: true })
    throw err
  }
  return p
}

/** 只追加写（审计日志专用 —— O_APPEND + 0600）。返回写入字节数。 */
export async function appendLine(p, line) {
  await mkdirp(dirname(p))
  const fh = await fs.open(p, 'a', 0o600)
  try {
    const buf = Buffer.from(line.endsWith('\n') ? line : `${line}\n`, 'utf8')
    await fh.write(buf)
    return buf.length
  } finally {
    await fh.close()
  }
}

/** 流式算文件 sha256（大文件不吃内存）。 */
export function hashFileStreaming(path) {
  return new Promise((resolvePromise, reject) => {
    const h = createHash('sha256')
    let size = 0
    const stream = createReadStream(path, { highWaterMark: 4 * 1024 * 1024 })
    stream.on('data', (c) => { size += c.length; h.update(c) })
    stream.on('error', reject)
    stream.on('end', () => resolvePromise({ size, hash: `sha256:${h.digest('hex')}` }))
  })
}

/**
 * 乐观并发写（compare-and-swap on content hash）。
 * @returns {Promise<{file, beforeHash, afterHash}>}
 * @throws 当 `expectedHash` 与磁盘现值不符（`err.code = 'ERR_STATE_CONFLICT'`）
 */
export async function withOptimisticWrite(file, mutator, { expectedHash = null, mode = 0o600 } = {}) {
  const before = await readText(file, null)
  const beforeHash = before === null ? null : contentHash(before)
  if (expectedHash !== null && expectedHash !== beforeHash) {
    const err = new Error(`状态文件已被其它写者改动：期望 ${expectedHash}，实际 ${beforeHash}`)
    err.code = 'ERR_STATE_CONFLICT'
    err.remediation = '重新读取该文件、基于最新内容重算，再用新的 expectedHash 重试一次；仍冲突则停下报告（不要盲目循环）'
    throw err
  }
  const doc = before === null ? null : _parse(before)
  const next = await mutator(doc)
  const text = typeof next === 'string' ? next : `${JSON.stringify(next, null, 2)}\n`
  await atomicWrite(file, text, { mode })
  return { file, beforeHash, afterHash: contentHash(text) }
}

/* ------------------------------------------------------------ schema 校验 */

/**
 * 受限 JSON-Schema 子集校验器 —— **与 `inference-contracts/checks/run-all.mjs` 同一套语义**
 * （type / const / enum / pattern / required / items / properties）。
 *
 * 为什么放在共享库里：三个包**运行时都不校验**状态文件，schema 只在 CI 里被用一次。
 * 结果是"CI 绿、线上写坏"这条缝隙只能靠人看。v0 把校验器抽出来，让运行期也能调
 * （是否开启由调用方决定，本库不擅自改三插件的行为）。
 *
 * 不支持的关键字**不静默忽略**：出现 `oneOf` / `$ref` / `allOf` 等会抛错，
 * 因为"看起来校验了其实没校验"比不校验更危险。
 */
const SUPPORTED = new Set(['type', 'const', 'enum', 'pattern', 'required', 'items', 'properties', 'additionalProperties', 'description', 'title', 'default', '$schema', 'examples'])
export const UNSUPPORTED_KEYWORDS = Object.freeze(['$ref', 'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else', 'dependencies', 'patternProperties'])

export function assertSchemaSupported(schema, path = '$') {
  if (!schema || typeof schema !== 'object') return true
  for (const k of Object.keys(schema)) {
    if (UNSUPPORTED_KEYWORDS.includes(k)) throw new Error(`schema 使用了本子集不支持的 ${k}（${path}）—— 必须显式扩展校验器，不得静默忽略`)
    if (!SUPPORTED.has(k)) throw new Error(`schema 出现未知关键字 ${k}（${path}）—— 不得静默忽略`)
  }
  if (schema.items) assertSchemaSupported(schema.items, `${path}.items`)
  for (const [k, sub] of Object.entries(schema.properties || {})) assertSchemaSupported(sub, `${path}.${k}`)
  return true
}

export function validateAgainstSchema(node, schema, path = '$', errs = []) {
  if (!schema || typeof schema !== 'object') return errs
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    const actual = node === null ? 'null' : Array.isArray(node) ? 'array' : typeof node
    const okType = types.some((t) => (t === 'integer' ? Number.isInteger(node)
      : t === 'number' ? typeof node === 'number'
        : t === 'array' ? Array.isArray(node)
          : t === 'object' ? (node && typeof node === 'object' && !Array.isArray(node))
            : t === actual))
    if (!okType) { errs.push(`${path}: 期望 ${types.join('|')}，实际 ${actual}`); return errs }
  }
  if (schema.const !== undefined && node !== schema.const) errs.push(`${path}: 期望常量 ${JSON.stringify(schema.const)}，实际 ${JSON.stringify(node)}`)
  if (schema.enum && !schema.enum.includes(node)) errs.push(`${path}: ${JSON.stringify(node)} 不在枚举 ${JSON.stringify(schema.enum)}`)
  if (schema.pattern && typeof node === 'string' && !new RegExp(schema.pattern).test(node)) errs.push(`${path}: ${JSON.stringify(node)} 不匹配 ${schema.pattern}`)
  if (Array.isArray(schema.required) && node && typeof node === 'object' && !Array.isArray(node)) {
    for (const r of schema.required) if (!(r in node)) errs.push(`${path}: 缺必填字段 ${r}`)
  }
  if (Array.isArray(node) && schema.items) node.forEach((n, i) => validateAgainstSchema(n, schema.items, `${path}[${i}]`, errs))
  if (node && typeof node === 'object' && !Array.isArray(node) && schema.properties) {
    for (const [k, sub] of Object.entries(schema.properties)) if (k in node) validateAgainstSchema(node[k], sub, `${path}.${k}`, errs)
  }
  return errs
}
