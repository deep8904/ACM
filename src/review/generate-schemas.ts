import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { editorialReviewImportSchema, revisionResultSchema } from "./models";

for (const [path, schema] of [
  [
    "automation/schemas/editorial-review-result.schema.json",
    editorialReviewImportSchema,
  ],
  [
    "automation/schemas/article-revision-result.schema.json",
    revisionResultSchema,
  ],
] as const) {
  const output = resolve(path);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(
    output,
    `${JSON.stringify(z.toJSONSchema(schema, { target: "draft-7" }), null, 2)}\n`,
    { mode: 0o600 },
  );
}
