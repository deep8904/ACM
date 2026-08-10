import { mkdir, writeFile } from "node:fs/promises";
import { z } from "zod";
import {
  consumptionRecordSchema,
  deploymentRecordSchema,
  publicationJobSchema,
  publicationRecordSchema,
  publicationVerificationSchema,
  publishedArticleSnapshotSchema,
  sourceReferenceSchema,
} from "./models";
const schemas = {
  "publication-job": publicationJobSchema,
  "publication-record": publicationRecordSchema,
  "published-article-snapshot": publishedArticleSnapshotSchema,
  "source-reference": sourceReferenceSchema,
  "deployment-record": deploymentRecordSchema,
  "publication-verification": publicationVerificationSchema,
  "publication-consumption": consumptionRecordSchema,
};
await mkdir("automation/schemas", { recursive: true });
for (const [name, schema] of Object.entries(schemas))
  await writeFile(
    `automation/schemas/${name}.schema.json`,
    `${JSON.stringify(z.toJSONSchema(schema), null, 2)}\n`,
  );
