import { pathToFileURL } from "node:url";

import { createRepositoryComposition } from "../storage/composition";
import { productionReadiness } from "./readiness";
import { reconcileAutomationQueue } from "./reconcile";
import { PostgresAutomationJobRepository } from "./repository";
import { runAutomationWorker } from "./worker";
import { auditProductionResearch } from "./production-audit";

export async function main(args: string[]) {
  const command = args[0] ?? "drain";
  if (command === "drain") {
    console.log(JSON.stringify(await runAutomationWorker(), null, 2));
    return;
  }
  const composition = createRepositoryComposition(process.env);
  try {
    await composition.verify();
    if (!composition.sql) throw new Error("PostgreSQL storage is required");
    const jobs = new PostgresAutomationJobRepository(composition.sql);
    if (command === "reconcile")
      console.log(
        JSON.stringify(
          await reconcileAutomationQueue(composition.sql, jobs),
          null,
          2,
        ),
      );
    else if (command === "status")
      console.log(JSON.stringify(await jobs.list(undefined, 50), null, 2));
    else if (command === "retry")
      console.log(JSON.stringify(await jobs.retry(required(args[1])), null, 2));
    else if (command === "cancel")
      console.log(
        JSON.stringify(await jobs.cancel(required(args[1])), null, 2),
      );
    else if (command === "readiness")
      console.log(
        JSON.stringify(await productionReadiness(composition.sql), null, 2),
      );
    else if (command === "audit") {
      const eventIds = list(process.env.AUDIT_EVENT_IDS);
      const jobIds = list(process.env.AUDIT_JOB_IDS);
      if (!eventIds.length && !jobIds.length)
        throw new Error("AUDIT_EVENT_IDS or AUDIT_JOB_IDS is required");
      console.log(
        JSON.stringify(
          await auditProductionResearch(
            composition.sql,
            composition.artifacts,
            {
              eventIds,
              jobIds,
            },
          ),
          null,
          2,
        ),
      );
    } else throw new Error(`Unknown automation command: ${command}`);
  } finally {
    await composition.close();
  }
}

function required(value: string | undefined) {
  if (!value) throw new Error("A job ID is required");
  return value;
}

function list(value: string | undefined) {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href)
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
