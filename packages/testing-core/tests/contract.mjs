/**
 * testing-core 契约测试 —— 零依赖、无 GPU、无网络。
 *
 * 重点不是"函数能跑"，而是**判据本身成立**：
 *   - ε 必须真的随 (n, s, lnV) 变化（否则它就是魔数假扮成公式）
 *   - 均匀/非均匀的判定必须与"已知阳性/已知阴性"一致
 *   - 双重门禁必须能区分"测量不成立"与"数值未达标"
 */
import {
  CONTRACT_VERSION, lnVocab, nllFromLogprob, meanNllFromLogprobs, perplexity,
  uniformSignature, relativeChange, dualGate, floatFingerprint, stddev,
  post, get, evalLM, evalMMLU, evalUniform, measurementCompleteness, attachIntegrity, forgettingGate,
  FORGETTING_SIDES,
} from '../src/index.mjs'

export const NAME = 'testing-core 契约（v0 冻结面 + v0.2.0 合并进来的评估壳）'

export async function run(t) {
  t.assert(CONTRACT_VERSION === '0.2.0', `CONTRACT_VERSION 已冻结（${CONTRACT_VERSION}）`)

  // ── v0.2.0：四个插件里同一算法的四份评估实现合并到本库（唯一实现）──
  //   判据是**导出面在、且行为可用**；各自的语义判据由插件侧回归 spec
  //   （measurement-integrity / cache-integrity）与 CI 的 C27 组把守。
  t.assert(typeof post === 'function' && typeof get === 'function', '端点原语 post/get 在本库（唯一实现）')
  t.assert(typeof evalLM === 'function' && typeof evalMMLU === 'function' && typeof evalUniform === 'function', '三个逐条测量 evalLM/evalMMLU/evalUniform 在本库（唯一实现）')
  t.assert(typeof measurementCompleteness === 'function' && typeof attachIntegrity === 'function' && typeof forgettingGate === 'function', '完整性判定与遗忘门禁在本库（唯一实现）')
  t.assert(JSON.stringify(FORGETTING_SIDES) === JSON.stringify(['sft', 'pt', 'rl']), `遗忘门禁的候选侧标签闭集（${JSON.stringify(FORGETTING_SIDES)}）`)
  // 缺陷 15 的 fail-closed 语义必须在**合并后**仍然成立（未知 ≠ 完整）
  t.assert(measurementCompleteness({ lm: { texts: 5 } }).complete === false, '缺陷 15：旧条目（无 attempted/failed）不可复用 —— 未知 ≠ 完整')
  t.assert(measurementCompleteness({ lm: { attempted: 100, failed: 0 } }).complete === true, '缺陷 15：带证据且 failed=0 才可复用')
  t.assert(measurementCompleteness(null).reason === 'missing', '缺陷 15：null ⇒ missing')

  // ── lnVocab / NLL 基础 ──
  t.assert(Math.abs(lnVocab(151936) - Math.log(151936)) < 1e-12, 'lnVocab 用 log（V 由调用方从 config 读入）')
  let threw = false
  try { lnVocab(1) } catch { threw = true }
  t.assert(threw, 'lnVocab(V<2) 抛错（不允许把非法词表算成 0）')
  threw = false
  try { nllFromLogprob(0.5) } catch { threw = true }
  t.assert(threw, 'nllFromLogprob 拒绝正数（不是对数概率）')
  t.assert(Math.abs(nllFromLogprob(-1) - 1) < 1e-12, 'NLL = −logprob')
  t.assert(Math.abs(perplexity(0) - 1) < 1e-12, '困惑度 exp(0)=1')
  t.assert(Math.abs(meanNllFromLogprobs([-1, -2, -3]) - 2) < 1e-12, '平均 NLL')
  threw = false
  try { meanNllFromLogprobs([]) } catch { threw = true }
  t.assert(threw, '空样本抛错（空样本上的"均值"是 NaN 伪装成的结论）')

  // ── 均匀签名的 ε 必须是**推出来的**，不是定死的 ──
  const V = 151936
  const lnV = lnVocab(V)
  const meanOf = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length
  // 已知均匀（严格）：每个 token 的 NLL 恒等于 lnV
  const uniformNll = Array.from({ length: 200 }, () => lnV)
  const uni = uniformSignature({ meanNll: meanOf(uniformNll), perTokenNll: uniformNll, vocabSize: V })
  t.assert(uni.uniform === true, '严格均匀样本 → uniform=true（已知阳性对照）')
  t.assert(uni.epsilon > 0 && uni.epsilon >= uni.fpFloor, 'ε 有正的下界（数值表示误差地板）')
  t.assert(Math.abs(uni.fpFloor - Math.pow(2, -9) * lnV) < 1e-12, 'ε 地板 = 2^-9·lnV（bf16 尾数位推导，不是魔数）')
  t.assert(/vocab_size/.test(uni.criterion) && /std\(NLL\)/.test(uni.criterion), 'criterion 字符串逐字给出公式（判据随证据返回）')

  // 已知非均匀（模型有信号）：NLL 明显低于 lnV
  const peakedNll = Array.from({ length: 200 }, (_, i) => 2 + (i % 5) * 0.1)
  const pk = uniformSignature({ meanNll: meanOf(peakedNll), perTokenNll: peakedNll, vocabSize: V })
  t.assert(pk.uniform === false, '明显偏离 lnV 的样本 → uniform=false（已知阴性对照）')
  t.assert(pk.effectSize > pk.epsilon, 'effectSize > ε 才判非均匀（判据可复核）')

  // ε 必须随 n 与 s 变化 —— 这条断言就是"ε 不是魔数"的机器判据
  const noisyNll = (n) => Array.from({ length: n }, (_, i) => lnV - 1 + (i % 7) * 0.5)
  const small = uniformSignature({ meanNll: meanOf(noisyNll(20)), perTokenNll: noisyNll(20), vocabSize: V })
  const large = uniformSignature({ meanNll: meanOf(noisyNll(2000)), perTokenNll: noisyNll(2000), vocabSize: V })
  t.assert(large.epsilon < small.epsilon, `ε 随 n 增大而收窄（n=20 → ${small.epsilon.toExponential(3)}；n=2000 → ${large.epsilon.toExponential(3)}）`)
  const quietNll = Array.from({ length: 200 }, () => lnV - 1)
  const loudNll = noisyNll(200)
  const quiet = uniformSignature({ meanNll: meanOf(quietNll), perTokenNll: quietNll, vocabSize: V })
  const loud = uniformSignature({ meanNll: meanOf(loudNll), perTokenNll: loudNll, vocabSize: V })
  t.assert(loud.epsilon > quiet.epsilon, 'ε 随样本标准差增大而放宽（同一 n）')

  threw = false
  try { uniformSignature({ meanNll: lnV, vocabSize: V }) } catch { threw = true }
  t.assert(threw, '只给均值不给逐 token 样本 → 抛错（否则 ε 无法推导，只能变魔数）')
  threw = false
  try { uniformSignature({ meanNll: 5, perTokenNll: [1, 2, 3], vocabSize: V }) } catch { threw = true }
  t.assert(threw, 'meanNll 与 perTokenNll 均值不一致 → 抛错（同一份测量不得有两个口径）')
  t.assert(stddev([1, 1, 1]) === 0 && stddev([1]) === 0, 'stddev 的边界（全等 / 单样本）')

  // ── 相对变化 ──
  const rc = relativeChange({ baseline: 100, candidate: 90, direction: 'lower-is-better' })
  t.assert(Math.abs(rc.rawPct + 10) < 1e-9 && Math.abs(rc.worseningPct + 10) < 1e-9, 'lower-is-better：变快 = 劣化为负')
  const rc2 = relativeChange({ baseline: 100, candidate: 90, direction: 'higher-is-better' })
  t.assert(Math.abs(rc2.worseningPct - 10) < 1e-9, 'higher-is-better：同向数字方向反转')
  threw = false
  try { relativeChange({ baseline: 0, candidate: 1 }) } catch { threw = true }
  t.assert(threw, 'baseline=0 抛错（不得用 Infinity 冒充结论）')

  // ── 双重门禁：必须区分"测量不成立"与"数值未达标" ──
  const badValidity = dualGate({
    accuracy: { dropPct: 1 }, perf: { gainPct: 50 },
    validity: [{ name: 'uniform-signature', ok: false, detail: '输出均匀：模型未加载' }],
    maxAccuracyDropPct: 5, minPerfGainPct: 10,
  })
  t.assert(badValidity.pass === false && badValidity.validityOk === false, '有效性问题 → 不通过，且 validityOk=false')
  t.assert(/测量不成立/.test(badValidity.reason), `reason 指明是"测量不成立"而不是"没达标"（实际：${badValidity.reason}）`)
  const failNum = dualGate({ accuracy: { dropPct: 9 }, perf: { gainPct: 50 }, validity: [{ name: 'ok', ok: true }], maxAccuracyDropPct: 5, minPerfGainPct: 10 })
  t.assert(failNum.pass === false && failNum.validityOk === true, '数值未达标 → 通过有效性但整体 FAIL')
  t.assert(/未达标/.test(failNum.reason), 'reason 区分"数值未达标"')
  const pass = dualGate({ accuracy: { dropPct: 1 }, perf: { gainPct: 50 }, validity: [{ name: 'ok', ok: true }], maxAccuracyDropPct: 5, minPerfGainPct: 10 })
  t.assert(pass.pass === true, '双门禁同时满足 → 通过')
  t.assert(pass.checks.filter((c) => c.kind === 'validity').length === 1, 'checks 里保留 validity 与数值项（可审计）')

  // ── 浮点指纹：判"逐位相同"而不是"看起来接近" ──
  const f1 = await floatFingerprint([1.5, 2.5, 3.5])
  const f2 = await floatFingerprint([1.5, 2.5, 3.5])
  const f3 = await floatFingerprint([1.5, 2.5, 3.5000001])
  t.assert(f1.f32 === f2.f32 && f1.f64 === f2.f64, '同一组数值 → 指纹相同（可复现）')
  t.assert(f1.f64 !== f3.f64, 'f64 层面能区分极小差异（f32 可能相同，故两种都报）')
  t.assert(typeof f1.f32 === 'string' && f1.f32.startsWith('sha256:'), '指纹是 sha256 形态')
}
