// _shared/validate.ts — systematic request-body validation
// (docs/19-SECURITY-HARDENING-SCOPING.md §4). Every Edge Function used to
// hand-roll its own `typeof x !== 'string'` / regex checks inline —
// correct in each case audited, but inconsistent in shape across ~40
// functions and easy to miss a field on a new one. This replaces that with
// one Zod schema per function, parsed here, with a uniform 400 response
// shape — not a new validation *policy*, just one enforcement point instead
// of forty hand-written ones.

import { z } from 'npm:zod@^3.23';

export function parseBody<T extends z.ZodTypeAny>(
  schema: T,
  body: unknown,
): { success: true; data: z.infer<T> } | { success: false; response: Response } {
  const result = schema.safeParse(body);
  if (result.success) {
    return { success: true, data: result.data };
  }

  const firstIssue = result.error.issues[0];
  const message = firstIssue?.message ?? 'Invalid request body.';

  return {
    success: false,
    response: new Response(
      JSON.stringify({
        error: 'invalid_request',
        message,
        fieldErrors: result.error.flatten().fieldErrors,
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    ),
  };
}

// Shared primitive schemas every function's own body otherwise re-declared
// its own ad hoc regex for — one canonical definition instead of forty
// slightly-different copies of the same UUID/phone pattern.
export const uuidSchema = z.string().uuid();
export const e164PhoneSchema = z
  .string()
  .regex(/^\+[1-9]\d{7,14}$/, 'Must be a valid E.164 phone number.');

// A required non-empty string field, same message for "missing" and
// "wrong type" (matching this codebase's existing convention of one
// message per field regardless of which way it's malformed).
export function requiredString(fieldName: string) {
  const message = `${fieldName} is required.`;
  return z.string({ required_error: message, invalid_type_error: message }).trim().min(1, message);
}

// A required UUID field, one message for every failure mode.
export function requiredUuid(fieldName: string) {
  const message = `${fieldName} must be a valid UUID.`;
  return z.string({ required_error: message, invalid_type_error: message }).uuid(message);
}

// A required boolean field, one message for every failure mode.
export function requiredBoolean(fieldName: string) {
  const message = `${fieldName} must be a boolean.`;
  return z.boolean({ required_error: message, invalid_type_error: message });
}

// A base64-encoded key/signature field that must decode to exactly
// `byteLength` bytes — used for E2EE key material
// (docs/21-E2EE-TECHNICAL-DESIGN.md), where malformed key material would
// otherwise fail silently much later (as "crypto doesn't work") rather
// than with a clear error at the point it was actually submitted.
export function requiredBase64Key(fieldName: string, byteLength: number) {
  const message = `${fieldName} must be a base64-encoded ${byteLength}-byte key.`;
  return z.string({ required_error: message, invalid_type_error: message }).refine(
    (value) => {
      // atob() (Web-standard, not Deno's Node-compat Buffer) so this
      // behaves identically locally and on the deployed edge runtime —
      // no dependency on which Node-compat globals a given Deno version
      // happens to expose.
      try {
        return atob(value).length === byteLength;
      } catch {
        return false;
      }
    },
    { message },
  );
}
