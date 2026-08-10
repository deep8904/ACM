import { createRepositoryComposition } from "../../../storage/composition";
import { productionReadiness } from "../../../orchestration/readiness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  let composition: ReturnType<typeof createRepositoryComposition> | undefined;
  try {
    composition = createRepositoryComposition(process.env);
    if (!composition.sql) throw new Error("Durable storage is not selected");
    const readiness = await productionReadiness(composition.sql, process.env);
    return Response.json(readiness, {
      status: readiness.ready ? 200 : 503,
      headers: { "cache-control": "no-store" },
    });
  } catch {
    return Response.json(
      {
        ready: false,
        error: "control_plane_unavailable",
        checkedAt: new Date().toISOString(),
      },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  } finally {
    await composition?.close();
  }
}
