/** Pure model-seat helpers shared by the client directory and Grok chooser. */

export function sameModelRoute(left, right) {
  return left?.provider === right?.provider && left?.model === right?.model
}

/** Keep a just-selected model until the projection names the same provider/model. */
export function reconcileModelCurrent(pending, projected) {
  if (pending !== null && pending !== undefined && !sameModelRoute(pending, projected)) return pending
  return projected
}

export function requestErrorAlert(error) {
  return {
    title: error instanceof Error ? error.message : String(error),
    role: 'alert',
  }
}
