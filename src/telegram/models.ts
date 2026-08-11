import { z } from "zod";

import { storyClusterSchema, topicCandidateSchema } from "../ranking/models";

const telegramIdSchema = z.number().int().safe();

export const telegramUserSchema = z.object({
  id: telegramIdSchema,
  is_bot: z.boolean().default(false),
  username: z.string().optional(),
});

export const telegramChatSchema = z.object({
  id: telegramIdSchema,
  type: z.enum(["private", "group", "supergroup", "channel"]),
});

export const telegramMessageSchema = z.object({
  message_id: z.number().int().nonnegative(),
  date: z.number().int().nonnegative(),
  chat: telegramChatSchema,
  from: telegramUserSchema.optional(),
  text: z.string().max(4096).optional(),
});

export const telegramCallbackQuerySchema = z.object({
  id: z.string().min(1).max(256),
  from: telegramUserSchema,
  message: telegramMessageSchema.optional(),
  data: z.string().min(1).max(64).optional(),
});

export const telegramUpdateSchema = z
  .object({
    update_id: z.number().int().nonnegative(),
    message: telegramMessageSchema.optional(),
    callback_query: telegramCallbackQuerySchema.optional(),
  })
  .superRefine((update, context) => {
    if (
      Number(Boolean(update.message)) +
        Number(Boolean(update.callback_query)) !==
      1
    ) {
      context.addIssue({
        code: "custom",
        message: "Exactly one supported Telegram update payload is required",
      });
    }
  });

export type TelegramUpdate = z.infer<typeof telegramUpdateSchema>;

export const topicApprovalActionSchema = z.enum([
  "approve",
  "reject",
  "replace",
  "add_topic",
  "add_url",
  "change_angle",
  "add_note",
  "cancel",
]);

export const topicApprovalStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "cancelled",
  "superseded",
]);

export const topicApprovalSchema = z.object({
  id: z.string().regex(/^approval_[a-f0-9]{24}$/),
  topicId: z.string().min(1),
  candidateId: z.string().min(1),
  runId: z.string().min(1),
  chatId: z.string().regex(/^-?\d+$/),
  userId: z.string().regex(/^\d+$/),
  action: topicApprovalActionSchema,
  status: topicApprovalStatusSchema,
  editorialNotes: z.array(z.string().min(1).max(2000)),
  requestedAngle: z.string().max(2000).default(""),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  telegramUpdateId: z.number().int().nonnegative(),
  telegramMessageId: z.number().int().nonnegative().optional(),
  callbackQueryId: z.string().min(1).optional(),
  version: z.number().int().positive(),
});

export type TopicApproval = z.infer<typeof topicApprovalSchema>;

export const manualTopicCandidateSchema = z.object({
  id: z.string().regex(/^topic_manual_[a-f0-9]{24}$/),
  candidateId: z.string().regex(/^manual_[a-f0-9]{24}$/),
  runId: z.string().regex(/^manual_[A-Za-z0-9_-]+$/),
  title: z.string().min(3).max(500),
  submittedUrl: z.string().url().optional(),
  summary: z.string().max(1000).default(""),
  recommendedAngle: z.string().max(2000).default(""),
  score: z.null(),
  selectionReasons: z.tuple([z.literal("manually submitted")]),
  evidenceStrength: z.literal("unresearched"),
  sourceItemIds: z.array(z.string()).max(0),
  primarySourceItemIds: z.array(z.string()).max(0),
  submittedAt: z.string().datetime({ offset: true }),
  submittedByUserId: z.string().regex(/^\d+$/),
  submittedInChatId: z.string().regex(/^-?\d+$/),
});

export const rankedTopicSnapshotSchema = z.object({
  kind: z.literal("ranked"),
  candidate: topicCandidateSchema,
  cluster: storyClusterSchema,
});

export const manualTopicSnapshotSchema = z.object({
  kind: z.enum(["manual_topic", "manual_url"]),
  candidate: manualTopicCandidateSchema,
});

export const topicCandidateSnapshotSchema = z.union([
  rankedTopicSnapshotSchema,
  manualTopicSnapshotSchema,
]);

export const topicQueueItemSchema = z.object({
  id: z.string().regex(/^queue_[a-f0-9]{24}$/),
  shortId: z.string().regex(/^[a-f0-9]{12}$/),
  topicId: z.string().min(1),
  candidateId: z.string().min(1),
  runId: z.string().min(1),
  candidateSnapshot: topicCandidateSnapshotSchema,
  approvalStatus: topicApprovalStatusSchema,
  researchReadiness: z.enum([
    "blocked_pending_approval",
    "ready_for_research",
    "awaiting_source",
    "rejected",
    "cancelled",
  ]),
  editorialNotes: z.array(z.string().min(1).max(2000)),
  requestedAngle: z.string().max(2000),
  origin: z.enum(["ranked", "manual_topic", "manual_url"]),
  triggerState: z.enum([
    "not_triggered",
    "topic_approved_event_created",
    "cancelled",
  ]),
  displayedAt: z.string().datetime({ offset: true }).optional(),
  expiresAt: z.string().datetime({ offset: true }).optional(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  version: z.number().int().positive(),
});

export type TopicQueueItem = z.infer<typeof topicQueueItemSchema>;
export type TopicCandidateSnapshot = z.infer<
  typeof topicCandidateSnapshotSchema
>;

export const conversationStateSchema = z.object({
  id: z.string().regex(/^conversation_[a-f0-9]{24}$/),
  chatId: z.string().regex(/^-?\d+$/),
  userId: z.string().regex(/^\d+$/),
  state: z.enum([
    "awaiting_custom_topic",
    "awaiting_url",
    "awaiting_angle",
    "awaiting_note",
    "awaiting_rejection_reason",
  ]),
  topicId: z.string().optional(),
  createdAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  version: z.number().int().positive(),
});

export type ConversationState = z.infer<typeof conversationStateSchema>;

export const messageIndexSchema = z.object({
  shortId: z.string().regex(/^[a-f0-9]{12}$/),
  topicId: z.string(),
  chatId: z.string().regex(/^-?\d+$/),
  telegramMessageId: z.number().int().nonnegative(),
  version: z.number().int().positive(),
  updatedAt: z.string().datetime({ offset: true }),
});

export type MessageIndex = z.infer<typeof messageIndexSchema>;

export const processedUpdateSchema = z.object({
  updateId: z.number().int().nonnegative(),
  callbackQueryId: z.string().optional(),
  status: z.enum(["processing", "completed"]),
  processedAt: z.string().datetime({ offset: true }),
  commandType: z.string().max(64),
});

export type ProcessedUpdate = z.infer<typeof processedUpdateSchema>;

export const topicApprovedEventSchema = z.object({
  id: z.string().regex(/^event_[a-f0-9]{24}$/),
  topicId: z.string(),
  candidateId: z.string(),
  runId: z.string(),
  approvedAt: z.string().datetime({ offset: true }),
  approvedBy: z.object({
    telegramUserId: z.string().regex(/^\d+$/),
    telegramChatId: z.string().regex(/^-?\d+$/),
  }),
  approvedAngle: z.string(),
  editorialNotes: z.array(z.string()),
  sourceItemIds: z.array(z.string()),
  origin: z.enum(["ranked", "manual_topic", "manual_url"]),
  status: z.enum(["ready", "cancelled"]).default("ready"),
  consumed: z.literal(false),
  version: z.number().int().positive(),
});

export type TopicApprovedEvent = z.infer<typeof topicApprovedEventSchema>;
