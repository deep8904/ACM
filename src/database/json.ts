import type { JSONValue } from "postgres";

/** Converts validated domain data to the driver's strict JSON-compatible type. */
export function toJsonValue(value: unknown): JSONValue {
  return JSON.parse(JSON.stringify(value)) as JSONValue;
}
