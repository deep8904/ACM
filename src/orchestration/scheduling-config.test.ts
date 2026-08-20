import { readFile } from "node:fs/promises";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

import { evaluateAutomationHeartbeats } from "./readiness";
import { manualDiscoveryJob, scheduledDiscoveryJob } from "./reconcile";
import { currentDiscoverySlot, nextDiscoverySlot } from "./discovery-schedule";
import type { SystemHeartbeat } from "./models";

const root = process.cwd();

describe("free hosted scheduler configuration", () => {
  it("does not require a Vercel-native cron", async () => {
    const config = JSON.parse(
      await readFile(`${root}/vercel.json`, "utf8"),
    ) as { crons?: { schedule: string }[] };

    expect(config.crons ?? []).toEqual([]);
  });

  it("uses redundant offset wakeups and supports manual dispatch", async () => {
    const workflow = parse(
      await readFile(`${root}/.github/workflows/automation-worker.yml`, "utf8"),
    ) as Record<string, unknown>;
    const triggers = workflow.on as {
      schedule: { cron: string }[];
      workflow_dispatch: unknown;
    };
    const concurrency = workflow.concurrency as {
      group: string;
      "cancel-in-progress": boolean;
    };
    const jobs = workflow.jobs as {
      drain: { env: Record<string, string>; steps: { run?: string }[] };
    };

    expect(triggers.schedule).toEqual([
      { cron: "17 * * * *" },
      { cron: "47 * * * *" },
    ]);
    expect(triggers).toHaveProperty("workflow_dispatch");
    expect(triggers.workflow_dispatch).toMatchObject({
      inputs: {
        manual_discovery: { default: false, type: "boolean" },
        audit_only: { default: false, type: "boolean" },
        manual_test_id: { type: "string" },
        manual_window_start: { type: "string" },
        manual_window_end: { type: "string" },
        retry_job_ids: { type: "string" },
        process_job_ids: { type: "string" },
      },
    });
    expect(concurrency).toEqual({
      group: "ai-content-machine-production-worker",
      "cancel-in-progress": false,
    });
    expect(jobs.drain.steps).toContainEqual({
      run: "npm ci --include=dev",
    });
    expect(jobs.drain.steps).toContainEqual({
      name: "Enqueue isolated manual test discovery",
      if: "${{ github.event_name == 'workflow_dispatch' && inputs.migration_only != true && inputs.audit_only != true && inputs.manual_discovery == true }}",
      env: {
        MANUAL_DISCOVERY_TEST_ID: "${{ inputs.manual_test_id }}",
        MANUAL_DISCOVERY_WINDOW_START: "${{ inputs.manual_window_start }}",
        MANUAL_DISCOVERY_WINDOW_END: "${{ inputs.manual_window_end }}",
      },
      run: "npm run automation:manual-discovery",
    });
    expect(jobs.drain.steps).toContainEqual({
      name: "Retry explicitly selected existing jobs",
      if: "${{ github.event_name == 'workflow_dispatch' && inputs.migration_only != true && inputs.audit_only != true && inputs.retry_job_ids != '' }}",
      env: {
        RETRY_JOB_IDS: "${{ inputs.retry_job_ids }}",
      },
      run: "npm run automation:retry-selected",
    });
    expect(jobs.drain.steps).toContainEqual({
      name: "Drain only explicitly selected jobs",
      if: "${{ github.event_name == 'workflow_dispatch' && inputs.migration_only != true && inputs.audit_only != true && (inputs.retry_job_ids != '' || inputs.process_job_ids != '') }}",
      env: {
        SELECTED_JOB_IDS:
          "${{ inputs.retry_job_ids || inputs.process_job_ids }}",
      },
      run: "npm run automation:worker-selected",
    });
    expect(jobs.drain.steps).toContainEqual({
      name: "Reconcile and drain durable work",
      if: "${{ github.event_name != 'workflow_dispatch' || (inputs.migration_only != true && inputs.audit_only != true && inputs.retry_job_ids == '' && inputs.process_job_ids == '') }}",
      run: "npm run automation:worker",
    });
    expect(jobs.drain.steps).toContainEqual({
      name: "Audit requested research lineage",
      if: "${{ github.event_name == 'workflow_dispatch' && inputs.migration_only != true && (inputs.audit_event_ids != '' || inputs.audit_job_ids != '') }}",
      env: {
        AUDIT_EVENT_IDS: "${{ inputs.audit_event_ids }}",
        AUDIT_JOB_IDS: "${{ inputs.audit_job_ids }}",
      },
      run: "npm run automation:audit",
    });
    expect(jobs.drain.steps).toContainEqual({
      name: "Apply additive database migrations",
      if: "${{ github.event_name != 'workflow_dispatch' || inputs.audit_only != true }}",
      run: "npm run db:migrate",
    });
    expect(jobs.drain.env.SITE_ORIGIN).toBe("${{ vars.SITE_ORIGIN }}");
    expect(jobs.drain.env.GEMINI_API_KEY).toBe(
      "${{ secrets.GEMINI_API_KEY || secrets.GOOGLE_AI_API_KEY }}",
    );
    expect(jobs.drain.env.BYTEZ_API_KEY).toBe("${{ secrets.BYTEZ_API_KEY }}");
    expect(jobs.drain.env.GROQ_MODEL).toBe(
      "${{ vars.GROQ_MODEL || 'openai/gpt-oss-120b' }}",
    );
    expect(jobs.drain.env.OPENROUTER_MODEL).toBe(
      "${{ vars.OPENROUTER_MODEL || 'openai/gpt-oss-120b' }}",
    );
    expect(jobs.drain.env.GEMINI_MODEL).toBe(
      "${{ vars.GEMINI_MODEL || 'gemini-3.6-flash' }}",
    );
    expect(jobs.drain.env.BYTEZ_MODEL).toBe(
      "${{ vars.BYTEZ_MODEL || 'Qwen/Qwen3-4B' }}",
    );
  });

  it("creates exactly two deterministic discovery slots per UTC week", () => {
    const monday = new Date("2026-08-10T16:00:00.000Z");
    const thursday = new Date("2026-08-13T16:00:00.000Z");
    expect(currentDiscoverySlot(new Date("2026-08-10T16:01:00.000Z"))).toEqual(
      monday,
    );
    expect(currentDiscoverySlot(new Date("2026-08-12T23:59:00.000Z"))).toEqual(
      monday,
    );
    expect(currentDiscoverySlot(new Date("2026-08-13T16:01:00.000Z"))).toEqual(
      thursday,
    );
    expect(nextDiscoverySlot(new Date("2026-08-10T16:01:00.000Z"))).toEqual(
      thursday,
    );

    const job = scheduledDiscoveryJob(new Date("2026-08-13T16:01:00.000Z"), {
      currentWindowStart: "2026-08-10T16:03:00.000Z",
      currentWindowEnd: thursday.toISOString(),
    });
    expect(job).toMatchObject({
      type: "discovery",
      lineageKey: "discovery:2026-08-13T16:00:00.000Z",
      payload: {
        runId: "run_2026081316_scheduled",
        scheduled: true,
        windowStart: "2026-08-10T16:03:00.000Z",
        windowEnd: "2026-08-13T16:00:00.000Z",
      },
    });
  });

  it("self-heals a missed tick without duplicating the discovery slot", () => {
    const discovery = {
      currentWindowStart: "2026-08-10T16:00:00.000Z",
      currentWindowEnd: "2026-08-13T16:00:00.000Z",
    };
    const first = scheduledDiscoveryJob(
      new Date("2026-08-13T16:17:00.000Z"),
      discovery,
    );
    const delayed = scheduledDiscoveryJob(
      new Date("2026-08-13T18:47:00.000Z"),
      discovery,
    );

    expect(delayed.lineageKey).toBe(first.lineageKey);
    expect(delayed.idempotencyKey).toBe(first.idempotencyKey);
    expect(delayed.payload).toMatchObject({
      runId: "run_2026081316_scheduled",
    });
  });

  it("creates an isolated idempotent manual test window", () => {
    const job = manualDiscoveryJob({
      testId: "v1-e2e-20260813t1635z",
      windowStart: "2026-08-06T16:35:00.000Z",
      windowEnd: "2026-08-13T16:35:00.000Z",
    });

    expect(job).toMatchObject({
      type: "discovery",
      lineageKey: "manual-discovery:v1-e2e-20260813t1635z",
      payload: {
        runId: "run_v1-e2e-20260813t1635z_manual_test",
        scheduled: false,
        manual: true,
        test: true,
        testId: "v1-e2e-20260813t1635z",
        windowStart: "2026-08-06T16:35:00.000Z",
        windowEnd: "2026-08-13T16:35:00.000Z",
      },
    });
    expect(
      manualDiscoveryJob({
        testId: "v1-e2e-20260813t1635z",
        windowStart: "2026-08-06T16:35:00.000Z",
        windowEnd: "2026-08-13T16:35:00.000Z",
      }).idempotencyKey,
    ).toBe(job.idempotencyKey);
  });

  it("updates the scheduled cursor only for explicitly scheduled discovery", async () => {
    const source = await readFile(
      `${root}/src/orchestration/repository.ts`,
      "utf8",
    );
    expect(source).toContain("row.payload.scheduled === true");
  });

  it("uses a fresh GitHub Actions scheduler heartbeat for readiness", () => {
    const now = new Date("2026-08-09T12:20:00.000Z");
    const heartbeats: SystemHeartbeat[] = [
      heartbeat("scheduler", "github_actions", "2026-08-09T12:05:00.000Z"),
      heartbeat("worker", "github_actions", "2026-08-09T12:06:00.000Z"),
    ];

    expect(evaluateAutomationHeartbeats(heartbeats, now)).toMatchObject({
      scheduler: "healthy",
      schedulerSource: "github_actions",
      worker: "healthy",
    });
    expect(
      evaluateAutomationHeartbeats(
        [heartbeat("scheduler", "vercel_cron", now.toISOString())],
        now,
      ),
    ).toMatchObject({
      scheduler: "stale",
      schedulerSource: "vercel_cron",
    });
  });

  it("reports normal hosted jitter without failing readiness and detects an outage", () => {
    const now = new Date("2026-08-09T15:00:00.000Z");
    const delayed = [
      heartbeat("scheduler", "github_actions", "2026-08-09T13:00:00.000Z"),
      heartbeat("worker", "github_actions", "2026-08-09T13:01:00.000Z"),
    ];
    expect(evaluateAutomationHeartbeats(delayed, now)).toMatchObject({
      scheduler: "degraded",
      worker: "degraded",
    });

    const outage = [
      heartbeat("scheduler", "github_actions", "2026-08-09T11:59:59.000Z"),
      heartbeat("worker", "github_actions", "2026-08-09T11:59:59.000Z"),
    ];
    expect(evaluateAutomationHeartbeats(outage, now)).toMatchObject({
      scheduler: "stale",
      worker: "stale",
    });
  });
});

function heartbeat(
  component: SystemHeartbeat["component"],
  source: string,
  observedAt: string,
): SystemHeartbeat {
  return {
    component,
    instanceId: `${source}-test`,
    status: "healthy",
    details: { source },
    observedAt,
  };
}
