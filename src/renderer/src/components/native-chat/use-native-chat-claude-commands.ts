import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../../store'
import type { AgentType } from '../../../../shared/agent-status-types'
import {
  toSlashCommandSuggestions,
  type ClaudeSlashCommandDiscoveryResult
} from '../../../../shared/claude-slash-command-discovery'
import type { SlashCommandSuggestion } from '../../../../shared/native-chat-slash-commands'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import {
  resolveNativeChatSkillDiscoveryContext,
  selectNativeChatSkillStateInputs
} from './native-chat-skill-discovery-context'

const DISCOVERY_TIMEOUT_MS = 10_000
const DISCOVERY_BACKSTOP_TIMEOUT_MS = 18_000

export type NativeChatClaudeCommandDiscovery = {
  status: 'idle' | 'loading' | 'ready' | 'error'
  commands: readonly SlashCommandSuggestion[]
  retry: () => void
}

type StoredState = {
  status: NativeChatClaudeCommandDiscovery['status']
  commands: readonly SlashCommandSuggestion[]
  contextKey: string | null
}

const IDLE_STATE: StoredState = { status: 'idle', commands: [], contextKey: null }
const inFlightDiscovery = new Map<string, Promise<ClaudeSlashCommandDiscoveryResult>>()

const CLAUDE_COMMAND_AGENTS = new Set<AgentType>(['claude', 'openclaude'])

export function useNativeChatClaudeCommands(
  agent: AgentType,
  terminalTabId: string,
  enabled = false
): NativeChatClaudeCommandDiscovery {
  const inputs = useAppStore(useShallow(selectNativeChatSkillStateInputs))
  const context = useMemo(
    () => resolveNativeChatSkillDiscoveryContext(inputs, terminalTabId),
    [inputs, terminalTabId]
  )
  const [state, setState] = useState<StoredState>(IDLE_STATE)
  const [retryGeneration, setRetryGeneration] = useState(0)
  const paneDiscoveryCache = useRef(new Map<string, ClaudeSlashCommandDiscoveryResult>())
  const forceNextDiscovery = useRef(false)
  const shouldDiscover = enabled && CLAUDE_COMMAND_AGENTS.has(agent)

  useEffect(() => {
    let cancelled = false
    if (!shouldDiscover || !context) {
      forceNextDiscovery.current = false
      setState(IDLE_STATE)
      return
    }
    if (context.executionHostKind === 'ssh') {
      setState({ status: 'error', commands: [], contextKey: context.key })
      return
    }

    const paneCacheKey = context.key
    const cached = paneDiscoveryCache.current.get(paneCacheKey)
    if (cached) {
      setState({
        status: 'ready',
        commands: toSlashCommandSuggestions(cached.commands),
        contextKey: context.key
      })
      return
    }
    setState({ status: 'loading', commands: [], contextKey: context.key })
    const forced = forceNextDiscovery.current
    forceNextDiscovery.current = false
    const request = getOrStartDiscovery(context, forced)
    void request.then(
      (result) => {
        paneDiscoveryCache.current.set(paneCacheKey, result)
        if (cancelled) {
          return
        }
        setState({
          status: 'ready',
          commands: toSlashCommandSuggestions(result.commands),
          contextKey: paneCacheKey
        })
      },
      () => {
        if (cancelled) {
          return
        }
        setState({ status: 'error', commands: [], contextKey: paneCacheKey })
      }
    )
    return () => {
      cancelled = true
    }
  }, [context, retryGeneration, shouldDiscover])

  const effectiveState = useMemo(
    () =>
      !shouldDiscover
        ? IDLE_STATE
        : !context
          ? { status: 'error' as const, commands: [], contextKey: null }
          : state.contextKey === context.key
            ? state
            : { status: 'loading' as const, commands: [], contextKey: context.key },
    [context, shouldDiscover, state]
  )

  const retry = useCallback(() => {
    forceNextDiscovery.current = true
    if (context) {
      paneDiscoveryCache.current.delete(context.key)
      setState({ status: 'loading', commands: [], contextKey: context.key })
    }
    setRetryGeneration((generation) => generation + 1)
  }, [context])

  return useMemo(
    () => ({
      status: effectiveState.status,
      commands: effectiveState.commands,
      retry
    }),
    [effectiveState, retry]
  )
}

function getOrStartDiscovery(
  context: NonNullable<ReturnType<typeof resolveNativeChatSkillDiscoveryContext>>,
  refresh = false
): Promise<ClaudeSlashCommandDiscoveryResult> {
  const existing = inFlightDiscovery.get(context.key)
  if (existing && !refresh) {
    return existing
  }
  const request = withDiscoveryTimeout(
    callRuntimeRpc<ClaudeSlashCommandDiscoveryResult>(
      context.runtimeTarget,
      'claudeCommands.discover',
      refresh ? { ...context.discoveryTarget, refresh: true } : context.discoveryTarget,
      { timeoutMs: DISCOVERY_TIMEOUT_MS }
    ),
    DISCOVERY_BACKSTOP_TIMEOUT_MS
  ).finally(() => {
    if (inFlightDiscovery.get(context.key) === request) {
      inFlightDiscovery.delete(context.key)
    }
  })
  inFlightDiscovery.set(context.key, request)
  return request
}

function withDiscoveryTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Claude command discovery timed out.')), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (reason) => {
        clearTimeout(timer)
        reject(reason)
      }
    )
  })
}

export function resetNativeChatClaudeCommandDiscoveryCacheForTests(): void {
  inFlightDiscovery.clear()
}
