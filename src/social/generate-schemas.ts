import { mkdir, writeFile } from "node:fs/promises";
import { z } from "zod";
import {
  importedSocialResultSchema,
  platformContentItemSchema,
  postedRecordSchema,
  socialApprovalSchema,
  socialConversationSchema,
  socialDisclosureSchema,
  socialExportSchema,
  socialHistorySchema,
  socialJobSchema,
  socialPackageSchema,
  socialQualitySchema,
  socialRevisionSchema,
  socialAssetSchema,
  socialDistributionEventSchema,
  socialDistributionPlanSchema,
} from "./models";
const schemas = {
  "social-generation-job": socialJobSchema,
  "social-package": socialPackageSchema,
  "platform-content-item": platformContentItemSchema,
  "social-import-result": importedSocialResultSchema,
  "social-quality-report": socialQualitySchema,
  "social-approval": socialApprovalSchema,
  "social-conversation": socialConversationSchema,
  "social-disclosure": socialDisclosureSchema,
  "social-export": socialExportSchema,
  "social-history": socialHistorySchema,
  "social-revision": socialRevisionSchema,
  "social-posted-record": postedRecordSchema,
  "social-distribution-plan": socialDistributionPlanSchema,
  "social-distribution-event": socialDistributionEventSchema,
  "social-asset": socialAssetSchema,
};
await mkdir("automation/schemas", { recursive: true });
for (const [name, schema] of Object.entries(schemas))
  await writeFile(
    `automation/schemas/${name}.schema.json`,
    `${JSON.stringify(z.toJSONSchema(schema), null, 2)}\n`,
  );
