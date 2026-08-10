const filler = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "for",
  "to",
  "of",
  "in",
  "on",
  "with",
  "what",
  "why",
  "how",
]);
export function createSlug(title: string, maximum = 80) {
  const words = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((word, index) => word && (index === 0 || !filler.has(word)));
  let slug = words.join("-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (slug.length > maximum)
    slug = slug
      .slice(0, maximum)
      .replace(/-[^-]*$/, "")
      .replace(/-$/, "");
  if (!slug) throw new Error("Title cannot produce a safe slug");
  return slug;
}
export function assertSafeSlug(value: string, maximum = 80) {
  if (
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) ||
    value.length > maximum ||
    value.includes("..")
  )
    throw new Error("Slug is invalid or unsafe");
  return value;
}
