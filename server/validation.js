/**
 * Zod schemas for REST and WebSocket message validation.
 *
 * Single source of truth for all message shapes entering the server.
 *
 * Architecture: docs/architecture.md#rest-task-crud
 */

import { z } from 'zod'

/** POST /api/tasks — Architecture: docs/architecture.md#rest-task-crud */
export const CreateTaskSchema = z.object({
  title: z.string().min(1),
  type: z.enum(['task', 'plan']).default('task'),
  cwd: z.string().min(1),
  dependsOn: z.string().optional(),
})

/** PATCH /api/tasks/:id — Architecture: docs/architecture.md#rest-task-crud */
export const UpdateTaskSchema = z.object({
  status: z.enum(['cancelled', 'pending']).optional(),
  feedback: z.string().optional(),
})

/** POST /api/tasks/:id/confirm — Architecture: docs/architecture.md#rest-task-crud */
export const ConfirmPlanSchema = z.object({
  title: z.string().min(1).optional(),
})

/** POST /api/tasks/:id/revise — Architecture: docs/architecture.md#rest-task-crud */
export const RevisePlanSchema = z.object({
  feedback: z.string().min(1),
})

/** Client → Server WS — Architecture: docs/architecture.md#websocket */
export const WsClientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('approve'),
    taskId: z.string(),
    eventId: z.number(),
    allow: z.boolean(),
  }),
])
