/** Keep events ordered without retaining an unbounded backlog during outages. */
export function createHeartbeatQueue(maxPending = 100) {
  const pending: {
    task: () => Promise<void>
    resolve: () => void
    reject: (error: unknown) => void
  }[] = []
  let running = false

  async function drain() {
    if (running) return
    running = true
    try {
      while (pending.length > 0) {
        const next = pending.shift()!
        try {
          await next.task()
          next.resolve()
        } catch (error) {
          next.reject(error)
        }
      }
    } finally {
      running = false
    }
  }

  return (task: () => Promise<void>) =>
    new Promise<void>((resolve, reject) => {
      // Prefer recent activity when the server cannot keep up. Settle the
      // discarded caller as well so browser event handlers do not hang.
      if (pending.length >= maxPending) pending.shift()!.resolve()
      pending.push({ task, resolve, reject })
      void drain()
    })
}
