#!/usr/bin/env node
// End-to-end test of the create-profile-upload-url Edge Function against
// the real linked dev database and real Storage API — same pattern
// create-status-upload-url-function.test.js already establishes (that one
// is the closest sibling to model this on).

const { spawn } = require('node:child_process');
const crypto = require('crypto');
const path = require('node:path');

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
const ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

for (const [name, val] of Object.entries({
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
  'create-profile-upload-url',
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

async function deleteTestUser(id) {
  await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${id}`, {
    method: 'DELETE',
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
  });
}

async function callCreateProfileUploadUrl(token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${FUNCTION_URL}/`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function waitForFunctionReady(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`${FUNCTION_URL}/`, { method: 'POST', body: '{}' });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error('create-profile-upload-url function did not come up in time');
}

async function main() {
  const deno = spawn('deno', ['run', '-A', FUNCTION_ENTRY], {
    env: {
      ...process.env,
      SUPABASE_URL,
      SUPABASE_ANON_KEY: ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
    },
  });
  deno.stdout.on('data', (d) => process.stdout.write(`[deno] ${d}`));
  deno.stderr.on('data', (d) => process.stderr.write(`[deno] ${d}`));

  const userId = await createTestUser();
  const token = mintAccessToken(userId);

  try {
    await waitForFunctionReady(15000);

    const noAuth = await callCreateProfileUploadUrl(null, { kind: 'avatar' });
    log('missing Authorization header -> 401', noAuth.status === 401, `status=${noAuth.status}`);

    const badKind = await callCreateProfileUploadUrl(token, { kind: 'banner' });
    log(
      'invalid kind -> 400 invalid_request',
      badKind.status === 400 && badKind.json?.error === 'invalid_request',
      JSON.stringify(badKind.json),
    );

    const avatar = await callCreateProfileUploadUrl(token, { kind: 'avatar' });
    log(
      'valid avatar request -> 200 with a real signed URL scoped to this user',
      avatar.status === 200 &&
        typeof avatar.json?.signed_url === 'string' &&
        avatar.json?.path === `${userId}/avatar.jpg` &&
        avatar.json?.public_url?.includes(`${userId}/avatar.jpg`),
      `status=${avatar.status} path=${avatar.json?.path}`,
    );

    // Upload real bytes through the signed URL, matching create-status-
    // upload-url's own end-to-end proof — a tiny valid JPEG, not just a
    // 200 from this function.
    const tinyJpegBase64 =
      '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=';
    const jpegBuffer = Buffer.from(tinyJpegBase64, 'base64');

    const uploadRes = await fetch(avatar.json.signed_url, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg' },
      body: jpegBuffer,
    });
    log(
      'uploading real bytes to the signed URL succeeds',
      uploadRes.ok,
      `status=${uploadRes.status}`,
    );

    const publicFetch = await fetch(avatar.json.public_url.split('?')[0]);
    log(
      'the uploaded avatar is fetchable at its public URL',
      publicFetch.ok && publicFetch.headers.get('content-type')?.includes('image'),
      `status=${publicFetch.status}`,
    );

    // upsert: true means a second request for the same kind must succeed,
    // not 409 on "already exists".
    const secondAvatar = await callCreateProfileUploadUrl(token, { kind: 'avatar' });
    log(
      're-requesting an upload URL for the same kind succeeds (upsert, not 409)',
      secondAvatar.status === 200 && secondAvatar.json?.path === `${userId}/avatar.jpg`,
      `status=${secondAvatar.status}`,
    );

    const cover = await callCreateProfileUploadUrl(token, { kind: 'cover' });
    log(
      'cover kind gets its own distinct path',
      cover.status === 200 && cover.json?.path === `${userId}/cover.jpg`,
      `path=${cover.json?.path}`,
    );
  } finally {
    deno.kill();
    // Clean up the uploaded objects via the service-role client — no pg
    // connection in this file, matching create-status-upload-url-function
    // .test.js's own HTTP-only style.
    await fetch(`${SUPABASE_URL}/storage/v1/object/profile-media/${userId}/avatar.jpg`, {
      method: 'DELETE',
      headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
    }).catch(() => {});
    await fetch(`${SUPABASE_URL}/storage/v1/object/profile-media/${userId}/cover.jpg`, {
      method: 'DELETE',
      headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
    }).catch(() => {});
    await deleteTestUser(userId);
  }

  process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
  process.exitCode = fail > 0 ? 1 : 0;
  process.exit(process.exitCode);
}

main().catch((e) => {
  console.error('SCRIPT_ERROR:', e);
  process.exit(1);
});
