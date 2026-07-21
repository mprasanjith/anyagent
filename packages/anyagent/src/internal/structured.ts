// biome-ignore lint/suspicious/noExplicitAny: JSON Schema is dynamically shaped.
type Schema = Record<string, any>;

const FENCE = /```(?:json)?\s*\n?(?<body>[\s\S]*?)```/u;
const JSON_OPENER = /[{[]/u;

const matchingSlice = (text: string): string | undefined => {
  const start = text.search(JSON_OPENER);
  if (start === -1) {
    return;
  }
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  const end = text.lastIndexOf(close);
  return end > start ? text.slice(start, end + 1) : undefined;
};

/**
 * Pull a JSON value out of a model's reply. Tries, in order: the whole trimmed
 * text as JSON; the contents of the first fenced code block; the substring
 * from the first `{`/`[` to the matching last `}`/`]`. Throws if none parse —
 * an agent that answered in prose leaves nothing to parse.
 */
export const extractJson = (text: string): unknown => {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall through to the more forgiving strategies below.
  }
  const fenced = FENCE.exec(trimmed)?.groups?.body;
  if (fenced !== undefined) {
    try {
      return JSON.parse(fenced.trim());
    } catch {
      // Fall through.
    }
  }
  const sliced = matchingSlice(trimmed);
  if (sliced !== undefined) {
    return JSON.parse(sliced);
  }
  throw new SyntaxError("no JSON value found in reply");
};

const typeOf = (value: unknown): string => {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
};

const typeMatches = (value: unknown, type: string): boolean => {
  switch (type) {
    case "array": {
      return Array.isArray(value);
    }
    case "integer": {
      return typeof value === "number" && Number.isInteger(value);
    }
    case "object": {
      return typeOf(value) === "object";
    }
    default: {
      return typeOf(value) === type;
    }
  }
};

const checkEnum = (value: unknown, schema: Schema, path: string): string[] => {
  if (!Array.isArray(schema.enum)) {
    return [];
  }
  const ok = schema.enum.some(
    (e: unknown) => e === value || JSON.stringify(e) === JSON.stringify(value)
  );
  return ok ? [] : [`${path}: value not in enum`];
};

const checkObject = (
  value: unknown,
  schema: Schema,
  path: string
): string[] => {
  if (!schema.properties || typeOf(value) !== "object") {
    return [];
  }
  const errors: string[] = [];
  const obj = value as Record<string, unknown>;
  for (const [key, sub] of Object.entries(schema.properties as Schema)) {
    if (key in obj) {
      errors.push(...check(obj[key], sub as Schema, `${path}.${key}`));
    }
  }
  for (const key of (schema.required ?? []) as string[]) {
    if (!(key in obj)) {
      errors.push(`${path}.${key}: required`);
    }
  }
  return errors;
};

const checkItems = (value: unknown, schema: Schema, path: string): string[] => {
  if (!(schema.items && Array.isArray(value))) {
    return [];
  }
  return value.flatMap((item, i) =>
    check(item, schema.items as Schema, `${path}[${i}]`)
  );
};

const check = (value: unknown, schema: Schema, path: string): string[] => {
  if (typeof schema.type === "string" && !typeMatches(value, schema.type)) {
    // The value is the wrong shape; deeper checks would only add noise.
    return [`${path}: expected ${schema.type}, got ${typeOf(value)}`];
  }
  return [
    ...checkEnum(value, schema, path),
    ...checkObject(value, schema, path),
    ...checkItems(value, schema, path),
  ];
};

/**
 * Validate a parsed value against a JSON Schema, returning human-readable
 * error strings (empty means valid). Each error carries a JSON path, e.g.
 * `$.user.name: expected string, got number`. Only the essentials are
 * honored — `type` (including `"integer"` and `"array"`), `properties` +
 * `required` (recursively), `items` (a single schema), and `enum`. Every
 * other JSON Schema keyword is ignored.
 */
export const validateAgainstSchema = (
  value: unknown,
  schema: Record<string, unknown>
): string[] => check(value, schema as Schema, "$");
