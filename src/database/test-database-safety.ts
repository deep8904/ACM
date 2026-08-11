const REMOTE_TEST_CONFIRMATION = "I_UNDERSTAND_THIS_DATABASE_WILL_BE_MUTATED";

export function safeTestDatabaseUrl(
  environment: Record<string, string | undefined>,
): string | undefined {
  const testUrl = environment.TEST_DATABASE_URL;
  if (!testUrl) return undefined;

  const identity = databaseIdentity(testUrl);
  for (const configured of [
    environment.DATABASE_URL,
    environment.DATABASE_DIRECT_URL,
  ]) {
    if (configured && databaseIdentity(configured) === identity) {
      throw new Error(
        "TEST_DATABASE_URL must not target the configured application database",
      );
    }
  }

  if (
    !isLocalDatabase(testUrl) &&
    environment.CONFIRM_DISPOSABLE_TEST_DATABASE !== REMOTE_TEST_CONFIRMATION
  ) {
    throw new Error(
      `Remote Postgres tests require CONFIRM_DISPOSABLE_TEST_DATABASE=${REMOTE_TEST_CONFIRMATION}`,
    );
  }
  return testUrl;
}

function databaseIdentity(value: string): string {
  const url = new URL(value);
  return `${url.hostname.toLowerCase()}:${url.port || "5432"}${url.pathname}`;
}

function isLocalDatabase(value: string): boolean {
  const host = new URL(value).hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}
