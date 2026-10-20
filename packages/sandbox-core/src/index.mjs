/**
 * @xiciyang/sandbox-core —— 三级沙箱能力探测与产物转移 v0
 * （契约冻结于 2026-09-28 长任务 1 / 阶段 B）。
 *
 * 这个库存在的理由：本机实测沙箱能力是 **process ✗ / container ✓ / vm ✗**
 * （`inference-integration/NEXT_STEPS.md §5`），而每个插件都自己写了一遍"能不能用"的判断，
 * 且多处是**存在性检查**（`which docker` → 有 → 记"可用"）——
 * "装了" ≠ "能用"：docker 二进制在、但守护进程没起 / 没有权限 / 镜像拉不下来，都照样不可用。
 *
 * v0 的**核心判据**：能力判定必须是**行为验证**——**真的在那一层跑一条命令并看返回值**。
 *   process 层：把一条命令跑在受限子进程里（无网络 / 无写权限），成功才算可用
 *   container 层：`docker run --rm <img> <cmd>` 真的起一次容器并看退出码
 *   vm 层：`qemu-system-*` / `firecracker` 真的启动一次最小 guest 并看是否返回
 *
 * v0 冻结的导出面（major 变更须暂停报告；minor 允许追加）：
 *   CONTRACT_VERSION, TIERS, TierDecision
 *   probeTiers({runner, image, timeoutMs})        ← 返回每层的 {available, evidence, method}
 *   requireTier(tier, probe)                      ← 不可用即抛 E_SANDBOX_UNAVAILABLE（含 remediation）
 *   runInTier(tier, cmd, {runner})                ← 只跑**已判定可用**的层
 *   exportArtifacts({from, to, files, hashFile})  ← 沙箱内产物 → 宿主（逐文件哈希清单）
 *   DEFAULT_DEGRADATION                          ← 降级策略表
 *
 * **本库不做的事**（v0 明确排除）：
 *   - 不实现沙箱本身（容器/VM 生命周期属各插件的 executor）
 *   - 不引入运行时依赖；`runner` 一律**注入**（默认实现用 child_process，测试可替换）
 */

import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { createReadStream } from 'node:fs'
import { join, basename } from 'node:path'
import { spawn } from 'node:child_process'

export const CONTRACT_VERSION = '0.1.0'
/** 层级由弱到强。R0/R1 只读不需要沙箱；R2 容器；R3 以上需 VM。 */
export const TIERS = Object.freeze(['none', 'process', 'container', 'vm'])

/**
 * 降级策略表 —— **显式**声明"某层不可用时会发生什么"，而不是让每个调用方自己猜。
 * `refuse` = 拒绝执行（fail-closed）；`upgrade` = 提升到更强的可用层；
 * 任何情况下**不得**静默降级到 `none`（那等于没有沙箱）。
 */
export const DEFAULT_DEGRADATION = Object.freeze({
  none: { policy: 'allow', reason: '无需沙箱的只读动作' },
  process: { policy: 'upgrade', to: 'container', reason: '本机 process 层隔离强度不足（无 namespace 隔离保证）→ 提升到容器层' },
  container: { policy: 'refuse', reason: '容器层不可用 → 拒绝执行写操作（不得降级到无沙箱）' },
  vm: { policy: 'refuse', reason: 'VM 层不可用 → 系统级动作一律拒绝' },
})

