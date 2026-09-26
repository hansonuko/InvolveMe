// Real end-to-end encryption, step 4 (docs/21-E2EE-TECHNICAL-DESIGN.md §3,
// §4) — the request-body shape for one Double Ratchet envelope, shared
// between send-message and edit-message (both now e2ee-aware). Validates
// shape only (well-formed base64, plausible lengths, non-negative
// integers) — fn_send_message/fn_edit_message are the real authority on
// everything security-sensitive (recipient device ownership, revocation,
// the actual byte-length billing cap), same "Zod validates shape, the DB
// function validates business rules" split every other Edge Function in
// this codebase already follows.
//
// x3dh_sender_identity_key/x3dh_sender_ephemeral_key must be both present
// or both absent — enforced again at the table level
// (e2ee_message_envelopes_x3dh_paired) since that's the layer every
// insert path shares, but checked here too so a malformed request gets a
// clear 400 instead of a raw Postgres constraint-violation error.

import { z } from 'npm:zod@^3.23';
import { requiredBase64Bytes, requiredBase64Key, requiredUuid } from './validate.ts';

const optionalBase64Key = (fieldName: string, byteLength: number) =>
  requiredBase64Key(fieldName, byteLength).nullable().optional();

export const E2eeEnvelopeSchema = z
  .object({
    recipient_device_id: requiredUuid('envelopes[].recipient_device_id'),
    // 17 = 1 content byte + the 16-byte Poly1305 AEAD tag (docs/21 §4)  —
    // the smallest a real envelope's ciphertext could ever be.
    ciphertext: requiredBase64Bytes('envelopes[].ciphertext', 17),
    ratchet_public_key: requiredBase64Key('envelopes[].ratchet_public_key', 32),
    previous_chain_length: z
      .number({
        required_error: 'envelopes[].previous_chain_length is required.',
        invalid_type_error: 'envelopes[].previous_chain_length must be a non-negative integer.',
      })
      .int()
      .nonnegative(),
    message_number: z
      .number({
        required_error: 'envelopes[].message_number is required.',
        invalid_type_error: 'envelopes[].message_number must be a non-negative integer.',
      })
      .int()
      .nonnegative(),
    x3dh_sender_identity_key: optionalBase64Key('envelopes[].x3dh_sender_identity_key', 32),
    x3dh_sender_ephemeral_key: optionalBase64Key('envelopes[].x3dh_sender_ephemeral_key', 32),
    x3dh_one_time_prekey_id: z.number().int().nonnegative().nullable().optional(),
  })
  .refine(
    (envelope) =>
      (envelope.x3dh_sender_identity_key == null) === (envelope.x3dh_sender_ephemeral_key == null),
    {
      message:
        'envelopes[].x3dh_sender_identity_key and x3dh_sender_ephemeral_key must be both present or both absent.',
    },
  );

export const E2eeEnvelopesArraySchema = z
  .array(E2eeEnvelopeSchema, {
    required_error: 'envelopes is required for an end-to-end-encrypted thread.',
    invalid_type_error: 'envelopes must be an array.',
  })
  .min(1, 'envelopes must be a non-empty array.');
