# ai-infra-core

**Seven zero-dependency primitives for proving things about models — and failing loudly when a proof is invalid.**

Every library here exists because the same bug was found twice in the inference stack: a number was
reported as a result when it was actually an *invalid measurement*. A truncated model quantized for
436 s and was signed off as "0% accuracy loss" because its output was uniform and both perplexities
were bit-identical. That incident is why `testing-core` has a validity gate before a value gate.

These libraries back the published `inference-serving` / `inference-quantization` / `inference-tuning`
plugins and the DSH training stack. They are extracted here so the judgment rules can be reviewed,
reused and attacked independently of any GPU.

- **Zero runtime dependencies** — Node built-ins only
- **Zero coupling between libraries** — each package imports nothing from its siblings
- **Contract-frozen** — each package ships a `CONTRACT.md` with a version and an explicit export list;
  adding is minor, removing or changing semantics is major
- **Honest about coverage** — checks that cannot run on your machine are reported as `SKIP` with a
  reason, never as a pass

## Packages

| Package | What it decides | Why it exists |
|---|---|---|
| `@xiciyang/testing-core` | NLL / perplexity / uniform signature / relative change / **dual gate** / float fingerprint / forgetting gate | A value only counts after validity is established |
| `@xiciyang/data-core` | Content hashing, dedup, deterministic split, **leakage removal**, lineage, PII scan | Calibration and test sets must not intersect |
| `@xiciyang/state-core` | Shared YAML dialect, schema validation, atomic write, optimistic concurrency | Three plugins had three dialects |
| `@xiciyang/audit-core` | Append-only hash chains (two variants) + independent re-verification | "Audited" means a third party can recompute it |
| `@xiciyang/sandbox-core` | Three-level sandbox behaviour probe and degrade policy | "Sandboxed" must be measured, not assumed |
| `@xiciyang/training-core` | Public training loop, checkpoint, resource limits, audit hooks | Framework code stays out of the plugins |
| `@xiciyang/evidence-core` | Facts → relations → derivation → case library | An inference must not masquerade as a fact |

Each package is `packages/<name>/` with `src/`, `tests/contract.mjs` and `CONTRACT.md`.

## 安装 / Install

No registry package yet — use it as a source dependency or a workspace checkout:

```bash
git clone https://github.com/xiciyang/ai-infra-core.git
cd ai-infra-core
node --version    # >= 20
```

Each package is standard ESM and can be referenced by path (`"@xiciyang/testing-core": "file:../ai-infra-core/packages/testing-core"`)
or copied into a monorepo. No build step, no install step.

## 用法 / Usage

```bash
node scripts/run-all.mjs                 # contract suite
node scripts/run-all.mjs --json          # machine-readable, includes expected/declared lists
node scripts/run-all.mjs audit-core      # one package
```

```js
import { dualGate, uniformSignature, perplexity } from '@xiciyang/testing-core'
import { splitDeterministic, assertNoLeak } from '@xiciyang/data-core'
import { appendAudit, verifyChain } from '@xiciyang/audit-core'
```

`CONTRACT.md` in each package is the authoritative export surface; treat it as frozen.

## 配置 / Config

The suite is configured only by environment variables (all optional):

| Variable | Effect | Default |
|---|---|---|
| `AI_INFRA_ROOT` | recompute real audit chains under this root | unset → skip, reported |
| `AI_INFRA_STATE` | cross-check the YAML dialect against real state files | unset → skip, reported |
| `INFERENCE_WORKSPACE` | compare the dialect against sibling plugin parsers | unset → skip, reported |

Skipped checks are printed with a reason and excluded from the assertion count. There is no hidden config file.

## 兼容 / Compatibility

- Node ≥ 20, ESM only, Linux/macOS (no native addons).
- Zero runtime dependencies; no network access in tests.
- Verified on Node 24.18 and against the DSH 0.2.0-rc.2 inference stack (real audit chains + sibling YAML dialects).
- DSH is a consumer, not a requirement.

## Run the contracts

```bash
node scripts/run-all.mjs          # human-readable
node scripts/run-all.mjs --json   # machine-readable
```

Expected on a clean machine: **264 assertions, 0 failures, 4 skips**. The skips say so explicitly.

On a machine that has the full inference stack, point the suite at its real state to also recompute
live audit chains and cross-check the YAML dialect against sibling implementations:

```bash
AI_INFRA_ROOT=~/.ai-infra \
AI_INFRA_STATE=~/.ai-infra/state \
INFERENCE_WORKSPACE=~/deepseek_harness \
node scripts/run-all.mjs
```

That run additionally recomputes real audit shards (the strongest check here: a one-character change
to canonical JSON breaks verification of hundreds of on-disk records) and reports **359 assertions**.

The assertion count is deliberately **not** a constant: two libraries verify state that lives outside
this repo. The reproducible criterion is **0 failures**, with the skip list shown.

## What this is not

- Not a framework. No scheduler, no plugin loader, no model runtime.
- Not a benchmark. It contains judgment primitives, not datasets or leaderboards.
- Not coupled to DSH. The libraries are plain ESM and run under Node ≥ 20; DSH is the consumer, not a requirement.

## Provenance

Extracted from the private `inference-*` suite (2026-09/10). Contract versions are preserved as
frozen; this repository is the public home going forward. No absolute paths, credentials or machine
artifacts are included; the only `file:` anchor used by tests points at a fixture in this repo.

## License

BSD-3-Clause. See `LICENSE`.
