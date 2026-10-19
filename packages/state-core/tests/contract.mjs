/**
 * state-core 契约测试 —— 最重要的是**与三个插件的方言逐条对齐**：
 * 不比较"文档说的一致"，而是拿线上真实状态文件，让四份 parser 各读一遍、结果逐字节相同。
 */
import { mkdtempSync, rmSync, readFileSync, existsSync, promises as fs } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  CONTRACT_VERSION, DIALECT_EXPORTS, YamlError, parse, stringify, parseFile,
  validateAgainstSchema, assertSchemaSupported, atomicWrite, withOptimisticWrite,
  readText, appendLine, contentHash, hashFileStreaming,
} from '../src/index.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
// 跨实现对齐需要兄弟仓库；没有就显式 skip（不伪造通过）。
// 用法：INFERENCE_WORKSPACE=<含 inference-serving/quantization/tuning 的目录> npm test
const WORKSPACE = process.env.INFERENCE_WORKSPACE || null
const SIBLINGS = WORKSPACE ? {
  serving: join(WORKSPACE, 'inference-serving', 'src', 'util', 'yaml.mjs'),
  quantization: join(WORKSPACE, 'inference-quantization', 'src', 'util', 'yaml.mjs'),
  tuning: join(WORKSPACE, 'inference-tuning', 'src', 'util', 'yaml.mjs'),
} : {}
const STATE_DIR = process.env.AI_INFRA_STATE || null

export const NAME = 'state-core 契约（v0 冻结面 + 与三插件方言对齐）'

