import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { postedRecordSchema, type PostedRecord } from "../social/models";

const missing = (error: unknown) =>
  error instanceof Error &&
  "code" in error &&
  (error as NodeJS.ErrnoException).code === "ENOENT";
async function names(path: string) {
  try {
    return (await readdir(path)).sort();
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
}
export class FilePostedRecordAnalyticsSource {
  constructor(private socialRoot: string) {}
  async list(): Promise<PostedRecord[]> {
    const output: PostedRecord[] = [];
    const root = join(this.socialRoot, "posted");
    for (const publicationId of await names(root)) {
      for (const file of await names(join(root, publicationId))) {
        if (!file.endsWith(".json")) continue;
        output.push(
          postedRecordSchema.parse(
            JSON.parse(await readFile(join(root, publicationId, file), "utf8")),
          ),
        );
      }
    }
    return output;
  }
}
