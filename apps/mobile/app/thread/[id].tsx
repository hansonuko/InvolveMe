import { Stack, useLocalSearchParams } from 'expo-router';

import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';

/** Placeholder — full thread UI (bubbles, escrow badges, composer) lands in Phase 2. */
export default function ThreadScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();

  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: 'Thread' }} />
      <Screen style={{ justifyContent: 'center', alignItems: 'center' }}>
        <Text variant="title">Thread</Text>
        <Text variant="caption" color="secondary">
          {id}
        </Text>
      </Screen>
    </>
  );
}
