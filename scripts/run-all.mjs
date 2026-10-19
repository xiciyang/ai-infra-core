#!/usr/bin/env node
/**
 * 共享库契约测试入口（六个库一把跑）。
 *
 * 用法：
 *   node run-all.mjs            # 人读
 *   node run-all.mjs --json     # 机读
 *   node run-all.mjs testing-core audit-core   # 只跑指定库
 *
 * 退出码：有失败即 1。
 *
 * 这份入口被 `inference-contracts/checks/run-all.mjs` 的 C11 组**直接调用**，
 * 于是三个推理插件 `npm test` → `test:contract` 时就会跑到它 ——
 * 这就是"契约测试进 CI"的落点，不需要改任何插件。
 */
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
export const LIBS = Object.freeze(['testing-core', 'data-core', 'state-core', 'audit-core', 'sandbox-core', 'training-core', 'evidence-core'])

// 库目录映射：默认在 `packages/<name>/`。留这个表是为了以后有库需要非默认位置时，
// 由这里显式登记，不让 runner 去猜。
const LIB_DIRS = Object.freeze({})

const argv = process.argv.slice(2)
const json = argv.includes('--json')
const only = argv.filter((a) => !a.startsWith('--'))
const targets = only.length ? only : LIBS

const results = []
// `--json` 模式必须输出**纯 JSON**：契约测试里的 console.log（进度性说明）会污染管道。
// 这里在 --json 下临时静音 console.log，把说明性输出收进 results 里（保真，不丢信息）。
const realLog = console.log
if (json) console.log = () => {}
for (const lib of targets) {
  if (!LIBS.includes(lib)) { results.push({ lib, ok: false, error: `未知库：${lib}` }); continue }
  const file = join(HERE, LIB_DIRS[lib] ?? join('..', 'packages', lib), 'tests', 'contract.mjs')
  const t = { asserts: 0, failures: [], skipped: [] }
  const assert = (cond, msg) => { t.asserts += 1; if (!cond) t.failures.push(msg) }
  // 跳过通道：**不计入断言数**。给"本机状态不满足前置条件"的检查用。
  // 为什么必须有它：把"没跑"写成 `assert(true, …)` 会同时干两件坏事 ——
  //   ① 恒真项给断言数灌水，使"192 项断言"这类证据数字随本机状态漂移、不可复现；
  //   ② 注释写"不计入"而代码在计数，文档与代码互相矛盾（仪表必须与源码对齐）。
  // 跳过必须显式登记进 skipped[]，否则"没跑"会被静默当成"过了"。
  const skip = (msg) => { t.skipped.push(msg) }
  let name = lib
  try {
    const mod = await import(pathToFileURL(file).href)
    name = mod.NAME || lib
    await mod.run({ assert, skip })
  } catch (e) {
    t.failures.push(`抛出异常：${String(e?.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e)}`)
  }
  results.push({ lib, name, ok: t.failures.length === 0, asserts: t.asserts, skipped: t.skipped, failures: t.failures })
  if (!json) {
    console.log(`\n=== ${name} ===`)
    for (const s of t.skipped) console.log(`SKIP  ${s}`)
    if (t.failures.length === 0) {
      console.log(`PASS  ${t.asserts} 项断言${t.skipped.length ? `（另有 ${t.skipped.length} 项跳过，不计入）` : ''}`)
    } else {
      console.log(`FAIL  ${t.failures.length}/${t.asserts} 项断言未通过：`)
      for (const f of t.failures) console.log(`  - ${f}`)
    }
  }
}

const failed = results.filter((r) => !r.ok)
if (json) {
  console.log = realLog
  process.stdout.write(`${JSON.stringify({
    libs: results,
    // **自描述名册**：调用方必须拿它来断言"该跑的库都跑了"，
    // 而不是断言一个写死的数字（写死数字 = 硬编码覆盖，加一个合法库就会误报。
    // 本仓库明令禁止这种写法，见 CI_COVERAGE_RULES.md）。
    expected: targets,
    declared: LIBS,
    failed: failed.length,
    skipped: results.reduce((a, r) => a + (r.skipped?.length || 0), 0),
  }, null, 2)}\n`)
} else {
  const total = results.reduce((a, r) => a + (r.asserts || 0), 0)
  const skippedTotal = results.reduce((a, r) => a + (r.skipped?.length || 0), 0)
  console.log(`\n${failed.length === 0 ? 'ALL CONTRACTS PASSED' : 'CONTRACT FAILURES'}: `
    + `${results.length - failed.length} passed / ${failed.length} failed；契约断言合计 ${total}`
    + (skippedTotal ? `（另有 ${skippedTotal} 项跳过，不计入）` : ''))
  // 证据口径声明：断言总数不是常量 —— audit-core / state-core 复算的是**本机线上真实链**，
  // 分片数与本机状态变了，断言数就变。可复现的判据是"6 个库 0 失败"，不是某个固定数字。
  console.log('注：断言总数随本机状态变化（复算真实链 / 真实状态文件的库），'
    + '引用证据时须同时给出本机状态；可复现判据 = 7 个库 0 失败。')
}
process.exit(failed.length === 0 ? 0 : 1)
