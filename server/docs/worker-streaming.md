# Worker Streaming

How the Worker class bridges the Claude SDK async generator to
WebSocket clients and the SQLite event log.

## Run Loop

```mermaid
sequenceDiagram
    participant SDK as Claude SDK
    participant Worker
    participant Store as SQLite
    participant WS as WebSocket Clients

    Worker->>SDK: query({ prompt, options })
    loop for await (message of queryInstance)
        SDK->>Worker: message
        alt type = system
            Worker->>Worker: capture session_id
        else type = assistant (text block)
            Worker->>Store: appendEvent('text', {text})
            Worker->>WS: task:event
        else type = assistant (tool_use block)
            Worker->>Store: appendEvent('tool_use', {name, input})
            Worker->>WS: task:event
        else type = result
            Worker->>Worker: extract cost from modelUsage
        end
    end
    Worker->>Store: updateTask(done/review)
    Worker->>WS: task:updated
```

## Message Types

The SDK yields three message types:

| Type | Contains | Action |
|------|----------|--------|
| `system` | `session_id` | Capture for resume capability |
| `assistant` | `message.content[]` blocks | Map to events (text, tool_use, tool_result) |
| `result` | `modelUsage` | Extract cumulative token counts for cost |

## Event Append

Every piece of SDK output is persisted as a `task_events` row before
being broadcast. This guarantees no data loss if a client disconnects
mid-stream.

## Approval Flow

```mermaid
sequenceDiagram
    participant SDK
    participant Worker
    participant Store
    participant WS as WebSocket
    participant User

    SDK->>Worker: canUseTool(name, input)
    alt read-only tool
        Worker->>SDK: allow
    else write tool
        Worker->>Store: appendEvent('approval_req')
        Worker->>WS: task:approval
        WS->>User: show Allow/Deny
        User->>WS: {type: approve, allow: true/false}
        WS->>Worker: handleApproval(eventId, allow)
        Worker->>SDK: allow/deny
    end
```

## Broadcast

`broadcast(msg)` iterates all connected WebSocket clients and sends
JSON. Clients filter by `taskId` — only the task detail view for the
matching task processes the event.

## Incremental Fetch

`GET /api/tasks/:id/events?after=eventId` returns only events with
`id > afterId`. This enables clients that reconnect to catch up
without re-fetching the full history.
