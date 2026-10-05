/**
 * dsh-graph-workflow — one installable plugin carrying all three planes.
 *
 * This package is the full-inheritance merge of:
 *   1. dsh-session-graph    → information DAG, merge pipeline, Git-graph GUI
 *   2. dsh-agent-workflow   → peer-session workflow protocol (WAL, leased manager)
 *   3. dsh-subagent-workflow→ same-session subagent workflow + worktree ledger
 *
 * Why one plugin instead of three mounted rows:
 *   - `dsh-subagent-workflow` hard-depends on the `sessionGraph` service, and
 *     `dsh-agent-workflow` did too, so the three were never independently
 *     installable — they formed a stack with an implicit boot order.
 *   - All three register agent-scoped prompt sections and tools. Consolidating
 *     them puts every registration under one lifecycle and one `inject` list,
 *     so Cordis activation is decided once instead of three times with three
 *     different park/retry outcomes.
 *   - The GUI is one client bundle either way; three packages meant three
 *     module-loader entries and three style tags for one sidebar.
 *
 * The three planes are unchanged in behaviour. The only cross-plane changes:
 *   - the graph plane's coordinator seam accepts MORE THAN ONE policy (both
 *     orchestration planes register), composing them deny-wins;
 *   - the peer-session plane's `setup` callbacks no longer return a value
 *     (this is the crash that retired it upstream — see lib/workflow.js);
 *   - the graph service is handed to the orchestration planes directly rather
 *     than injected, because this package provides it (a self-inject would park
 *     the plugin forever).
 *
 * Added on top of the inheritance (not a replacement for anything):
 *   - a structured provenance chain for every extracted proposition —
 *     claim → commit key → exact event range in the session log — with a
 *     reverse lookup (`session_graph_trace`) and visible chain health, so a
 *     conclusion can be audited back to the turn it came from.
 *
 * Routes: /sgx/* (information graph) and /awf/* (workflow state), loopback-only.
 * Service: `sessionGraph` (name preserved for ecosystem compatibility).
 */

import { apply as graphPlane, graphInject } from './graph.js'
import { installWorkflowPlane, workflowInject } from './workflow.js'
import { installSubagentFlowPlane, subagentFlowInject } from './subagent-flow.js'

export const name = 'dsh-graph-workflow'

/**
 * Union of every plane's service needs, minus `sessionGraph` (this package
 * PROVIDES it). Cordis waits until all of these are available, then calls
 * `apply` once.
 */
export const inject = [
  ...new Set([
    ...graphInject,
    ...workflowInject,
    ...subagentFlowInject.filter((service) => service !== 'sessionGraph'),
  ]),
].filter((service) => service !== 'sessionGraph')

export function apply(ctx, config) {
  const options = config && typeof config === 'object' ? config : {}
  const enabled = (key) => options[key] !== false

  // 1) Information-graph plane: provides `sessionGraph` and returns the
  //    capability handle the orchestration planes need. It also owns the
  //    `agent/created` surface for the graph tools and the /sgx routes.
  //    `ctx.provide('sessionGraph', …)` happens inside this plane.
  //
  //    This plane is the base of the stack: the orchestration planes are
  //    clients of its coordinator seam, so disabling it disables them too
  //    rather than leaving them without a service to register against.
  const graph = enabled('enableGraph') ? graphPlane(ctx, options) : null

  const result = { graph, workflow: null, subagentFlow: null }

  if (!graph) {
    console.error('[git-graph] enableGraph=false: the workflow planes depend on the graph coordinator seam and were not mounted')
    return result
  }

  // 2) Peer-session workflow plane (leased manager, epoch fencing, WAL).
  //    Its coordinator policy is the restrictive one: while a session belongs
  //    to a workflow, direct graph mutations must go through workflow tools.
  if (enabled('enableWorkflow')) {
    try {
      result.workflow = installWorkflowPlane(ctx, graph.service)
    } catch (e) {
      // One plane failing must not take the graph and its GUI down with it.
      console.error('[git-graph] workflow plane failed to mount', e)
    }
  }

  // 3) Same-session subagent workflow plane (worktree artifact zones, ledger).
  //    Its coordinator policy is permissive and never blocks; under deny-wins
  //    composition it cannot weaken the peer-session plane's guard.
  if (enabled('enableSubagentFlow')) {
    try {
      result.subagentFlow = installSubagentFlowPlane(ctx, graph.service)
    } catch (e) {
      console.error('[git-graph] subagent-flow plane failed to mount', e)
    }
  }

  return result
}
