import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { DatabaseClient } from "./client";
import { sha256 } from "./hash";
import { toJsonValue } from "./json";

export interface WorkflowArtifact {
  runId: string;
  stage:
    | "discovery"
    | "ranking"
    | "telegram"
    | "research"
    | "writing"
    | "review"
    | "publication"
    | "social"
    | "analytics";
  name: string;
  mediaType: string;
  content: string | unknown;
  contentHash: string;
}

export interface WorkflowArtifactRepository {
  save(artifact: Omit<WorkflowArtifact, "contentHash">): Promise<boolean>;
  get(
    runId: string,
    stage: WorkflowArtifact["stage"],
    name: string,
  ): Promise<WorkflowArtifact | undefined>;
  location(runId: string, stage: WorkflowArtifact["stage"]): string;
}

export class FileWorkflowArtifactRepository implements WorkflowArtifactRepository {
  constructor(private root: string) {}

  async save(artifact: Omit<WorkflowArtifact, "contentHash">) {
    const path = this.path(artifact.runId, artifact.stage, artifact.name);
    const serialized =
      typeof artifact.content === "string"
        ? artifact.content
        : `${JSON.stringify(artifact.content, null, 2)}\n`;
    await mkdir(this.location(artifact.runId), {
      recursive: true,
    });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600 });
      await link(temporary, path);
      return true;
    } catch (error) {
      if (isFileExists(error)) return false;
      throw error;
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  async get(runId: string, stage: WorkflowArtifact["stage"], name: string) {
    try {
      const serialized = await readFile(this.path(runId, stage, name), "utf8");
      const content: unknown = name.endsWith(".json")
        ? JSON.parse(serialized)
        : serialized;
      return {
        runId,
        stage,
        name,
        mediaType: name.endsWith(".json") ? "application/json" : "text/plain",
        content,
        contentHash: sha256(
          typeof content === "string" ? content : JSON.stringify(content),
        ),
      };
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw error;
    }
  }

  location(runId: string, stage?: WorkflowArtifact["stage"]): string {
    void stage;
    validatePathSegment(runId, "run ID");
    return join(this.root, runId);
  }

  private path(
    runId: string,
    stage: WorkflowArtifact["stage"],
    name: string,
  ): string {
    validatePathSegment(name, "artifact name");
    return join(this.location(runId), name);
  }
}

export class PostgresWorkflowArtifactRepository implements WorkflowArtifactRepository {
  constructor(private sql: DatabaseClient) {}
  async save(artifact: Omit<WorkflowArtifact, "contentHash">) {
    const serialized =
      typeof artifact.content === "string"
        ? artifact.content
        : JSON.stringify(artifact.content);
    const hash = sha256(serialized);
    const rows = await this.sql<{ id: number }[]>`
      insert into content_machine.workflow_artifacts
        (run_id,stage,name,media_type,content_text,payload,byte_length,content_hash)
      values (${artifact.runId},${artifact.stage},${artifact.name},${artifact.mediaType},
        ${typeof artifact.content === "string" ? artifact.content : null},
        ${typeof artifact.content === "string" ? null : this.sql.json(toJsonValue(artifact.content))},
        ${Buffer.byteLength(serialized)},${hash})
      on conflict do nothing returning id
    `;
    return Boolean(rows[0]);
  }
  async get(runId: string, stage: WorkflowArtifact["stage"], name: string) {
    const rows = await this.sql<
      {
        media_type: string;
        content_text: string | null;
        payload: unknown;
        content_hash: string;
      }[]
    >`
      select media_type,content_text,payload,content_hash from content_machine.workflow_artifacts
      where run_id=${runId} and stage=${stage} and name=${name}
    `;
    const row = rows[0];
    return row
      ? {
          runId,
          stage,
          name,
          mediaType: row.media_type,
          content: row.content_text ?? row.payload,
          contentHash: row.content_hash,
        }
      : undefined;
  }
  location(runId: string, stage: WorkflowArtifact["stage"]): string {
    return `database:content_machine.workflow_artifacts/${runId}/${stage}`;
  }
}

function validatePathSegment(value: string, label: string): void {
  if (!value || value === "." || value === ".." || /[\\/]/.test(value))
    throw new Error(`Invalid ${label}`);
}

function isMissingFile(error: unknown): boolean {
  return hasErrorCode(error, "ENOENT");
}

function isFileExists(error: unknown): boolean {
  return hasErrorCode(error, "EEXIST");
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
