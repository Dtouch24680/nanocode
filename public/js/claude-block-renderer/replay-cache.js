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
    // Server-side pagination state (for fetching events older than the tail window)
    this.historyHasServerMore = false   // server indicated there's history before the 4MB tail
    this.historyFirstUuid = null        // uuid of oldest event in current historyEvents
    this.historyServerLoading = false   // in-flight server fetch for older page
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
