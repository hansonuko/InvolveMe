import { redirect } from 'next/navigation';
import { getCurrentAdmin } from '@/lib/auth';

export default async function RootPage() {
  const admin = await getCurrentAdmin();
  redirect(admin ? '/dashboard' : '/login');
}
