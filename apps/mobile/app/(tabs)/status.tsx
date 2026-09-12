import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';

/** Placeholder — status ring feed + composer lands in Phase 6. */
export default function StatusScreen() {
  return (
    <Screen style={{ justifyContent: 'center', alignItems: 'center' }}>
      <Text variant="title">Status</Text>
      <Text variant="body" color="secondary">
        Status updates cost a few credits — coming in a later phase.
      </Text>
    </Screen>
  );
}
