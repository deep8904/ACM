import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  articleDraftSchema,
  articleWritingResultSchema,
  draftQualityReportSchema,
  writingJobSchema,
} from "./models";

const schemas = {
  "article-writing-result.schema.json": articleWritingResultSchema,
  "article-draft.schema.json": articleDraftSchema,
  "draft-quality-report.schema.json": draftQualityReportSchema,
  "writing-job.schema.json": writingJobSchema,
};
for (const [name, schema] of Object.entries(schemas))
  await writeFile(
    join("automation", "schemas", name),
    `${JSON.stringify({ $schema: "https://json-schema.org/draft/2020-12/schema", title: name.replace(".schema.json", ""), ...z.toJSONSchema(schema, { target: "draft-2020-12" }) }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
