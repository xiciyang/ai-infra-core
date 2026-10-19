/**
 * audit-core 契约测试 —— **核心判据是"能不能复算线上已有的链"**。
 *
 * 只断言"自己写的链自己能验"是自证；真正有意义的是：
 * 拿 inference-serving / quantization / tuning / diagnose **真实的审计分片**，
 * 用 audit-core 独立重算一遍 —— 算法只要差一个字符（比如 canonicalJson 的键序），
 * 这 660+ 条线上记录会立刻报"内容被改动"。
 */
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync, promises as fs } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  CONTRACT_VERSION, GENESIS, KNOWN_PACKAGES, discoverChainPackages, CHAIN_VARIANTS, VARIANT_IDS, DEFAULT_VARIANT, schemaFor, sha256, canonicalJson,
  auditDirFor, auditFileFor, appendAudit, readAudit, verifyChain, verifyAllChains, listShards, digestArgs, hashOfBody, detectVariant,
} from '../src/index.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
// 复算线上真实链需要外部状态根；没有就显式 skip（不伪造通过）。
// 用法：AI_INFRA_ROOT=~/.ai-infra npm test
const AUDIT_ROOT = process.env.AI_INFRA_ROOT || null
const HAS_REAL_ROOT = Boolean(AUDIT_ROOT) && existsSync(AUDIT_ROOT)

export const NAME = 'audit-core 契约（v0 冻结面 + 复算线上真实链）'

