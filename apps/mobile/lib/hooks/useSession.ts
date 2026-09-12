import type { Session } from '@supabase/supabase-js';
import { useEffect, useState } from 'react';

import { supabase } from '@/lib/supabase';

/** Live auth session — drives the (auth) vs (tabs) redirect in app/_layout.tsx. */
export function useSession() {
  const [session, setSession] = useState<Session | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setIsLoading(false);
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
    });

    return () => subscription.subscription.unsubscribe();
  }, []);

  return { session, isLoading };
}