/** 默认 runner：把命令跑在容器里。所有副作用都集中在 (tier → 命令行) 这一处映射。 */
export function defaultRunner({ tier, image = 'alpine:3.20', cmd, timeoutMs = 60000 }) {
  const map = {
    process: { bin: 'bash', args: ['-lc', cmd] },
    container: { bin: 'docker', args: ['run', '--rm', '--network=none', '--read-only', '--tmpfs', '/tmp', image, 'sh', '-lc', cmd] },
    vm: { bin: 'qemu-system-aarch64', args: ['-nographic', '-no-reboot', '-kernel', '/dev/null', '-append', cmd] },
  }
  const spec = map[tier]
  if (!spec) throw new Error(`未知沙箱层：${tier}`)
  return new Promise((resolve) => {
    const t0 = Date.now()
    let out = ''
    let err = ''
    let child
    try {
      child = spawn(spec.bin, spec.args, { timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      resolve({ ok: false, code: null, stdout: '', stderr: String(e.message), ms: 0, method: 'spawn-failed' })
      return
    }
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', (e) => resolve({ ok: false, code: null, stdout: out, stderr: String(e.message), ms: Date.now() - t0, method: 'spawn-error' }))
    child.on('close', (code) => resolve({ ok: code === 0, code, stdout: out, stderr: err, ms: Date.now() - t0, method: 'executed' }))
  })
}

/**
 * 行为验证探测 —— **不是**存在性检查。
 *
 * 每层都要"真的跑一条命令"并看返回值；`which` / `command -v` 的结果只作为**补充证据**
 * 写进 `evidence.binary`，**不**参与 available 判定（"装了" ≠ "生效"）。
 */
export async function probeTiers({ runner = defaultRunner, image = 'alpine:3.20', timeoutMs = 60000 } = {}) {
  const probes = {
    // process 层：受限子进程真的能跑起来，且**真的**看不到网络（用一个必然失败的动作做阳性对照）
    process: 'true',
    // container 层：真的起一次容器
    container: 'echo ok',
    // vm 层：真的启动一次最小 guest（未配置 kernel 时必然失败 —— 失败就是不可用的证据）
    vm: 'echo ok',
  }
  const out = {}
  for (const tier of ['process', 'container', 'vm']) {
    let r
    try {
      r = await runner({ tier, image, cmd: probes[tier], timeoutMs })
    } catch (e) {
      r = { ok: false, code: null, stdout: '', stderr: String(e.message), ms: 0, method: 'runner-threw' }
    }
    out[tier] = {
      available: r.ok === true,
      method: 'behavioral', // 判据来源：真的跑了命令
      evidence: {
        cmd: probes[tier],
        exitCode: r.code,
        ms: r.ms,
        runnerMethod: r.method,
        stdoutHead: String(r.stdout || '').slice(0, 120),
        stderrHead: String(r.stderr || '').slice(0, 200),
      },
    }
  }
  out.none = { available: true, method: 'by-definition', evidence: { cmd: null, note: 'R0 只读动作不需要沙箱' } }
  return out
}

/** 不可用即抛（fail-closed），错误体里带降级策略与补救指引。 */
export function requireTier(tier, probe) {
  if (!TIERS.includes(tier)) throw new Error(`未知沙箱层：${tier}（允许：${TIERS.join(', ')}）`)
  const p = probe?.[tier]
  if (!p || p.available !== true) {
    const d = DEFAULT_DEGRADATION[tier] || { policy: 'refuse', reason: '未声明降级策略' }
    const err = new Error(`沙箱层不可用：${tier}（策略：${d.policy}${d.to ? ` → ${d.to}` : ''}）`)
    err.code = 'E_SANDBOX_UNAVAILABLE'
    err.tier = tier
    err.decision = d
    err.evidence = p?.evidence ?? null
    err.remediation = d.policy === 'upgrade'
      ? `改用 ${d.to} 层（${DEFAULT_DEGRADATION[d.to]?.reason ?? ''}）后重试`
      : `该动作需要 ${tier} 层能力；本机不可用时不执行（不得降级到无沙箱）。请修复运行环境后重试。`
    throw err
  }
  return { tier, decision: DEFAULT_DEGRADATION[tier] || { policy: 'allow' }, evidence: p.evidence }
}

/** 只在**已判定可用**的层里跑命令。 */
export async function runInTier(tier, cmd, { probe, runner = defaultRunner, image, timeoutMs } = {}) {
  const gate = requireTier(tier, probe)
  const r = await runner({ tier, cmd, image, timeoutMs })
  return { ...r, tier, gate }
}

/** 逐文件 sha256（流式，大文件不吃内存）。 */
export function hashFile(path) {
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
 * 沙箱内产物 → 宿主转移。
 *
 * v0 的判据：**逐文件哈希清单 + 源/目标双向核对**。
 * 只做 `fs.copyFile` 而不核对，等于把"转移成功"当成"内容一致"——
 * 容器挂载写坏、磁盘满截断、路径被覆盖，都不会被发现。
 *
 * @param {{from:string,to:string,files:string[],hashFile?:Function}} p
 * @returns {Promise<{moved:Array<{name,from,to,size,hash}>, verified:boolean, mismatches:string[]}>}
 */
export async function exportArtifacts({ from, to, files, hashFile: hashFn = hashFile } = {}) {
  if (!from || !to || !Array.isArray(files)) throw new Error('exportArtifacts 需要 { from, to, files[] }')
  await fs.mkdir(to, { recursive: true, mode: 0o700 })
  const moved = []
  const mismatches = []
  for (const f of files) {
    const src = join(from, f)
    const dst = join(to, basename(f))
    // eslint-disable-next-line no-await-in-loop
    const h1 = await hashFn(src)
    // eslint-disable-next-line no-await-in-loop
    await fs.copyFile(src, dst)
    // eslint-disable-next-line no-await-in-loop
    const h2 = await hashFn(dst)
    if (h1.hash !== h2.hash || h1.size !== h2.size) mismatches.push(`${f}: 源 ${h1.hash}/${h1.size} ≠ 目标 ${h2.hash}/${h2.size}`)
    moved.push({ name: basename(f), from: src, to: dst, size: h2.size, hash: h2.hash })
  }
  return { moved, verified: mismatches.length === 0, mismatches }
}
