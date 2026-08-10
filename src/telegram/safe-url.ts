import { isIP } from "node:net";
import { promises as dns } from "node:dns";

import { normalizeUrl } from "../discovery/normalize-url";
import { TelegramControlError } from "./errors";
import type { DnsLookup } from "./interfaces";

const blockedHostnames = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata",
]);
const allowedPorts = new Set(["", "80", "443", "8080", "8443"]);

export const systemDnsLookup: DnsLookup = async (hostname) => {
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  return records.map(({ address }) => address);
};

export async function validateManualUrl(
  value: string,
  lookup: DnsLookup = systemDnsLookup,
): Promise<string> {
  return normalizeUrl((await validatePublicHttpUrl(value, lookup)).toString());
}

export async function validateNavigationUrl(
  value: string,
  lookup: DnsLookup = systemDnsLookup,
): Promise<string> {
  const url = await validatePublicHttpUrl(value, lookup);
  url.hash = "";
  return url.toString();
}

async function validatePublicHttpUrl(
  value: string,
  lookup: DnsLookup,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid("Enter a valid HTTP or HTTPS URL");
  }
  if (!new Set(["http:", "https:"]).has(url.protocol))
    throw invalid("Only HTTP and HTTPS URLs are allowed");
  if (url.username || url.password)
    throw invalid("URLs containing credentials are not allowed");
  if (!allowedPorts.has(url.port))
    throw invalid("This URL port is not allowed");
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (blockedHostnames.has(hostname) || hostname.endsWith(".localhost"))
    throw invalid("Local and metadata hosts are not allowed");

  const addresses = isIP(hostname)
    ? [hostname]
    : await lookup(hostname).catch(() => {
        throw invalid("The URL hostname could not be resolved safely");
      });
  if (addresses.length === 0 || addresses.some(isBlockedAddress)) {
    throw invalid("The URL resolves to a private, reserved, or local address");
  }
  return url;
}

export function isBlockedAddress(address: string): boolean {
  const normalized =
    address.toLowerCase().split("%")[0] ?? address.toLowerCase();
  if (isIP(normalized) === 4) {
    const parts = normalized.split(".").map(Number);
    const [a = -1, b = -1, c = -1] = parts;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }
  if (isIP(normalized) === 6) {
    const mapped = mappedIpv4(normalized);
    if (mapped) return isBlockedAddress(mapped);
    if (normalized === "::" || normalized === "::1") return true;
    if (
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      /^fe[89ab]/.test(normalized)
    )
      return true;
    if (normalized.startsWith("ff")) return true;
    if (normalized.startsWith("2001:db8")) return true;
    return false;
  }
  return true;
}

function mappedIpv4(address: string): string | undefined {
  const words = ipv6Words(address);
  if (
    !words ||
    words.slice(0, 5).some((word) => word !== 0) ||
    words[5] !== 0xffff
  )
    return undefined;
  const [high = 0, low = 0] = words.slice(6);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

function ipv6Words(address: string): number[] | undefined {
  const sections = address.split("::");
  if (sections.length > 2) return undefined;
  const left = ipv6Section(sections[0] ?? "");
  const right = ipv6Section(sections[1] ?? "");
  if (!left || !right) return undefined;
  if (sections.length === 1) return left.length === 8 ? left : undefined;
  const missing = 8 - left.length - right.length;
  return missing > 0
    ? [...left, ...Array(missing).fill(0), ...right]
    : undefined;
}

function ipv6Section(section: string): number[] | undefined {
  if (!section) return [];
  const parts = section.split(":");
  const words: number[] = [];
  for (const [index, part] of parts.entries()) {
    if (part.includes(".")) {
      if (index !== parts.length - 1) return undefined;
      const octets = part.split(".").map(Number);
      if (
        octets.length !== 4 ||
        octets.some(
          (octet) => !Number.isInteger(octet) || octet < 0 || octet > 255,
        )
      )
        return undefined;
      words.push(
        ((octets[0] as number) << 8) | (octets[1] as number),
        ((octets[2] as number) << 8) | (octets[3] as number),
      );
      continue;
    }
    if (!/^[a-f0-9]{1,4}$/i.test(part)) return undefined;
    words.push(Number.parseInt(part, 16));
  }
  return words;
}

function invalid(message: string): TelegramControlError {
  return new TelegramControlError("invalid_url", message, 400);
}
