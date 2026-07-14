/**
 * Lightweight request-body parsing helper for Next.js API route handlers.
 *
 * Usage:
 *   const result = await parseBody(request, (x): MyShape | null => {
 *     if (typeof x !== 'object' || x === null) return null;
 *     const o = x as Record<string, unknown>;
 *     if (typeof o.foo !== 'string') return null;
 *     return { foo: o.foo };
 *   });
 *   if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
 *   const { foo } = result.data; // typed
 *
 * Rules:
 * - No dependencies beyond native fetch / Next.js Request.
 * - The validator function returns `T` on success, `null` on invalid shape.
 * - JSON parse errors and validator-returned-null both surface as `{ ok: false }`.
 * - Never throws; all errors are returned as discriminated union values.
 */

export type ParseBodyResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

/**
 * Parse the JSON body of a Next.js `Request` and validate its shape.
 *
 * @param request  The incoming `Request` object from a route handler.
 * @param validator A function that accepts `unknown` and returns `T` if valid,
 *                  or `null` if the shape does not match expectations.
 */
export async function parseBody<T>(
  request: Request,
  validator: (x: unknown) => T | null,
): Promise<ParseBodyResult<T>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { ok: false, error: 'invalid_json' };
  }

  const data = validator(raw);
  if (data === null) {
    return { ok: false, error: 'invalid_body' };
  }

  return { ok: true, data };
}
