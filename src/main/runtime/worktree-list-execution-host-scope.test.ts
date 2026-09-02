import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { GitWorktreeInfo } from '../../shared/worktree/types'

// Why: SSH worktrees sort after local rows, so the default cap can drop every
// remote row while still reporting truncation — callers need hostScope to see
// which hosts were absent from the listing.

const LOCAL_REPO_ID = 'repo-local'
const SSH_REPO_ID = 'repo-ssh'

const REPOS = [
  {
    id: LOCAL_REPO_ID,
    path: '/tmp/local-worktree',
    displayName: 'local',
    badgeColor: '#000000',
    addedAt: 0
  },
  {
    id: SSH_REPO_ID,
    path: '/remote/ssh-worktree',
    displayName: 'ssh',
    badgeColor: '#000000',
    addedAt: 0,
    connectionId: 'box-1'
  }
]

type TestResolvedWorktree = {
  id: string
  repoId: string
  path: string
  branch: string
  displayName: string
  hostId: 'local' | 'ssh:box-1'
  isArchived: boolean
  isMainWorktree: boolean
  linkedIssue: null
  parentWorktreeId: null
  childWorktreeIds: []
  lineage: null
  git: GitWorktreeInfo
}

function makeStore() {
  const session: WorkspaceSessionState = getDefaultWorkspaceSession()
  return {
    getWorkspaceSession: vi.fn(() => session),
    getWorkspaceSessionHostIds: vi.fn(() => ['local', 'ssh:box-1']),
    getFolderWorkspaces: vi.fn(() => []),
    getProjectGroups: vi.fn(() => []),
    setWorkspaceSession: vi.fn(),
    getRepos: vi.fn(() => REPOS),
    getRepo: vi.fn((id: string) => REPOS.find((repo) => repo.id === id)),
    getAllWorktreeMeta: vi.fn(() => ({})),
    getWorktreeMeta: vi.fn(() => undefined),
    setWorktreeMeta: vi.fn(),
    removeWorktreeMeta: vi.fn(),
    getSettings: vi.fn(() => ({ workspaceDir: '/tmp/workspaces' })),
    getProjects: vi.fn(() => []),
    getAllWorktreeLineage: vi.fn(() => ({}))
  }
}

function resolvedWorktree(
  repoId: string,
  path: string,
  hostId: 'local' | 'ssh:box-1'
): TestResolvedWorktree {
  const id = `${repoId}::${path}`
  return {
    id,
    repoId,
    path,
    branch: 'main',
    displayName: path,
    hostId,
    isArchived: false,
    isMainWorktree: true,
    linkedIssue: null,
    parentWorktreeId: null,
    childWorktreeIds: [],
    lineage: null,
    git: { isClean: true, ahead: 0, behind: 0 }
  }
}

describe('listManagedWorktrees host scope', () => {
  it('names SSH hosts omitted when truncation drops every remote row', async () => {
    const runtime = new OrcaRuntimeService(makeStore() as never)
    const localRows = Array.from({ length: 3 }, (_, index) =>
      resolvedWorktree(LOCAL_REPO_ID, `/aaa/local-${index}`, 'local')
    )
    const sshRow = resolvedWorktree(SSH_REPO_ID, '/zzz/ssh', 'ssh:box-1')
    vi.spyOn(runtime, 'listResolvedWorktrees').mockResolvedValue([...localRows, sshRow] as never)

    const result = await runtime.listManagedWorktrees(undefined, 2)

    expect(result.worktrees.every((worktree) => worktree.hostId === 'local')).toBe(true)
    expect(result.truncated).toBe(true)
    expect(result.hostScope?.hostIds).toEqual(['local'])
    expect(result.hostScope?.omittedHostIds).toEqual(['ssh:box-1'])
  })
})

describe('getWorktreePs host scope', () => {
  it('names SSH hosts omitted when truncation drops every remote row', async () => {
    const runtime = new OrcaRuntimeService(makeStore() as never)
    const localRows = Array.from({ length: 3 }, (_, index) =>
      resolvedWorktree(LOCAL_REPO_ID, `/aaa/local-${index}`, 'local')
    )
    const sshRow = resolvedWorktree(SSH_REPO_ID, '/zzz/ssh', 'ssh:box-1')
    vi.spyOn(runtime, 'listResolvedWorktreeSnapshot').mockResolvedValue({
      worktrees: [...localRows, sshRow] as never,
      platformByRepoId: new Map([
        [LOCAL_REPO_ID, 'linux'],
        [SSH_REPO_ID, 'linux']
      ])
    })
    runtime.setPtyController({
      spawn: vi.fn(async () => ({ id: 'never' })),
      write: () => true,
      kill: () => true,
      listProcesses: vi.fn(async () => []),
      listProcessesWithHostScope: vi.fn(async () => ({
        processes: [],
        hostIds: ['local', 'ssh:box-1']
      }))
    } as never)

    const result = await runtime.getWorktreePs(2)

    expect(result.worktrees.every((worktree) => worktree.hostId === 'local')).toBe(true)
    expect(result.truncated).toBe(true)
    expect(result.hostScope?.hostIds).toEqual(['local'])
    expect(result.hostScope?.omittedHostIds).toEqual(['ssh:box-1'])
  })
})
