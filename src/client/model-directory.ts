/** Per-session DSH model directory used by the Harness-aware model surfaces (DSH 0.2.x Remote API). */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { SessionIdOf } from '@deepseek-ai/dsh-client-ui-slots'
import { reconcileModelCurrent, sameModelRoute } from '../../lib/model-seat.js'
import type { DshModelCommandState } from './model-command.js'

interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

interface ModelDirectoryState extends DshModelCommandState {
  routable: boolean | null
  status: 'idle' | 'loading' | 'ready' | 'selecting' | 'error'
  error: string | null
}

type RemoteResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string } }

interface ModelCatalog {
  default: ModelSelection
  groups: DshModelCommandState['groups']
  failures?: DshModelCommandState['failures']
}

/** `ctx.remote.session` as far as this plugin uses it. */
interface RemoteSessionApi {
  modelCatalog: () => Promise<RemoteResult<ModelCatalog>>
  selectModel: (request: ModelSelection & { sessionId: SessionIdOf }) => Promise<RemoteResult<{ selected: ModelSelection }>>
}

interface Observable<T> {
  getSnapshot: () => T
  subscribe: (listener: () => void) => () => void
}

/** Wire view of the `modelSelection` session projection. */
interface ModelSelectionView {
  lastUsed: ModelSelection | null
  next: ModelSelection | null
}

interface SnapshotStore<T> extends Observable<T> {
  update: (mutate: (draft: T) => void) => void
}

function createSnapshotStore<T extends object>(initial: T): SnapshotStore<T> {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    update: (mutate) => {
      const next = { ...snapshot }
      mutate(next)
      snapshot = next
      for (const listener of listeners) listener()
    },
  }
}

/** One Host-generation model catalog shared by every session selector. */
class ModelCatalog_ {
  readonly store = createSnapshotStore<{ value: ModelCatalog | null; status: 'idle' | 'loading' | 'ready' | 'error'; error: string | null }>({
    value: null,
    status: 'idle',
    error: null,
  })

  private generation = 0
  private inflight: Promise<ModelCatalog> | undefined

  constructor(private readonly remote: RemoteSessionApi) {}

