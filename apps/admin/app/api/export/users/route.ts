import { NextRequest } from 'next/server';
import { getCurrentAdmin, checkPermission } from '@/lib/auth';
import { db } from '@/lib/supabase-admin';
import { sanitizeSearchTerm } from '@/lib/pagination';
import { rowsToCsv, EXPORT_ROW_CAP } from '@/lib/csv';

// The first Route Handler in this app — every other mutation/read so far
// is a Server Action or a Server Component fetch, neither of which can
// hand the browser a file to download (a Server Action's response is JS
// data, not an HTTP response the browser will save). A GET here, linked
// from the Users list page, is the only way to get a real
// Content-Disposition: attachment response.
//
// middleware.ts only matches /dashboard/:path* (see its own config) — API
// routes get no free auth check from it, so this handler re-derives and
// re-checks the admin itself, same "the real check happens here, not just
// at page navigation" posture every Server Action in this codebase already
// follows (lib/auth.ts's own comment on getCurrentAdmin explains why).
export async function GET(request: NextRequest) {
  const admin = await getCurrentAdmin();
  if (!admin) return new Response('Unauthorized', { status: 401 });

  const allowed = await checkPermission(admin.id, 'view_users');
  if (!allowed) return new Response('Forbidden', { status: 403 });

  const q = sanitizeSearchTerm(request.nextUrl.searchParams.get('q') ?? '');

  let countQuery = db().from('users').select('id', { count: 'exact', head: true });
  if (q) countQuery = countQuery.or(`phone.ilike.%${q}%,display_name.ilike.%${q}%`);
  const { count, error: countError } = await countQuery;
  if (countError) {
    return new Response('Could not count matching users.', { status: 500 });
  }
  if ((count ?? 0) > EXPORT_ROW_CAP) {
    return new Response(
      `Too many matching rows (${count}) to export — refine your search first. The cap is ${EXPORT_ROW_CAP.toLocaleString()}.`,
      { status: 400 },
    );
  }

  let rowsQuery = db()
    .from('users')
    .select('id, phone, display_name, kyc_tier, is_suspended, country, created_at')
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(EXPORT_ROW_CAP);
  if (q) rowsQuery = rowsQuery.or(`phone.ilike.%${q}%,display_name.ilike.%${q}%`);

  const { data, error } = await rowsQuery;
  if (error) {
    return new Response('Could not export users.', { status: 500 });
  }

  const csv = rowsToCsv(
    ['id', 'phone', 'display_name', 'kyc_tier', 'is_suspended', 'country', 'created_at'],
    (data ?? []).map((row) => [
      row.id,
      row.phone ?? '',
      row.display_name ?? '',
      row.kyc_tier,
      row.is_suspended,
      row.country ?? '',
      row.created_at,
    ]),
  );

  return new Response(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="users-export-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}
