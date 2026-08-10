import { createRepositoryComposition } from "../../../storage/composition";
import {
  diagnoseHealthFailure,
  type HealthFailurePhase,
} from "../../../orchestration/health-diagnostics";
import { productionReadiness } from "../../../orchestration/readiness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  let composition: ReturnType<typeof createRepositoryComposition> | undefined;
  let phase: HealthFailurePhase = "configuration";
  try {
    composition = createRepositoryComposition(process.env);
    if (!composition.sql) throw new Error("Durable storage is not selected");
    phase = "database_readiness";
    const readiness = await productionReadiness(composition.sql, process.env);
    return Response.json(readiness, {
      status: readiness.ready ? 200 : 503,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    const failure = diagnoseHealthFailure(error, phase, process.env);
    console.error(
      JSON.stringify({
        level: "error",
        message: "health_check_failed",
        category: failure.category,
        error: failure.error,
        missing: failure.missing,
        invalid: failure.invalid,
      }),
    );
    return Response.json(failure, {
      status: 503,
      headers: { "cache-control": "no-store" },
    });
  } finally {
    try {
      await composition?.close();
    } catch {
      console.error(
        JSON.stringify({
          level: "error",
          message: "health_check_database_close_failed",
        }),
      );
    }
  }
}
