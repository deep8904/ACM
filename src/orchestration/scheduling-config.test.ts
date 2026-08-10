import { readFile } from "node:fs/promises";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

import { evaluateAutomationHeartbeats } from "./readiness";
import { scheduledDiscoveryJob } from "./reconcile";
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
      run: "npm run automation:worker",
    });
    expect(jobs.drain.env.SITE_ORIGIN).toBe("${{ vars.SITE_ORIGIN }}");
  });

  it("creates one deterministic discovery identity per UTC day", () => {
    const morning = scheduledDiscoveryJob(new Date("2026-08-09T00:01:00.000Z"));
    const evening = scheduledDiscoveryJob(new Date("2026-08-09T23:59:00.000Z"));
    const nextDay = scheduledDiscoveryJob(new Date("2026-08-10T00:00:00.000Z"));

    expect(morning).toEqual(evening);
    expect(morning.idempotencyKey).not.toBe(nextDay.idempotencyKey);
    expect(morning).toMatchObject({
      type: "discovery",
      lineageKey: "discovery:2026-08-09",
      payload: {
        runId: "run_20260809_scheduled",
        scheduled: true,
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
