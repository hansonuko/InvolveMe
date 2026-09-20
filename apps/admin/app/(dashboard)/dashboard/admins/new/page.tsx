import { redirect } from 'next/navigation';
import { getCurrentAdmin, checkPermission } from '@/lib/auth';
import { db } from '@/lib/supabase-admin';
import { CreateAdminForm } from './create-admin-form';

export default async function NewAdminPage() {
  const admin = await getCurrentAdmin();
  if (!admin) redirect('/login');

  const allowed = await checkPermission(admin.id, 'manage_admin_roles');
  if (!allowed) redirect('/dashboard');

  const { data: roles } = await db()
    .from('admin_roles')
    .select('id, name, description')
    .order('name');

  return (
    <main className="p-8">
      <h1 className="text-lg font-semibold text-[var(--foreground)]">Create admin account</h1>
      <CreateAdminForm roles={roles ?? []} />
    </main>
  );
}
