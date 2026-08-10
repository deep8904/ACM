import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

import type { FetchImplementation } from "./adapters/types";

export function createFixtureFetch(rootDirectory: string): FetchImplementation {
  const root = resolve(rootDirectory);

  return async (input) => {
    const url = new URL(input.toString());
    if (url.hostname !== "fixtures.local") {
      throw new Error(
        `Fixture mode blocked unexpected network host: ${url.hostname}`,
      );
    }

    const relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const path = resolve(root, relativePath);
    if (path !== root && !path.startsWith(`${root}${sep}`)) {
      return new Response("Invalid fixture path", { status: 400 });
    }

    try {
      const body = await readFile(path);
      return new Response(body, {
        status: 200,
        headers: {
          "content-type":
            extname(path) === ".json" ? "application/json" : "application/xml",
          "content-length": String(body.byteLength),
        },
      });
    } catch {
      return new Response("Fixture not found", { status: 404 });
    }
  };
}
