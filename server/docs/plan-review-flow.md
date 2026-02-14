# Plan Review Flow

How plan tasks produce a markdown plan, present it for review,
and transition to execution.

## Flow

```mermaid
sequenceDiagram
    participant User
    participant REST as REST API
    participant Store as SQLite
    participant Sched as Scheduler
    participant Worker
    participant SDK as Claude SDK

    User->>REST: POST /api/tasks {type: plan, title}
    REST->>Store: createTask()
    REST->>Sched: tick()

    Sched->>Worker: new Worker(task).run()
    Worker->>SDK: query({prompt: "Plan: ..."})
    Note over SDK: Only read-only tools allowed
    SDK->>Worker: text blocks (plan markdown)
    Worker->>Store: appendEvent('text', ...)
    Worker->>Store: updateTask(review, plan_result)
    Worker->>User: WS task:updated (status=review)

    Note over User: Reads plan in plan-review panel

    alt Confirm
        User->>REST: POST /tasks/:id/confirm {title?}
        REST->>Store: updateTask(done)
        REST->>Store: createTask(type=task, feedback=plan_result)
        REST->>Sched: tick()
        Sched->>Worker: new Worker(execTask).run()
        Note over Worker: Prompt includes plan as context
    else Revise
        User->>REST: POST /tasks/:id/revise {feedback}
        REST->>Store: updateTask(pending, feedback)
        REST->>Sched: tick()
        Sched->>Worker: new Worker(task).run()
        Note over Worker: Prompt includes revision feedback
    end
```

## Plan Task Restrictions

Plan tasks use `permissionMode: 'plan'` and only allow read-only tools:
Read, Glob, Grep, Task, WebSearch, WebFetch, TodoRead, TodoWrite.

Write tools (Write, Edit, Bash, NotebookEdit) are explicitly denied
by the `canUseTool` callback.

## Plan → Execution

When a plan is confirmed:

1. Plan task → status `done`
2. New task created with `type: task`
3. Plan's `plan_result` is stored as the execution task's `feedback`
4. Worker builds a prompt that includes the plan as context
