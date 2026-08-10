import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { writeAtomicJson } from "./persistence";

describe("writeAtomicJson", () => {
  it("replaces a file atomically and leaves deterministic content", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ai-content-persistence-"));
    const path = join(directory, "result.json");
    const value = { items: [{ id: "one" }] };

    await writeAtomicJson(path, value);
    const first = await readFile(path, "utf8");
    await writeAtomicJson(path, value);
    const second = await readFile(path, "utf8");

    expect(second).toBe(first);
    expect(await readdir(directory)).toEqual(["result.json"]);
  });
});