export async function run(t) {
  t.assert(CONTRACT_VERSION === '0.1.0', `CONTRACT_VERSION 已冻结（${CONTRACT_VERSION}）`)

  // ── 导出集合与插件同形 ──
  const mine = { YamlError, parse, stringify, parseFile }
  t.assert(JSON.stringify(Object.keys(mine).sort()) === JSON.stringify([...DIALECT_EXPORTS].sort()),
    `方言导出集合与 DIALECT_EXPORTS 一致（${DIALECT_EXPORTS.join(', ')}）`)
  for (const [pkg, p] of Object.entries(SIBLINGS)) {
    if (!WORKSPACE) { t.skip(`未设置 INFERENCE_WORKSPACE：跳过 ${pkg} 跨实现对齐（不是通过）`); continue }
    if (!existsSync(p)) { t.assert(false, `${pkg} 的 yaml.mjs 不存在（${p}）—— 设置后仍缺兄弟包，视为失败`); continue }
    const mod = await import(p)
    const theirs = Object.keys(mod).sort()
    t.assert(JSON.stringify(theirs) === JSON.stringify([...DIALECT_EXPORTS].sort()),
      `${pkg} 的导出集合与 state-core 相同（${theirs.join(', ')}）`)
  }

  // ── 跨实现行为对齐：真实状态文件逐字节同结果 ──
  const parsers = { 'state-core': parse }
  for (const [pkg, p] of Object.entries(SIBLINGS)) if (existsSync(p)) parsers[pkg] = (await import(p)).parse
  const files = STATE_DIR && existsSync(STATE_DIR) ? (await fs.readdir(STATE_DIR)).filter((f) => f.endsWith('.yaml')) : []
  if (STATE_DIR && existsSync(STATE_DIR)) {
    t.assert(files.length > 0, `真实状态根有 YAML 可对齐（${STATE_DIR}，${files.length} 份）`)
  } else {
    t.skip('未设置 AI_INFRA_STATE：跳过「真实状态文件跨实现对齐」（不是通过）')
  }
  for (const f of files) {
    const text = readFileSync(join(STATE_DIR, f), 'utf8')
    const results = {}
    for (const [k, p] of Object.entries(parsers)) {
      try { results[k] = JSON.stringify(p(text)) } catch (e) { results[k] = `ERR:${String(e.message).slice(0, 60)}` }
    }
    const uniq = new Set(Object.values(results))
    t.assert(uniq.size === 1, `${f}：四份 parser 结果一致${uniq.size === 1 ? '' : `（不一致：${JSON.stringify(Object.keys(results).filter((k) => results[k] !== results[Object.keys(results)[0]]))}）`}`)
  }

  // ── 往返 + 发射形态 ──
  const obj = { version: 1, runs: [{ id: 'tr_x', nested: { a: '中文', b: [1, 2, 3] }, 'weird key': true }], empty: [], emptyMap: {} }
  const round = parse(stringify(obj))
  t.assert(JSON.stringify(round) === JSON.stringify(obj), '发射-解析往返一致（含空容器行内发射）')
  t.assert(/^version:/m.test(stringify(obj)), '安全键用裸键（与兄弟包 writer 同形）')
  const legacy = '"version": 1\n"runs":\n  - "id": "tr_old"\n'
  t.assert(parse(legacy).runs[0].id === 'tr_old', '历史引号形态仍可读（不做一次性迁移）')
  let threw = false
  try { parse('a:\n\tb: 1') } catch { threw = true }
  t.assert(threw, 'tab 缩进被拒绝（YAML 规范禁止；原实现抛普通 Error，与兄弟包一致）')
  t.assert(typeof (await parseFile({ readFile: async () => { const e = new Error('x'); e.code = 'ENOENT'; throw e } }, '/nope', 'FB')) === 'string', 'parseFile 的 ENOENT → fallback')

  // ── 原子写 + 乐观并发（并发策略：CAS，不加文件锁）──
  const tmp = mkdtempSync(join(tmpdir(), 'state-core-'))
  const f1 = join(tmp, 'a.yaml')
  await atomicWrite(f1, 'version: 1\n')
  t.assert(readFileSync(f1, 'utf8') === 'version: 1\n', 'atomicWrite 落盘内容正确')
  const h1 = contentHash(await readText(f1))
  const w1 = await withOptimisticWrite(f1, () => ({ version: 2 }), { expectedHash: h1 })
  t.assert(w1.beforeHash === h1 && w1.afterHash !== h1, '乐观写成功后返回前后哈希')
  threw = false
  try { await withOptimisticWrite(f1, () => ({ version: 3 }), { expectedHash: h1 }) } catch (e) { threw = e.code === 'ERR_STATE_CONFLICT' }
  t.assert(threw, '期望哈希过期 → ERR_STATE_CONFLICT（并发冲突被**检出**，而不是最后写者胜）')
  await appendLine(join(tmp, 'log.jsonl'), '{"a":1}')
  await appendLine(join(tmp, 'log.jsonl'), '{"a":2}')
  t.assert(readFileSync(join(tmp, 'log.jsonl'), 'utf8').split('\n').filter(Boolean).length === 2, 'appendLine 只追加')
  const hf = await hashFileStreaming(join(tmp, 'log.jsonl'))
  t.assert(hf.hash.startsWith('sha256:') && hf.size > 0, 'hashFileStreaming 返回 {size, hash}')
  rmSync(tmp, { recursive: true, force: true })

  // ── schema 校验（与 inference-contracts/checks 同一套语义）──
  const schema = { type: 'object', required: ['version'], properties: { version: { type: 'integer' }, runs: { type: 'array', items: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^tr_' } } } } } }
  t.assert(validateAgainstSchema({ version: 1, runs: [{ id: 'tr_a' }] }, schema).length === 0, '合法文档零错误')
  const errs = validateAgainstSchema({ version: 'x', runs: [{ id: 'bad' }, {}] }, schema)
  t.assert(errs.length === 3, `非法文档报 3 处（实际 ${errs.length}：${errs.join(' | ')}）`)
  t.assert(errs.some((e) => /期望 integer/.test(e)) && errs.some((e) => /不匹配/.test(e)) && errs.some((e) => /缺必填字段 id/.test(e)), '三类错误都可定位')
  threw = false
  try { assertSchemaSupported({ oneOf: [{ type: 'string' }] }) } catch { threw = true }
  t.assert(threw, '不支持的 schema 关键字 → 抛错（"看起来校验了其实没校验"比不校验更危险）')
  t.assert(assertSchemaSupported(schema) === true, '受支持的关键字通过')
}
