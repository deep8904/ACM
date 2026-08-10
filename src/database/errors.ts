const connectionUrlPattern = /postgres(?:ql)?:\/\/[^\s"']+/gi;
const passwordFieldPattern = /(password|passwd|pwd)=([^\s&]+)/gi;

export type DatabaseErrorCategory =
  | "configuration"
  | "connection"
  | "constraint"
  | "conflict"
  | "timeout"
  | "migration"
  | "unknown";

export class DurableStorageError extends Error {
  constructor(
    readonly category: DatabaseErrorCategory,
    message: string,
    readonly retryable = false,
    readonly code?: string,
  ) {
    super(redactDatabaseSecrets(message));
    this.name = "DurableStorageError";
  }
}

export function redactDatabaseSecrets(value: string): string {
  return value
    .replace(connectionUrlPattern, "[REDACTED_DATABASE_URL]")
    .replace(passwordFieldPattern, "$1=[REDACTED]");
}

export function normalizeDatabaseError(error: unknown): DurableStorageError {
  if (error instanceof DurableStorageError) return error;
  const candidate = error as { code?: string; message?: string };
  const code = candidate?.code;
  const message = candidate?.message ?? "Unknown database error";
  if (code === "23505")
    return new DurableStorageError("conflict", message, false, code);
  if (code?.startsWith("23"))
    return new DurableStorageError("constraint", message, false, code);
  if (code === "57014")
    return new DurableStorageError("timeout", message, true, code);
  if (code?.startsWith("08") || code === "57P01") {
    return new DurableStorageError("connection", message, true, code);
  }
  return new DurableStorageError("unknown", message, false, code);
}
