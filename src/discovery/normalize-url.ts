const trackingParameterNames = new Set([
  "dclid",
  "fbclid",
  "gclid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "msclkid",
]);

export class InvalidUrlError extends Error {
  constructor(value: string) {
    super(`Invalid HTTP(S) URL: ${value}`);
    this.name = "InvalidUrlError";
  }
}

export function normalizeUrl(value: string): string {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new InvalidUrlError(value);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new InvalidUrlError(value);
  }

  url.hostname = url.hostname.toLowerCase();
  url.hash = "";

  if (
    (url.protocol === "http:" && url.port === "80") ||
    (url.protocol === "https:" && url.port === "443")
  ) {
    url.port = "";
  }

  for (const key of [...url.searchParams.keys()]) {
    const normalizedKey = key.toLowerCase();
    if (
      normalizedKey.startsWith("utm_") ||
      trackingParameterNames.has(normalizedKey)
    ) {
      url.searchParams.delete(key);
    }
  }

  const sortedParameters = [...url.searchParams.entries()].sort(
    ([keyA, valueA], [keyB, valueB]) =>
      keyA === keyB ? valueA.localeCompare(valueB) : keyA.localeCompare(keyB),
  );
  url.search = "";
  for (const [key, parameterValue] of sortedParameters) {
    url.searchParams.append(key, parameterValue);
  }

  if (url.pathname.length > 1) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }

  return url.toString();
}
