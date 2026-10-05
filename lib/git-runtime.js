/**
 * Merged git runtime — union of the two runtimes that shipped with
 * dsh-agent-workflow (`host/git-runtime.js`) and dsh-subagent-workflow
 * (`host/git-runtime.js`).
 *
 * The two upstream files were near-duplicates: the workflow variant was a
 * strict superset except for `worktreeBase` / `mergeBranch`, which only the
 * subagent variant had. Since both planes now live in one plugin and share one
 * worktree layout, they must share one runtime — two divergent copies of
 * `inspect()` would disagree about the same repository.
 *
 * Every public method from both originals is preserved verbatim in behaviour.
 */

import { mkdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

const OUTPUT_CAP_BYTES = 1 << 20

/**
 * Committer identity for merges the plugin performs.
 *
 * The two upstream runtimes signed with different names
 * (`dsh-agent-workflow` / `dsh-subagent-workflow`). Since both planes now share
 * one runtime, a single identity is used so the produced history is uniform —
 * and `-c` overrides are per-invocation, so the user's own git config is never
 * written to.
 */
const COMMITTER = ['-c', 'user.name=dsh-graph-workflow', '-c', 'user.email=dsh-graph-workflow@local']

/** Build a git command runner on top of the harness `subprocess` service. */
export function subprocessRunner(ctx) {
  return {
    async run(argv, cwd, signal) {
      signal?.throwIfAborted()
      const handle = ctx.subprocess.spawn({
        argv: ['git', ...argv],
        cwd,
        stdio: { stdin: 'ignore', stdout: { maxBytes: OUTPUT_CAP_BYTES }, stderr: { maxBytes: OUTPUT_CAP_BYTES } },
        graceMs: 10_000,
        signal,
      })
      const outcome = await handle.done
      signal?.throwIfAborted()
      return {
        exitCode: outcome.exitCode,
        stdout: handle.collected.stdout?.readFrom(0).text ?? '',
        stderr: handle.collected.stderr?.readFrom(0).text ?? '',
      }
    },
  }
}

function oneLine(value) {
  return String(value || '').trim().split(/\r?\n/)[0] || ''
}

function errorResult(code, result) {
  return { ok: false, code, detail: oneLine(result && (result.stderr || result.stdout)) }
}

/**
 * Worktree layout shared by both orchestration planes:
 *   <parent-of-repo>/.dsh-worktrees/<repo>/<workflow>/<worker>
 *
 * Keeping one implementation matters because the peer-session plane and the
 * subagent plane must agree on where a worker's artifacts live, otherwise a
 * worker created by one plane cannot be read or merged by the other.
 */
export function worktreeBaseOf(cwd) {
  return join(dirname(cwd), '.dsh-worktrees', basename(cwd))
}

export class GitRuntime {
  constructor(runner) {
    this.runner = runner
  }

  /** Full repository state, including `--git-common-dir` for cross-worktree checks. */
  async inspect(cwd, signal) {
    const root = await this.runner.run(['rev-parse', '--show-toplevel'], cwd, signal)
    if (root.exitCode !== 0) return errorResult('not-a-git-repository', root)
    const common = await this.runner.run(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd, signal)
    if (common.exitCode !== 0) return errorResult('git-common-dir-unavailable', common)
    const head = await this.runner.run(['rev-parse', 'HEAD'], cwd, signal)
    if (head.exitCode !== 0) return errorResult('git-head-unavailable', head)
    const branch = await this.runner.run(['branch', '--show-current'], cwd, signal)
    if (branch.exitCode !== 0 || !oneLine(branch.stdout)) return errorResult('detached-head', branch)
    const status = await this.runner.run(['status', '--porcelain=v1', '--untracked-files=normal'], cwd, signal)
    if (status.exitCode !== 0) return errorResult('git-status-failed', status)
    return {
      ok: true,
      root: oneLine(root.stdout),
      commonDir: oneLine(common.stdout),
      head: oneLine(head.stdout),
      branch: oneLine(branch.stdout),
      clean: String(status.stdout || '').trim() === '',
      status: String(status.stdout || '').trim(),
    }
  }

  /** Worker artifact zone path (peer-session plane layout). */
  workerPath(repoRoot, workflowSlug, workerSlug) {
    return join(dirname(repoRoot), '.dsh-worktrees', basename(repoRoot), workflowSlug, workerSlug)
  }

  /** Base worktree directory for one repository (subagent plane layout). */
  worktreeBase(cwd) {
    return worktreeBaseOf(cwd)
  }

  async createWorktree({ repoRoot, path, branch, startOid, signal }) {
    await mkdir(dirname(path), { recursive: true })
    const checked = await this.runner.run(['check-ref-format', '--branch', branch], repoRoot, signal)
    if (checked.exitCode !== 0) return errorResult('bad-worker-branch', checked)
    const added = await this.runner.run(['worktree', 'add', '-b', branch, path, startOid], repoRoot, signal)
    if (added.exitCode !== 0) return errorResult('worktree-add-failed', added)
    return { ok: true, path, branch, startOid }
  }

  async removeWorktree(repoRoot, path, signal) {
    const removed = await this.runner.run(['worktree', 'remove', '--force', path], repoRoot, signal)
    return removed.exitCode === 0 ? { ok: true } : errorResult('worktree-remove-failed', removed)
  }

  /**
   * Dry-run merge via `merge-tree --write-tree`: reports conflicts without
   * touching either worktree, so a failed preflight leaves no trace.
   */
  async preflightMerge({ sourceCwd, targetCwd, signal }) {
    const [source, target] = await Promise.all([this.inspect(sourceCwd, signal), this.inspect(targetCwd, signal)])
    if (!source.ok) return source
    if (!target.ok) return target
    if (source.commonDir !== target.commonDir) return { ok: false, code: 'git-repository-mismatch' }
    if (!source.clean) return { ok: false, code: 'source-worktree-dirty', detail: source.status }
    if (!target.clean) return { ok: false, code: 'target-worktree-dirty', detail: target.status }
    const tree = await this.runner.run(['merge-tree', '--write-tree', '--messages', target.head, source.head], target.root, signal)
    if (tree.exitCode !== 0) return errorResult('git-conflict', tree)
    const treeOid = oneLine(tree.stdout)
    if (!/^[0-9a-f]{40,64}$/i.test(treeOid)) return errorResult('git-merge-tree-invalid', tree)
    return {
      ok: true,
      repoRoot: target.root,
      sourceHead: source.head,
      sourceBranch: source.branch,
      targetHead: target.head,
      targetBranch: target.branch,
      treeOid,
    }
  }

  /** no-ff merge of one exact source head, fenced on the expected target head. */
  async commitMerge({ targetCwd, sourceHead, expectedTargetHead, message, signal }) {
    const target = await this.inspect(targetCwd, signal)
    if (!target.ok) return target
    if (!target.clean) return { ok: false, code: 'target-worktree-dirty', detail: target.status }
    if (target.head !== expectedTargetHead) return { ok: false, code: 'target-git-head-moved', actual: target.head }
    const merged = await this.runner.run([
      ...COMMITTER,
      'merge', '--no-ff', '--no-edit', '-m', message, sourceHead,
    ], targetCwd, signal)
    if (merged.exitCode !== 0) return errorResult('git-merge-failed', merged)
    const after = await this.inspect(targetCwd, signal)
    if (!after.ok) return after
    if (!after.clean) return { ok: false, code: 'target-dirty-after-merge', detail: after.status }
    return { ok: true, head: after.head, branch: after.branch, previousHead: expectedTargetHead }
  }

  /** no-ff merge of a named branch into the current worktree (artifact plane). */
  async mergeBranch({ targetCwd, branch, message, signal }) {
    const target = await this.inspect(targetCwd, signal)
    if (!target.ok) return target
    if (!target.clean) return { ok: false, code: 'main-worktree-dirty', detail: target.status }
    const merged = await this.runner.run([
      ...COMMITTER,
      'merge', '--no-ff', '--no-edit', '-m', message, branch,
    ], targetCwd, signal)
    if (merged.exitCode !== 0) return errorResult('git-merge-failed', merged)
    const after = await this.inspect(targetCwd, signal)
    if (!after.ok) return after
    return { ok: true, head: after.head, previousHead: target.head }
  }

  async isAncestor(cwd, ancestor, descendant, signal) {
    const result = await this.runner.run(['merge-base', '--is-ancestor', ancestor, descendant], cwd, signal)
    return result.exitCode === 0
  }

  /**
   * Resolve an interrupted merge after a crash: finish it when the target still
   * sits at the planned head, accept it when both parents are already reachable,
   * and refuse to guess otherwise.
   */
  async recoverMerge({ targetCwd, plan, message, signal }) {
    const target = await this.inspect(targetCwd, signal)
    if (!target.ok) return target
    if (target.head === plan.targetHead) {
      return await this.commitMerge({
        targetCwd, sourceHead: plan.sourceHead,
        expectedTargetHead: plan.targetHead, message, signal,
      })
    }
    const containsSource = await this.isAncestor(targetCwd, plan.sourceHead, target.head, signal)
    const containsTarget = await this.isAncestor(targetCwd, plan.targetHead, target.head, signal)
    if (!containsSource || !containsTarget) return { ok: false, code: 'ambiguous-git-recovery', actual: target.head }
    return { ok: true, head: target.head, branch: target.branch, previousHead: plan.targetHead, recovered: true }
  }
}
