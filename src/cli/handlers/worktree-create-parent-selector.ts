import { isWorkspaceKey, parseWorkspaceKey } from '../../shared/workspace-scope'
import { getOptionalStringFlag } from '../flags'
import { RuntimeClientError, RuntimeRpcFailureError, type RuntimeClient } from '../runtime-client'
import { getOptionalWorktreeSelector } from '../selectors'

export type CreateParentSelector = {
  parentWorktree?: string
  parentWorkspace?: string
}

const CREATE_PARENT_CONFLICT_MESSAGE = 'Choose either one parent selector or --no-parent.'

export function assertCreateParentFlagsCompatible(flags: Map<string, string | boolean>): void {
  if (flags.has('parent-worktree') && flags.get('no-parent') === true) {
    throw new RuntimeClientError('invalid_argument', CREATE_PARENT_CONFLICT_MESSAGE)
  }
  const parentWorktree = flags.get('parent-worktree')
  if (
    flags.has('parent-worktree') &&
    (typeof parentWorktree !== 'string' || parentWorktree === '')
  ) {
    throw new RuntimeClientError('invalid_argument', 'Missing required --parent-worktree')
  }
}

function getWorkspaceKeyParentSelector(selector: string): string | undefined {
  const rawSelector = selector.startsWith('id:') ? selector.slice('id:'.length) : selector
  return isWorkspaceKey(rawSelector) ? rawSelector : undefined
}

function toExplicitCreateParentWorktreeSelector(selector: string): string {
  const parsed = parseWorkspaceKey(selector)
  return parsed?.type === 'worktree' ? `id:${parsed.worktreeId}` : selector
}

async function assertResolvableExplicitCreateParent(
  selector: string,
  client: RuntimeClient
): Promise<void> {
  const parsed = parseWorkspaceKey(selector)
  if (parsed?.type === 'folder') {
    // Why: missing folder parents still fail at runtime with LINEAGE_PARENT_NOT_FOUND.
    return
  }
  try {
    await client.call('worktree.show', {
      worktree: toExplicitCreateParentWorktreeSelector(selector)
    })
  } catch (error) {
    if (error instanceof RuntimeRpcFailureError) {
      throw new RuntimeClientError(error.code, error.message, error.data)
    }
    throw error
  }
}

export async function resolveCreateParentSelector(
  flags: Map<string, string | boolean>,
  cwd: string,
  client: RuntimeClient
): Promise<CreateParentSelector> {
  const rawParentWorktree = getOptionalStringFlag(flags, 'parent-worktree')
  if (!rawParentWorktree) {
    return {}
  }

  const parentWorkspace = getWorkspaceKeyParentSelector(rawParentWorktree)
  if (parentWorkspace) {
    // Why: create exposes one public parent flag, while the runtime still needs
    // workspace keys to preserve folder/worktree lineage accurately.
    await assertResolvableExplicitCreateParent(parentWorkspace, client)
    return { parentWorkspace }
  }

  const parentWorktree = await getOptionalWorktreeSelector(flags, 'parent-worktree', cwd, client)
  const resolvedParentWorkspace = parentWorktree
    ? getWorkspaceKeyParentSelector(parentWorktree)
    : undefined
  if (resolvedParentWorkspace) {
    // Why: active/current may resolve to a folder workspace pseudo-worktree id.
    await assertResolvableExplicitCreateParent(resolvedParentWorkspace, client)
    return { parentWorkspace: resolvedParentWorkspace }
  }

  if (parentWorktree) {
    await assertResolvableExplicitCreateParent(parentWorktree, client)
  }

  return {
    parentWorktree
  }
}
