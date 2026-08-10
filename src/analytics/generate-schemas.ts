import { mkdir, writeFile } from "node:fs/promises";
import { z } from "zod";
import {
  analyticsImportSchema,
  analyticsSourceSchema,
  analyticsSyncJobSchema,
  articleMetricsSchema,
  assistedAnalysisSchema,
  editorialInsightSchema,
  editorialReportSchema,
  insightActionSchema,
  performanceSnapshotSchema,
  socialMetricsSchema,
} from "./models";
const schemas = {
  "analytics-source": analyticsSourceSchema,
  "analytics-sync-job": analyticsSyncJobSchema,
  "article-metrics": articleMetricsSchema,
  "social-metrics": socialMetricsSchema,
  "performance-snapshot": performanceSnapshotSchema,
  "editorial-insight": editorialInsightSchema,
  "editorial-report": editorialReportSchema,
  "analytics-import": analyticsImportSchema,
  "analytics-assisted-analysis": assistedAnalysisSchema,
  "analytics-insight-action": insightActionSchema,
};
await mkdir("automation/schemas", { recursive: true });
for (const [name, schema] of Object.entries(schemas))
  await writeFile(
    `automation/schemas/${name}.schema.json`,
    `${JSON.stringify(z.toJSONSchema(schema), null, 2)}\n`,
  );