export async function run(t) {
  // LONGTASK5：0.1.0 → **0.1.1**（patch）。appendAudit 的串行化是**修复使承诺成真的缺陷**
  // —— 接口面一字未改，只把"声称串行"变成"实际串行"，故按 patch 走，不构成 major。
  t.assert(CONTRACT_VERSION === '0.1.1', `CONTRACT_VERSION 已冻结（${CONTRACT_VERSION}）`)
  t.assert(GENESIS === '0'.repeat(64), 'GENESIS = 64 个 0')
  // LONGTASK5：命名空间从 4 扩到 8（补训练侧四包）。断言改为"这 8 个必须都在"，
  // 而不是钉死数字 —— 否则每加一个包都要改测试，容易改成"迁就现状"。
  const REQUIRED_CHAIN_PKGS = ['inference-serving', 'inference-quantization', 'inference-tuning', 'inference-diagnose',
    'training-sft', 'training-pretrain', 'training-rl', 'training-qat']
  const missingPkgs = REQUIRED_CHAIN_PKGS.filter((x) => !KNOWN_PACKAGES.includes(x))
  t.assert(missingPkgs.length === 0, `已知链命名空间已登记（缺：${missingPkgs.join(', ') || '无'}；共 ${KNOWN_PACKAGES.length} 个）`)

  // ── **覆盖率断言**（LONGTASK5 固化原则："检查通过" ≠ "检查过"）──
  // 覆盖范围**由现场决定**，不再由名单决定：审计目录下有链的包就必须被复算。
  // 这样"新增插件忘了改名单"这一类缺陷从根上不可能再发生。
  //
  // ⚠️ 缺陷回放 D09 实测（本仓库"检查器自述覆盖"的元级失效）：这里曾经**只**断言
  // `discovered.length >= REQUIRED_CHAIN_PKGS.length` —— 那是一个**硬编码下界**，是快照不是断言。
  // 同时 `notCovered` **算出来却从未使用**（死变量）⇒ "名册漏掉了对象"这件事从来没被断言过。
  // 现在两个方向都断言：① 现场发现的**全在名册内**（名册缩小 / 新包上线即红）；
  // ② 名册本身不得退化成空/极小（拿它跟**现场**比，而不是跟一个写死的数字比）。
  const discovered = HAS_REAL_ROOT ? await discoverChainPackages({ root: AUDIT_ROOT }) : []
  const notCovered = discovered.filter((x) => !KNOWN_PACKAGES.includes(x))
  if (HAS_REAL_ROOT) {
    t.assert(discovered.length >= REQUIRED_CHAIN_PKGS.length,
      `动态发现覆盖 ≥ ${REQUIRED_CHAIN_PKGS.length} 条链（实际发现 ${discovered.length}：${discovered.join(', ')}）`)
    t.assert(notCovered.length === 0,
      `现场发现的链**全部在名册内**（名册外：${notCovered.join(', ') || '无'}；名册 ${KNOWN_PACKAGES.length} 项 / 现场 ${discovered.length} 项）`
      + ' —— 名册被缩小、或新包上线没登记，都在这里变红（覆盖范围由现场决定，不由名册决定）')
    t.assert(KNOWN_PACKAGES.length >= discovered.length,
      `名册不得小于现场（名册 ${KNOWN_PACKAGES.length} / 现场 ${discovered.length}）—— 名册的职责是"至少不比现场少"`)
  } else {
    t.skip('未设置 AI_INFRA_ROOT：跳过「线上链动态发现覆盖率」3 项（不是通过）')
  }
  t.assert(schemaFor('inference-tuning') === 'inference-tuning/audit@1', 'schema 命名口径与四个插件一致')

  // canonicalJson 稳定性 —— 整个链算法就靠它
  t.assert(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] }) === canonicalJson({ a: [2, { c: 4, d: 3 }], b: 1 }), 'canonicalJson 键序稳定')
  t.assert(sha256('x').length === 64, 'sha256 十六进制')
  t.assert(JSON.stringify(digestArgs({ report: 'secret', n: 1 })) === JSON.stringify({ argsDigest: `sha256:${sha256(canonicalJson({ n: 1, report: 'secret' }))}`, argsKeys: ['n', 'report'] }),
    'digestArgs 只给摘要与键名（明文纪律）')

  // ── 链变体：**实测发现四个插件不是一个算法，是两个** ──
  t.assert(VARIANT_IDS.length === 2, `登记了两个链变体（${VARIANT_IDS.join(', ')}）`)
  t.assert(DEFAULT_VARIANT === 'canonical-json', '默认变体 = canonical-json')
  t.assert(CHAIN_VARIANTS['canonical-json'].usedBy.includes('inference-tuning') && CHAIN_VARIANTS['canonical-json'].usedBy.includes('inference-diagnose'),
    'canonical-json 的 usedBy 含 tuning / diagnose（实测口径）')
  t.assert(CHAIN_VARIANTS['prevhash-canonical-json'].usedBy.includes('inference-serving') && CHAIN_VARIANTS['prevhash-canonical-json'].usedBy.includes('inference-quantization'),
    'prevhash-canonical-json 的 usedBy 含 serving / quantization（实测口径）')
  const sampleBody = { seq: 1, prevHash: GENESIS, x: 1 }
  t.assert(hashOfBody(sampleBody, 'canonical-json') !== hashOfBody(sampleBody, 'prevhash-canonical-json'), '两个变体对同一条记录给出不同哈希（这就是"两个算法"的直接证据）')
  t.assert(detectVariant({ ...sampleBody, hash: hashOfBody(sampleBody, 'canonical-json') }) === 'canonical-json', 'detectVariant 认出 canonical-json')
  t.assert(detectVariant({ ...sampleBody, hash: hashOfBody(sampleBody, 'prevhash-canonical-json') }) === 'prevhash-canonical-json', 'detectVariant 认出 prevhash-canonical-json')
  t.assert(detectVariant({ ...sampleBody, hash: 'deadbeef' }) === null, '都不匹配 → null（第三种算法必须显式登记，不得静默）')

  // ── 自建链：追加 / 复算 / 篡改检出 ──
  const tmp = mkdtempSync(join(tmpdir(), 'audit-core-'))
  const root = join(tmp, 'ai-infra')
  const date = new Date('2026-02-01T00:00:00Z')
  const a1 = await appendAudit({ root, pkg: 'training', pkgVersion: '0.0.1', entry: { capability: 'sft', action: 'train', phase: 'begin' }, date })
  const a2 = await appendAudit({ root, pkg: 'training', pkgVersion: '0.0.1', entry: { capability: 'sft', action: 'train', phase: 'end' }, date })
  t.assert(a1.seq === 1 && a2.seq === 2 && a1.prevHash === GENESIS && a2.prevHash === a1.hash, 'seq 递增且 prevHash 首尾相接')
  t.assert(a1.variant === 'canonical-json', 'appendAudit 回传所用变体（写入方不必靠猜）')
  const a1b = await appendAudit({ root, pkg: 'training2', pkgVersion: '0.0.1', entry: { capability: 'sft' }, date, variant: 'prevhash-canonical-json' })
  t.assert(a1b.variant === 'prevhash-canonical-json', '可显式指定变体写入（兼容 serving/quantization 口径）')
  t.assert(auditFileFor({ root, pkg: 'training', date }).endsWith('2026-02-01.jsonl'), '分片按日期命名')
  const v0 = await verifyChain({ root, pkg: 'training', date })
  t.assert(v0.ok === true && v0.checked === 2, `自建链复算通过（checked=${v0.checked}）`)
  t.assert(v0.variant === 'canonical-json', `复算结果里写明用的是哪个变体（${v0.variant}）`)
  const v0b = await verifyChain({ root, pkg: 'training2', date })
  t.assert(v0b.ok === true && v0b.variant === 'prevhash-canonical-json', '自动识别出另一个变体并复算通过')
  const wrongVariant = await verifyChain({ root, pkg: 'training2', date, variant: 'canonical-json' })
  t.assert(wrongVariant.ok === false, '用错变体验另一条链 → 失败（这正是"不传 variant 就用通用校验器"会踩的坑）')
  const file = auditFileFor({ root, pkg: 'training', date })
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
  const bad = JSON.parse(lines[0]); bad.phase = 'TAMPERED'
  writeFileSyncSafe(file, [JSON.stringify(bad), lines[1]].join('\n') + '\n')
  const v1 = await verifyChain({ root, pkg: 'training', date })
  t.assert(v1.ok === false && v1.brokenAt === 1, `篡改首条 → 检出并定位（ok=${v1.ok} brokenAt=${v1.brokenAt}）`)
  writeFileSyncSafe(file, lines.join('\n') + '\n')
  const v2 = await verifyChain({ root, pkg: 'training', date })
  t.assert(v2.ok === true, '恢复后链重新通过（篡改检出不是"一次坏永久坏"）')
  // 诚实边界：链能检出**改动/插入/重排**，但**不能**检出"从尾部截断"——
  // 截断后的前缀仍是一条自洽的链。尾部截断要靠外部期望计数（或把 head 记在别处）来发现。
  writeFileSyncSafe(file, [lines[0]].join('\n') + '\n')
  const trunc = await verifyChain({ root, pkg: 'training', date })
  t.assert(trunc.ok === true && trunc.checked === 1, '已知边界：尾部截断后前缀仍自洽 → 本函数报 ok（须由外部期望计数兜底，不得声称能检出截断）')
  writeFileSyncSafe(file, lines.join('\n') + '\n')
  t.assert((await listShards({ root, pkg: 'training' })).length === 1, 'listShards 列出分片')
  t.assert((await verifyAllChains({ root, pkg: 'nope' })).ok === true, '空链（无分片）视为 ok（不是错误）')
  const mode = ((await fs.stat(file)).mode & 0o777).toString(8)
  t.assert(mode === '600', `审计文件权限 0600（实际 ${mode}）`)
  rmSync(tmp, { recursive: true, force: true })

  // ── 复算**线上真实链**（这是本契约最有信息量的一条）──
  let checkedTotal = 0
  let packagesSeen = 0
  if (!HAS_REAL_ROOT) t.skip('未设置 AI_INFRA_ROOT：跳过「复算线上真实链」（不是通过）')
  const CHAIN_PKGS = HAS_REAL_ROOT ? [...new Set([...discovered, ...KNOWN_PACKAGES])].sort() : []
  for (const pkg of CHAIN_PKGS) {
    const dir = auditDirFor({ root: AUDIT_ROOT, pkg })
    // 本机没有该包的分片 ⇒ 这条检查**没跑**，登记为 skip，**不得**写成 assert(true)。
    // （写成 assert(true) 会让断言数随本机状态漂移，且注释与代码互相矛盾。）
    // 覆盖率由下面的 `packagesSeen >= 3` 真正兜底 —— skip 不是"默认通过"。
    if (!existsSync(dir)) {
      (t.skip || ((m) => console.log(`   SKIP ${m}`)))(`${pkg}：本机尚无审计分片（跳过，不计入断言）`)
      continue
    }
    packagesSeen += 1
    const shards = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()
    t.assert(shards.length > 0, `${pkg}：有分片（${shards.length} 个）`)
    const expectedVariants = new Set()
    for (const shard of shards) {
      const day = shard.replace(/\.jsonl$/, '')
      const r = await verifyChain({ root: AUDIT_ROOT, pkg, date: new Date(`${day}T00:00:00Z`) })
      t.assert(r.ok === true, `${pkg}/${shard}：用 audit-core 独立复算通过${r.ok ? `（${r.checked} 条，variant=${r.variant}）` : ` — ${r.reason}`}`)
      if (r.ok) { checkedTotal += r.checked; expectedVariants.add(r.variant) }
    }
    // 该包用的变体必须与登记表一致 —— 谁改掉算法，这里立刻红
    const registered = VARIANT_IDS.find((v) => CHAIN_VARIANTS[v].usedBy.includes(pkg))
    t.assert(expectedVariants.size === 1, `${pkg}：所有分片用同一个变体（实际 ${[...expectedVariants].join(', ')}）`)
    t.assert([...expectedVariants][0] === registered,
      `${pkg}：实测变体 ${[...expectedVariants][0]} 与登记表 ${registered} 一致`)
  }
  if (HAS_REAL_ROOT) {
    t.assert(packagesSeen >= 3, `至少有三个包的线上链被复算（实际 ${packagesSeen}）`)
    t.assert(checkedTotal >= 100, `复算的线上记录总数 ≥100（实际 ${checkedTotal}）—— 算法一致才有这个数`)
    console.log(`   线上链复算：${packagesSeen} 个包 / ${checkedTotal} 条记录，全部通过（两个变体都已识别）`)
  } else {
    t.skip('未设置 AI_INFRA_ROOT：跳过「线上记录数 ≥100 / 至少三包」2 项（不是通过）')
  }
}

