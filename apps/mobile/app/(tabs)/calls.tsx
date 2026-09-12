import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';

/**
 * Stub only. Calls are explicitly deferred out of v1 — see
 * docs/08-BUILD-PHASES-ROADMAP.md "Explicitly deferred out of v1": no
 * monetization model has been designed for voice/video yet.
 */
export default function CallsScreen() {
  return (
    <Screen style={{ justifyContent: 'center', alignItems: 'center' }}>
      <Text variant="title">Calls</Text>
      <Text variant="body" color="secondary">
        Not available yet.
      </Text>
    </Screen>
  );
}
