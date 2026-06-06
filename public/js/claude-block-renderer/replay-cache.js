export class ReplayCache {
  constructor() {
    this.resetAll()
  }

  resetAll() {
    this.transportKeys = new Set()
    this.seenSubagentUuids = new Set()
    this.resetHistoryWindow()
  }

  resetHistoryWindow() {
    this.historyEvents = []
    this.historyRenderedStart = 0
    this.historyLoadingSentinel = null
    this.historyObserver = null
    this.historyLoading = false
  }

  getEventReplayKey(event) {
    return event?.replay_id || event?.uuid || null
  }

  rememberFetchedEvents(events) {
    for (const event of events) {
      const replayKey = this.getEventReplayKey(event)
      if (replayKey) this.transportKeys.add(replayKey)
    }
    this.historyEvents = events
  }

  hasTransportReplay(event) {
    const replayKey = this.getEventReplayKey(event)
    return !!replayKey && this.transportKeys.has(replayKey)
  }

  markSubagentSeen(uuid) {
    if (!uuid) return false
    if (this.seenSubagentUuids.has(uuid)) return true
    this.seenSubagentUuids.add(uuid)
    return false
  }
}
