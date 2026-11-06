// For engines that keep a value's type: reads form or CSV text as a number or boolean only when that
// value prints back exactly, so 007 and very long digits stay text instead of changing.
export function inferValue(text: string): unknown {
  if (text === "true") return true;
  if (text === "false") return false;
  const number = Number(text);
  return text !== "" && Number.isFinite(number) && String(number) === text ? number : text;
}

// A number stays a number, and JSON stays JSON, unless the text cannot be read as one exactly. In that
// case the text goes as it is and the database decides, so a long number is never rounded on its way.
export function parseEdited(text: string, original: unknown, schemaless: boolean): unknown {
  if (typeof original === "number") {
    const number = Number(text);
    return Number.isFinite(number) && String(number) === text.trim() ? number : text;
  }
  if (original === null && schemaless) {
    // A new value on an engine that keeps types. Matches what import does with the same text.
    if (/^\s*[{[]/.test(text)) {
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return text;
      }
    }
    return inferValue(text);
  }
  if (typeof original === "boolean") return text === "true" ? true : text === "false" ? false : text;
  if (original !== null && typeof original === "object") {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`This value must stay valid JSON: ${text.slice(0, 80)}`);
    }
  }
  return text;
}