function writeFileSyncSafe(p, text) {
  // 覆写内容以模拟篡改；`writeFileSync` 不改已存在文件的权限，故 0600 保持不变。
  writeFileSync(p, text)
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 自执行入口 —— **为什么必须有它**（缺陷回放 D09 实测，不是风格问题）
 *
 * `node inference-training/shared/libs/audit-core/tests/contract.mjs` 曾经 **exit 0（恒绿）**：
 * 本文件只是一个**模块**（导出 `NAME` / `run`），没有任何顶层驱动 —— 谁跑都"通过"，因为
 * **什么都没跑**。而它正是缺陷回放语料里 D09 的一个声明检测器 ⇒ 那一格的"绿"是假的。
 * **一个恒绿的检测器比没有检测器更危险**：它把"没检查"伪装成"检查过"（本仓库反复出现的形态）。
 *
 * 守卫：被 `shared/run-all.mjs` **import** 时 `invokedDirectly === false` ⇒ 一切照旧（不重复跑、
 * 不抢退出码）；用 `node` **直接跑本文件**时才真的跑一遍并按结果给退出码。
 * ══════════════════════════════════════════════════════════════════════════════ */
const invokedDirectly = (() => {
  try {
    return Boolean(process.argv[1]) && pathToFileURL(process.argv[1]).href === import.meta.url
  } catch { return false }
})()

if (invokedDirectly) {
  const t = { asserts: 0, failures: [], skipped: [] }
  const assert = (cond, msg) => { t.asserts += 1; if (!cond) t.failures.push(msg) }
  const skip = (msg) => { t.skipped.push(msg) }
  try {
    await run({ assert, skip })
  } catch (e) {
    t.failures.push(`抛出异常：${String(e?.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e)}`)
  }
  for (const s of t.skipped) console.log(`SKIP  ${s}`)
  if (t.failures.length === 0) {
    console.log(`\n${NAME}：PASS  ${t.asserts} 项断言${t.skipped.length ? `（另有 ${t.skipped.length} 项跳过，不计入）` : ''}`)
  } else {
    console.log(`\n${NAME}：FAIL  ${t.failures.length}/${t.asserts} 项断言未通过：`)
    for (const f of t.failures) console.log(`  - ${f}`)
  }
  process.exit(t.failures.length === 0 ? 0 : 1)
}
