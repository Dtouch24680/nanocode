/**
 * Zod schemas for REST and WebSocket message validation.
 */

import { z } from 'zod'

/** POST /api/tasks */
export const CreateTaskSchema = z.object({
  title: z.string().min(1),
  type: z.enum(['task', 'plan']).default('task'),
  cwd: z.string().min(1).optional(),
  projectId: z.string().optional(),
  dependsOn: z.string().optional(),
})

/** PATCH /api/tasks/:id */
export const UpdateTaskSchema = z.object({
  status: z.enum(['cancelled', 'pending']).optional(),
  feedback: z.string().optional(),
})

/** POST /api/tasks/:id/confirm */
export const ConfirmPlanSchema = z.object({
  title: z.string().min(1).optional(),
})

/** POST /api/tasks/:id/revise */
export const RevisePlanSchema = z.object({
  feedback: z.string().min(1),
})

/** Client -> Server WS */
export const WsClientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('approve'),
    taskId: z.string(),
    eventId: z.number(),
    allow: z.boolean(),
  }),
])