  load(): Promise<ModelCatalog> {
    const state = this.store.getSnapshot()
    if (state.status === 'ready' && state.value !== null) return Promise.resolve(state.value)
    if (this.inflight !== undefined) return this.inflight
    const generation = this.generation
    this.store.update((draft) => { draft.status = 'loading'; draft.error = null })
    const operation = this.remote.modelCatalog().then((response) => {
      if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`)
      if (generation === this.generation) {
        this.store.update((draft) => { draft.value = response.value; draft.status = 'ready'; draft.error = null })
      }
      return response.value
    }).catch((error: unknown) => {
      if (generation === this.generation) {
        this.store.update((draft) => {
          draft.status = 'error'
          draft.error = error instanceof Error ? error.message : String(error)
        })
      }
      throw error
    }).finally(() => {
      if (generation === this.generation && this.inflight === operation) this.inflight = undefined
    })
    this.inflight = operation
    return operation
  }

  refresh(clear = false): void {
    this.generation += 1
    this.inflight = undefined
    this.store.update((draft) => {
      if (clear) draft.value = null
      draft.status = 'idle'
      draft.error = null
    })
    this.load().catch(() => undefined)
  }
}

/** One session's DSH model snapshot and selection controller. */
export class ModelDirectory {
  readonly store = createSnapshotStore<ModelDirectoryState>({
    current: null,
    routable: null,
    groups: [],
    failures: [],
    status: 'idle',
    error: null,
  })

  private generation = 0
  private disposed = false
  private pending: ModelSelection | null = null
  private readonly unsubscribe: Array<() => void> = []

  constructor(
    private readonly remote: RemoteSessionApi,
    private readonly catalog: ModelCatalog_,
    private readonly sessionId: SessionIdOf,
    private readonly available: () => boolean,
    private readonly projected: Observable<unknown> | undefined,
  ) {
    this.unsubscribe.push(catalog.store.subscribe(() => { this.sync() }))
    if (projected !== undefined) this.unsubscribe.push(projected.subscribe(() => { this.sync() }))
    this.sync()
  }

  async load(): Promise<ModelDirectoryState> {
    this.assertAvailable()
    await this.catalog.load()
    this.sync()
    return this.store.getSnapshot()
  }

  async select(selection: ModelSelection): Promise<void> {
    this.assertAvailable()
    const generation = ++this.generation
    this.store.update((state) => { state.status = 'selecting'; state.error = null })
    const result = await this.remote.selectModel({ sessionId: this.sessionId, ...selection })
    if (this.disposed || generation !== this.generation) {
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      return
    }
    if (!result.ok) {
      this.store.update((state) => {
        state.status = 'error'
        state.error = `${result.error.code}: ${result.error.message}`
      })
      throw new Error(`session.selectModel failed: ${result.error.code}: ${result.error.message}`)
    }
    this.pending = result.value.selected
    this.store.update((state) => {
      state.current = result.value.selected
      state.routable = true
      state.status = 'ready'
      state.error = null
    })
    this.sync()
  }

  resetConnected(): void {
    if (this.disposed) return
    ++this.generation
    this.pending = null
    this.store.update((state) => {
      if (state.status === 'selecting') state.status = 'idle'
      state.error = null
    })
    this.sync()
  }

  dispose(): void {
    this.disposed = true
    for (const stop of this.unsubscribe) stop()
  }

  private sync(): void {
    if (this.disposed) return
    const catalog = this.catalog.store.getSnapshot()
    const view = this.projected?.getSnapshot() as ModelSelectionView | undefined
    if (catalog.status !== 'ready' || catalog.value === null) {
      this.store.update((state) => {
        state.groups = catalog.value?.groups ?? []
        state.failures = catalog.value?.failures ?? []
        state.routable = null
        if (state.status !== 'selecting') state.status = catalog.status === 'error' ? 'error' : 'loading'
        state.error = catalog.error
      })
      return
    }
    const projected = view?.next ?? catalog.value.default
    const selection = reconcileModelCurrent(this.pending, projected)
    if (this.pending !== null && sameModelRoute(this.pending, projected)) this.pending = null
    const routable = catalog.value.groups.some(group => group.id === selection.provider
      && group.models.some(model => model.id === selection.model))
    this.store.update((state) => {
      state.current = selection
      state.routable = routable
      state.groups = catalog.value?.groups ?? []
      state.failures = catalog.value?.failures ?? []
      if (state.status !== 'selecting') state.status = 'ready'
      state.error = null
    })
  }

  private assertAvailable(): void {
    if (!this.available()) throw new Error('model selection is unavailable for addressed subagent sessions')
  }
}

interface SessionBinding {
  session: { projections: { faceOf: (key: string) => Observable<unknown> } }
}

interface SessionRuntimeFace {
  scope: (sessionId: SessionIdOf) => Context | undefined
  binding: (sessionId: SessionIdOf) => SessionBinding | undefined
  subagentAddress: (sessionId: SessionIdOf) => unknown
}

interface ConversationFace {
  blocks: { set: (sessionId: SessionIdOf, block: { reason: string } | undefined) => void }
}

interface RemoteFace {
  session: RemoteSessionApi
  $on: (event: string, listener: () => void) => unknown
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    modelDirectories: ModelDirectoryResolver
  }
}

/** Owns one DSH model directory for each live client session. */
export class ModelDirectoryResolver extends Service {
  static inject = ['sessions', 'remote', 'remote.session']

  private readonly directories = new Map<SessionIdOf, ModelDirectory>()
  private readonly catalog: ModelCatalog_

  constructor(ctx: Context, private readonly config: { blockReason: () => string }) {
    super(ctx, 'modelDirectories')
    const remote = ctx.get('remote') as unknown as RemoteFace
    this.catalog = new ModelCatalog_(remote.session)
    this.catalog.load().catch(() => undefined)
    ;(ctx as unknown as { on: (event: string, listener: () => void) => unknown }).on('connection/reset', () => {
      this.catalog.refresh(true)
      for (const directory of this.directories.values()) directory.resetConnected()
    })
    const refresh = (): void => { this.catalog.refresh() }
    for (const event of [
      'llm/adapters-updated', 'llm/models-updated', 'settings/document-updated',
      'credentials/record-updated', 'credentials/reference-updated',
    ]) remote.$on(event, refresh)
  }

  directoryFor(sessionId: SessionIdOf): ModelDirectory {
    const existing = this.directories.get(sessionId)
    if (existing !== undefined) return existing
    const sessions = this.ctx.get('sessions') as unknown as SessionRuntimeFace
    const sessionScope = sessions.scope(sessionId)
    if (sessionScope === undefined) {
      throw new Error(`dsh-grok-acp: session "${String(sessionId)}" resolved no client scope`)
    }
    const remote = this.ctx.get('remote') as unknown as RemoteFace
    const binding = sessions.binding(sessionId)
    const directory = new ModelDirectory(
      remote.session,
      this.catalog,
      sessionId,
      () => sessions.subagentAddress(sessionId) === undefined,
      binding?.session.projections.faceOf('modelSelection'),
    )
    this.directories.set(sessionId, directory)
    const conversation = this.ctx.get('conversation') as unknown as ConversationFace | undefined
    if (conversation !== undefined) {
      // A Grok Build session does not use the DSH model route, so an unroutable
      // DSH default must never block its composer.
      const presetFace = binding?.session.projections.faceOf('agentPreset')
      const publish = (): void => {
        const grok = presetFace?.getSnapshot() === 'grok-build'
        conversation.blocks.set(
          sessionId,
          directory.store.getSnapshot().routable === false && !grok ? { reason: this.config.blockReason() } : undefined,
        )
      }
      publish()
      sessionScope.effect(() => {
        const stops = [directory.store.subscribe(publish)]
        if (presetFace !== undefined) stops.push(presetFace.subscribe(publish))
        return () => {
          for (const stop of stops) stop()
          conversation.blocks.set(sessionId, undefined)
        }
      }, 'dsh-grok-acp model composer block')
    }
    sessionScope.effect(() => () => {
      directory.dispose()
      this.directories.delete(sessionId)
    }, 'dsh-grok-acp model directory')
    return directory
  }
}
