#!/usr/bin/env node
// End-to-end test of the create-chat-media-upload-url Edge Function
// (docs/16-CHAT-MEDIA-SCOPING.md, 20260925120000_chat_media_pipeline.sql).
// Copied structure from create-status-upload-url-function.test.js — same
// vendor (Supabase Storage), same shape, same reason to actually upload a
// real tiny JPEG rather than just checking the JSON response shape.

const { Client } = require('pg');
const { spawn } = require('node:child_process');
const crypto = require('crypto');
const path = require('node:path');

const DB_URL = process.env.SUPABASE_DB_URL;
const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
const ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

for (const [name, val] of Object.entries({
  SUPABASE_DB_URL: DB_URL,
  EXPO_PUBLIC_SUPABASE_URL: SUPABASE_URL,
  EXPO_PUBLIC_SUPABASE_ANON_KEY: ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
  SUPABASE_JWT_SECRET: JWT_SECRET,
})) {
  if (!val) {
    console.error(`${name} is not set. Run via \`npm run test:functions\` from the repo root.`);
    process.exit(1);
  }
}

const FUNCTION_URL = 'http://127.0.0.1:8000';
const FUNCTION_ENTRY = path.join(
  __dirname,
  '..',
  'functions',
  'create-chat-media-upload-url',
  'index.ts',
);

let pass = 0;
let fail = 0;
function log(label, ok, detail) {
  if (ok) pass++;
  else fail++;
  process.stdout.write(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}\n`);
}

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function mintAccessToken(userId) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    aud: 'authenticated',
    exp: now + 3600,
    iat: now,
    sub: userId,
    role: 'authenticated',
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(signingInput)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${signingInput}.${signature}`;
}

async function createTestUser() {
  const phone = `+234${crypto.randomInt(100000000, 999999999)}`;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ phone, phone_confirm: true }),
  });
  if (!res.ok) throw new Error(`createTestUser failed: ${res.status} ${await res.text()}`);
  return (await res.json()).id;
}

async function deleteTestUser(admin, id) {
  await admin.query('delete from auth.users where id = $1', [id]);
}

async function callCreateChatMediaUploadUrl(token) {
  const headers = {};
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${FUNCTION_URL}/`, { method: 'POST', headers });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function waitForFunctionReady(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`${FUNCTION_URL}/`, { method: 'POST' });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error('create-chat-media-upload-url function did not come up in time');
}

async function main() {
  const admin = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  admin.on('error', (e) => process.stderr.write(`[connection error, non-fatal] ${e.message}\n`));
  await admin.connect();

  const deno = spawn('deno', ['run', '-A', FUNCTION_ENTRY], {
    env: {
      ...process.env,
      SUPABASE_URL,
      SUPABASE_ANON_KEY: ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
    },
  });
  deno.stdout.on('data', (d) => process.stdout.write(`[deno] ${d}`));
  deno.stderr.on('data', (d) => process.stdout.write(`[deno] ${d}`));

  const A = await createTestUser();
  const tokenA = mintAccessToken(A);

  try {
    await waitForFunctionReady(15000);

    const noAuth = await callCreateChatMediaUploadUrl(null);
    log('missing Authorization header -> 401', noAuth.status === 401, `status=${noAuth.status}`);

    const result = await callCreateChatMediaUploadUrl(tokenA);
    log(
      'returns 200 with path/token/signed_url',
      result.status === 200 &&
        typeof result.json?.path === 'string' &&
        typeof result.json?.token === 'string' &&
        typeof result.json?.signed_url === 'string',
      JSON.stringify(result.json),
    );

    log(
      "the returned path is scoped under the caller's own user id",
      result.json?.path?.startsWith(`${A}/`),
      result.json?.path,
    );

    // Prove the signed URL is actually usable end-to-end: upload a tiny
    // real JPEG to it via the real Storage API, then confirm the object
    // exists in the private bucket at that exact path.
    const tinyJpeg = Buffer.from(
      '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMDAwMDAwMDAwMEAwMEBQQEBAQFBQUFBQUFBQYGBgYGBgYICAgICAgICAoKCgoKCgwMDAwMDg4ODg4ODg4ODg4BAwMDBAQEBQUFBQUFBQUFBQUFBQUFBQYFBQUFBQUGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYG/8AAEQgAAQABAwERAAIRAQMRAf/EABQAAQAAAAAAAAAAAAAAAAAAAAX/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF/9k=',
      'base64',
    );
    const uploadRes = await fetch(result.json.signed_url, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg', Authorization: `Bearer ${tokenA}` },
      body: tinyJpeg,
    });
    log(
      'the signed URL accepts a real upload',
      uploadRes.ok,
      `status=${uploadRes.status} ${await uploadRes
        .clone()
        .text()
        .catch(() => '')}`,
    );

    const objectRow = await admin.query(
      "select bucket_id, owner from storage.objects where bucket_id = 'chat-media' and name = $1",
      [result.json.path],
    );
    log(
      'the uploaded object exists in the private chat-media bucket',
      objectRow.rows.length === 1,
      JSON.stringify(objectRow.rows[0]),
    );
  } finally {
    deno.kill();
    await deleteTestUser(admin, A);
    await admin.end();
  }

  process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
  process.exitCode = fail > 0 ? 1 : 0;
  process.exit(process.exitCode);
}

main().catch((e) => {
  console.error('SCRIPT_ERROR:', e);
  process.exit(1);
});
