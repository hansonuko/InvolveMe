import { Stack, useRouter } from 'expo-router';

import { Button } from '@/components/ui/Button';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';
import { supabase } from '@/lib/supabase';

/** Placeholder settings screen — sign-out is wired since it's needed to test the auth gate end-to-end. */
export default function SettingsScreen() {
  const router = useRouter();

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    router.replace('/(auth)');
  };

  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: 'Settings' }} />
      <Screen style={{ justifyContent: 'space-between' }}>
        <Text variant="body" color="secondary" style={{ marginTop: 24 }}>
          KYC status, bank account, and privacy settings land alongside Phase 3 (payments).
        </Text>
        <Button label="Sign out" variant="secondary" onPress={handleSignOut} />
      </Screen>
    </>
  );
}
