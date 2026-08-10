import { publicSourceUrl } from "../publication/transform";

const forbidden: Array<[RegExp, string]> = [
  [
    /\b(?:\d{1,3}\.){3}\d{1,3}\b|\bip(?:v[46])?[_-]?address\s*[,=:]/i,
    "IP address",
  ],
  [/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/, "email address"],
  [/telegram(?:User|Chat|Update|Message)?Id/i, "Telegram identifier"],
  [
    /(?:user|session|cookie|visitor|client)[_-]?id\s*[,=:]/i,
    "user or session identifier",
  ],
  [/(?:cookie|set-cookie|user-agent)\s*[,=:]/i, "cookie or user-agent data"],
  [
    /(?:gh[pousr]_|vercel_|ya29\.|bot\d{6,}:|api[_-]?key|access[_-]?token|password|secret)\s*[=:]?\s*[A-Za-z0-9_./-]{8,}/i,
    "secret pattern",
  ],
  [
    /[?&](?:token|key|secret|password|signature|session|user|email|utm_[^=]*)=/i,
    "private query parameter",
  ],
  [
    /(?:\/Users\/|[A-Z]:\\|data\/(?:research|review|telegram|writing|final-approval))/i,
    "private runtime path",
  ],
];

export function scrubAnalytics(value: string) {
  const hit = forbidden.find(([pattern]) => pattern.test(value));
  if (hit) throw new Error(`Private analytics data blocked: ${hit[1]}`);
}

export function normalizeCanonical(value: string) {
  const parsed = new URL(value);
  if (
    parsed.search ||
    parsed.hash ||
    /preview|localhost/i.test(parsed.hostname)
  )
    throw new Error("Analytics URL must be an exact public canonical URL");
  const safe = publicSourceUrl(value, true);
  return safe.endsWith("/") ? safe.slice(0, -1) : safe;
}

export function assertPublicPostUrl(value: string) {
  scrubAnalytics(value);
  return publicSourceUrl(value, true);
}
