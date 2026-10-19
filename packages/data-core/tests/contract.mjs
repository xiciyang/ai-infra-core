/**
 * data-core 契约测试 —— 重点在"确定性"与"去泄漏"这两句承诺**真的有判据**。
 */
import {
  CONTRACT_VERSION, contentHash, canonicalRecord, recordHash,
  dedupByContent, splitDeterministic, assertNoLeakage, lineage, piiScan, PII_PATTERNS,
} from '../src/index.mjs'

export const NAME = 'data-core 契约（v0 冻结面）'

export async function run(t) {
  t.assert(CONTRACT_VERSION === '0.1.0', `CONTRACT_VERSION 已冻结（${CONTRACT_VERSION}）`)

  // ── 规范化：键序不同必须得到同一个哈希（否则去重与去泄漏双双失效）──
  const a = { b: 1, a: { d: 2, c: [3, 4] } }
  const b = { a: { c: [3, 4], d: 2 }, b: 1 }
  t.assert(JSON.stringify(canonicalRecord(a)) === JSON.stringify(canonicalRecord(b)), 'canonicalRecord 键序稳定')
  t.assert(recordHash(a) === recordHash(b), '键序不同的同一条记录 → 同一个内容哈希')
  t.assert(contentHash('x') !== contentHash('y') && contentHash('x').length === 64, 'contentHash 是 64 位十六进制')

  // ── 去重（保序）──
  const recs = [{ id: 1, text: 'a' }, { id: 2, text: 'b' }, { id: 1, text: 'a' }, { id: 3, text: 'c' }]
  const dd = dedupByContent(recs)
  t.assert(dd.kept.length === 3 && dd.dropped.length === 1, `按内容去重：保留 ${dd.kept.length} 丢 ${dd.dropped.length}`)
  t.assert(dd.kept.map((r) => r.id).join(',') === '1,2,3', '去重保序（首次出现优先）')
  t.assert(dd.dropped[0].reason === 'duplicate-content', '丢弃原因可审计')

  // ── 确定性切分 ──
  const pool = Array.from({ length: 1000 }, (_, i) => ({ id: i, text: `sample-${i}` }))
  const s1 = splitDeterministic(pool, { seed: 20260923, calib: 128, test: 400 })
  const s2 = splitDeterministic(pool, { seed: 20260923, calib: 128, test: 400 })
  t.assert(JSON.stringify(s1.calib) === JSON.stringify(s2.calib) && JSON.stringify(s1.test) === JSON.stringify(s2.test), '同 seed 同输入 → 逐条相同的两个集合')
  t.assert(s1.hash === s2.hash, '切分哈希可复现')
  const s3 = splitDeterministic(pool, { seed: 7, calib: 128, test: 400 })
  t.assert(s3.hash !== s1.hash, '换 seed → 不同切分（seed 真的生效，不是摆设）')
  t.assert(s1.counts.calib === 128 && s1.counts.test === 400 && s1.counts.unused === 472, `计数正确（${JSON.stringify(s1.counts)}）`)
  let threw = false
  try { splitDeterministic(pool.slice(0, 10), { calib: 128, test: 400 }) } catch { threw = true }
  t.assert(threw, '样本不足 → 抛错（不得静默缩小切分）')

  // ── 去泄漏 ──
  const clean = assertNoLeakage(s1.calib, s1.test)
  t.assert(clean.ok === true && clean.intersection.length === 0, '正常切分：内容哈希交集为空')
  const leaky = assertNoLeakage(s1.calib, [...s1.test.slice(0, 3), ...s1.calib.slice(0, 2)])
  t.assert(leaky.ok === false && leaky.intersection.length === 2, `人为制造泄漏 → 检出 ${leaky.intersection.length} 条交集`)
  t.assert(leaky.intersection.every((h) => /^[0-9a-f]{64}$/.test(h)), '交集以内容哈希形式给出（可复核，不是"看起来像"）')

  // ── 血缘 ──
  const lg = lineage({ source: 'Salesforce/wikitext', revision: 'abc123', seed: 20260923, calib: s1.calib, test: s1.test })
  t.assert(lg.schema === 'ai-infra/lineage@1' && lg.source === 'Salesforce/wikitext' && lg.revision === 'abc123', '血缘含 source / revision')
  t.assert(lg.calib.count === 128 && lg.test.count === 400 && lg.calib.hash.startsWith('sha256:'), '血缘含两侧计数与内容哈希')
  threw = false
  try { lineage({ seed: 1, calib: [], test: [] }) } catch { threw = true }
  t.assert(threw, '缺 source 的血缘抛错（无来源的产物不可追溯）')

  // ── PII 扫描（保守，且**不**提供自动脱敏）──
  t.assert(PII_PATTERNS.length >= 5, `PII 模式表非空（${PII_PATTERNS.length} 条）`)
  const fakeToken = 'gh' + 'p_' + 'A'.repeat(36)
  const found = piiScan('联系 zhang.san@example.com 或 13812345678，设备 10.201.33.7，token ' + fakeToken)
  const ids = found.findings.map((f) => f.pattern)
  t.assert(ids.includes('email'), '命中 email')
  t.assert(ids.includes('cn-mobile'), '命中手机号')
  t.assert(ids.includes('ipv4'), '命中 IPv4')
  t.assert(ids.includes('bearer-token'), '命中 token 形态')
  t.assert(found.findings.every((f) => typeof f.sampleHash === 'string' && f.sampleHash.startsWith('sha256:')), '命中只给哈希，不回显原文')
  t.assert(!JSON.stringify(found).includes('zhang.san@example.com'), '扫描结果里不含 PII 明文（本库不做"脱敏后继续"）')
  const none = piiScan('这一段是普通中文文本，没有任何个人信息。')
  t.assert(none.count === 0, '干净文本零命中')

  // ── PII 仪表的**已知阳性/阴性对照**（2026-09-28 真机实测缺陷回归）──
  // 缺陷现场：数据集记录里自带的 sha256 内容哈希（64 位十六进制）被 `cn-idcard`
  // 正则当成了身份证号 —— 十六进制串里很容易出现 18 个连续数字字符。
  // 假阳性与假阴性一样会让门禁失去意义，故两类对照都锁死。
  {
    // 阳性对照：动态构造一个**校验位正确**的身份证号（不硬编码，避免抄错）
    const body17 = '11010519491231002'
    const W = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]
    const CODE = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2']
    let sum = 0
    for (let i = 0; i < 17; i += 1) sum += Number(body17[i]) * W[i]
    const validId = body17 + CODE[sum % 11]
    const pos = piiScan(`证件号 ${validId} 已登记`)
    t.assert(pos.findings.some((f) => f.pattern === 'cn-idcard'), `阳性对照：校验位合法的身份证号被命中（${validId}）`)
    // 阴性对照 1：sha256 十六进制串（首版缺陷的现场）
    const hashLike = '81ac6a6ed4408aba5eba263267541b59f06e4647a488a9613512bc544e5ccc1b'
    const neg1 = piiScan(hashLike)
    t.assert(neg1.findings.length === 0, `阴性对照：64 位 sha256 十六进制串零命中（实际 ${JSON.stringify(neg1.findings.map((f) => f.pattern))}）`)
    t.assert(neg1.suppressed >= 0, 'suppressed 计数可见（被校验器挡下的候选数）')
    // 阴性对照 2：校验位不合法 → 不当成身份证号
    const badId = body17 + (CODE[sum % 11] === '1' ? '2' : '1')
    const neg2 = piiScan(`编号 ${badId}`)
    t.assert(!neg2.findings.some((f) => f.pattern === 'cn-idcard'), '阴性对照：校验位不合法 → 不判身份证号')
    // 阴性对照 3：非法 IPv4（八位组 >255）
    const neg3 = piiScan('version 999.1.1.1 released')
    t.assert(!neg3.findings.some((f) => f.pattern === 'ipv4'), '阴性对照：999.1.1.1 不是 IPv4（八位组越界）')
    const pos3 = piiScan('server 10.201.33.7 unreachable')
    t.assert(pos3.findings.some((f) => f.pattern === 'ipv4'), '阳性对照：合法 IPv4 仍被命中')
  }
}
