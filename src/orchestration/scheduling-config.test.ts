import { readFile } from "node:fs/promises";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

import { evaluateAutomationHeartbeats } from "./readiness";
import { scheduledDiscoveryJob } from "./reconcile";
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

  it("runs the durable worker every 15 minutes and supports manual dispatch", async () => {
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

    expect(triggers.schedule).toEqual([{ cron: "*/15 * * * *" }]);
    expect(triggers).toHaveProperty("workflow_dispatch");
    expect(concurrency).toEqual({
      group: "ai-content-machine-production-worker",
      "cancel-in-progress": false,
    });
    expect(jobs.drain.steps).toContainEqual({
      run: "npm ci --include=dev",
    });
    expect(jobs.drain.steps).toContainEqual({
      name: "Reconcile and drain durable work",
      if: "${{ github.event_name != 'workflow_dispatch' || inputs.migration_only != true }}",
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
    expect(jobs.drain.env.SITE_ORIGIN).toBe("${{ vars.SITE_ORIGIN }}");
    expect(jobs.drain.env.GOOGLE_AI_MODEL).toBe(
      "${{ vars.GOOGLE_AI_MODEL || 'gemini-3.6-flash' }}",
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
