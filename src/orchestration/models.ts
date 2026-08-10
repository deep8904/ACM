import { z } from "zod";

const iso = z.string().datetime({ offset: true });
const hash = z.string().regex(/^[a-f0-9]{64}$/);

export const automationJobTypeSchema = z.enum([
  "discovery",
  "research",
  "writing",
  "editorial_review",
  "revision",
  "publication",
  "production_verification",
  "notification",
  "reconciliation",
]);
export type AutomationJobType = z.infer<typeof automationJobTypeSchema>;

export const automationJobStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "retryable",
  "blocked",
  "cancelled",
]);
export type AutomationJobStatus = z.infer<typeof automationJobStatusSchema>;

export const automationJobSchema = z
  .object({
    id: z.string().regex(/^automationjob_[a-f0-9]{24}$/),
    idempotencyKey: hash,
    type: automationJobTypeSchema,
    status: automationJobStatusSchema,
    topicId: z.string().optional(),
    parentJobId: z
      .string()
      .regex(/^automationjob_[a-f0-9]{24}$/)
      .optional(),
    lineageKey: z.string().min(1).max(500),
    payload: z.record(z.string(), z.unknown()),
    result: z.record(z.string(), z.unknown()).optional(),
    attempt: z.number().int().nonnegative(),
    maximumAttempts: z.number().int().min(1).max(10),
    availableAt: iso,
    leaseOwner: z.string().max(200).optional(),
    leaseExpiresAt: iso.optional(),
    heartbeatAt: iso.optional(),
    failureCode: z.string().max(100).optional(),
    failureSummary: z.string().max(1000).optional(),
    diagnosticId: z.string().max(100).optional(),
    createdAt: iso,
    updatedAt: iso,
    startedAt: iso.optional(),
    completedAt: iso.optional(),
    version: z.number().int().positive(),
  })
  .strict();
export type AutomationJob = z.infer<typeof automationJobSchema>;

export interface EnqueueAutomationJob {
  type: AutomationJobType;
  idempotencyKey: string;
  lineageKey: string;
  payload?: Record<string, unknown>;
  topicId?: string;
  parentJobId?: string;
  maximumAttempts?: number;
  availableAt?: string;
}

export const systemHeartbeatSchema = z
  .object({
    component: z.enum(["scheduler", "worker", "webhook"]),
    instanceId: z.string().min(1).max(200),
    status: z.enum(["healthy", "degraded", "failed"]),
    details: z.record(z.string(), z.unknown()),
    observedAt: iso,
  })
  .strict();
export type SystemHeartbeat = z.infer<typeof systemHeartbeatSchema>;
