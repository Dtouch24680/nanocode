# Task Lifecycle

How a task moves through the system from creation to completion.

## State Machine

```mermaid
stateDiagram-v2
    [*] --> pending: POST /api/tasks
    pending --> running: scheduler.tick()
    running --> done: worker completes (type=task)
    running --> review: worker completes (type=plan)
    running --> failed: worker error
    running --> cancelled: PATCH {status: cancelled}
    review --> done: POST /confirm
    review --> pending: POST /revise
    failed --> pending: PATCH {status: pending}
    done --> [*]
    cancelled --> [*]
```

## Scheduling

```mermaid
sequenceDiagram
    participant Client
    participant REST as REST API
    participant Store as SQLite
    participant Sched as Scheduler
    participant Worker

    Client->>REST: POST /api/tasks
    REST->>Store: createTask()
    REST->>Sched: tick()
    Sched->>Store: listTasks() (pending)
    Sched->>Sched: check depends_on
    Sched->>Sched: check MAX_CONCURRENCY
    Sched->>Worker: new Worker(task).run()
    Worker->>Store: updateTask(running)
    Worker->>Client: WS task:updated
```

## Storage

Two SQLite tables:

- **tasks** — current state of each task (status, cost, turns, timestamps)
- **task_events** — append-only log of everything a worker produces

Events are the source of truth for what happened during a run.
Tasks are the source of truth for the current state.

## Completion

When a worker finishes:

1. If `type=plan`: status → `review`, text chunks joined into `plan_result`
2. If `type=task`: status → `done`
3. `turns` and `cost_usd` are updated
4. `ended_at` is set

## Failure

On any unhandled error:

1. Error event appended to task_events
2. Status → `failed`
3. User can retry (PATCH to `pending`)

## Cancellation

User sends PATCH `{status: "cancelled"}` → worker.abort() → SDK `.interrupt()` → status → `cancelled`.
