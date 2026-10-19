/**
 * sandbox-core 契约测试 —— 重点在**行为验证而不是存在性检查**：
 * 用一个受控 runner 模拟"二进制在但跑不起来"，断言能力判定仍为不可用。
 * 这正是本机真实教训："装了" ≠ "生效"。
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  CONTRACT_VERSION, TIERS, DEFAULT_DEGRADATION, probeTiers, requireTier, runInTier, exportArtifacts,
} from '../src/index.mjs'

export const NAME = 'sandbox-core 契约（v0 冻结面）'

/** 受控 runner：按 tier 给出**预设的行为结果**，不真的起容器。 */
const mkRunner = (behavior) => async ({ tier, cmd }) => behavior[tier] ?? { ok: false, code: 127, stdout: '', stderr: 'command not found', ms: 1, method: 'mock' }

export async function run(t) {
  t.assert(CONTRACT_VERSION === '0.1.0', `CONTRACT_VERSION 已冻结（${CONTRACT_VERSION}）`)
  t.assert(JSON.stringify(TIERS) === JSON.stringify(['none', 'process', 'container', 'vm']), '层级闭集')
  t.assert(DEFAULT_DEGRADATION.container.policy === 'refuse', '容器层不可用 → refuse（不得降级到无沙箱）')
  t.assert(DEFAULT_DEGRADATION.process.policy === 'upgrade' && DEFAULT_DEGRADATION.process.to === 'container', 'process 层不可用 → 提升到容器层')

  // ── 行为验证：二进制"在"但跑不起来 ⇒ 不可用 ──
  const allDead = await probeTiers({ runner: mkRunner({}) })
  t.assert(allDead.process.available === false && allDead.container.available === false && allDead.vm.available === false, '三者都跑不起来 → 全部不可用')
  t.assert(allDead.container.method === 'behavioral', '判据来源标注为 behavioral（不是 exists）')
  t.assert(typeof allDead.container.evidence.stderrHead === 'string' && allDead.container.evidence.stderrHead.length > 0, '不可用时保留 stderr 证据（可复核）')
  t.assert(allDead.none.available === true && allDead.none.method === 'by-definition', 'none 层按定义为可用')

  const mixed = await probeTiers({
    runner: mkRunner({
      process: { ok: true, code: 0, stdout: '', stderr: '', ms: 3, method: 'executed' },
      container: { ok: false, code: 125, stdout: '', stderr: 'Cannot connect to the Docker daemon', ms: 12, method: 'executed' },
      vm: { ok: false, code: 1, stdout: '', stderr: 'KVM not available', ms: 8, method: 'executed' },
    }),
  })
  t.assert(mixed.process.available === true && mixed.container.available === false, '本机式形态：process 可用 / container 不可用（与真实探测一致）')
  t.assert(mixed.container.evidence.exitCode === 125, '证据里带容器层的真实退出码')

  // ── 不可用即拒（fail-closed）且带补救指引 ──
  let threw = null
  try { requireTier('container', mixed) } catch (e) { threw = e }
  t.assert(threw && threw.code === 'E_SANDBOX_UNAVAILABLE', '容器层不可用 → E_SANDBOX_UNAVAILABLE')
  t.assert(/不得降级到无沙箱/.test(String(threw.remediation)), '补救指引明确禁止降级到无沙箱')
  t.assert(threw.decision.policy === 'refuse', '错误体带降级决策')
  const okGate = requireTier('process', mixed)
  t.assert(okGate.tier === 'process' && okGate.decision.policy === 'upgrade', '可用层的决策也一并返回（升级策略可见）')

  // ── runInTier：只在已判定可用的层里跑 ──
  const ran = await runInTier('process', 'echo hi', { probe: mixed, runner: mkRunner({ process: { ok: true, code: 0, stdout: 'hi\n', stderr: '', ms: 2, method: 'executed' } }) })
  t.assert(ran.ok === true && ran.tier === 'process' && ran.stdout.includes('hi'), 'runInTier 在可用层执行并回传结果')
  threw = null
  try { await runInTier('container', 'echo hi', { probe: mixed, runner: mkRunner({}) }) } catch (e) { threw = e }
  t.assert(threw && threw.code === 'E_SANDBOX_UNAVAILABLE', 'runInTier 对不可用层拒绝执行（命令根本没跑）')

  // ── 产物转移：逐文件哈希核对（不是"复制完就算成功"）──
  const tmp = mkdtempSync(join(tmpdir(), 'sandbox-core-'))
  const from = join(tmp, 'in'); const to = join(tmp, 'out')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(from, { recursive: true })
  writeFileSync(join(from, 'a.txt'), 'hello')
  writeFileSync(join(from, 'b.bin'), Buffer.from([1, 2, 3, 4]))
  const real = await exportArtifacts({ from, to, files: ['a.txt', 'b.bin'] })
  t.assert(real.verified === true && real.moved.length === 2, `产物转移并逐文件核对通过（${real.moved.length} 个）`)
  t.assert(readFileSync(join(to, 'a.txt'), 'utf8') === 'hello', '目标内容一致')
  t.assert(real.moved.every((m) => m.hash.startsWith('sha256:') && m.size > 0), '清单含逐文件哈希与大小')
  const lying = await exportArtifacts({
    from, to, files: ['a.txt'],
    // 源与目标返回**不同**哈希 —— 模拟"复制后内容不一致"（容器挂载写坏 / 截断）
    hashFile: (() => { let n = 0; return async () => ({ size: 5, hash: `sha256:${n++ === 0 ? 'aa' : 'bb'}` }) })(),
  })
  t.assert(lying.verified === false && lying.mismatches.length === 1, '哈希不符 → verified=false 并列出不匹配项（不得静默通过）')
  rmSync(tmp, { recursive: true, force: true })
}
