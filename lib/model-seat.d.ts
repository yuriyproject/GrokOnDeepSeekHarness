export interface ModelRoute {
  provider: string
  model: string
  reasoningEffort?: string
}
export function sameModelRoute(left: ModelRoute | null | undefined, right: ModelRoute | null | undefined): boolean
export function reconcileModelCurrent<T extends ModelRoute>(pending: T | null | undefined, projected: T): T
export function requestErrorAlert(error: unknown): { title: string; role: 'alert' }
