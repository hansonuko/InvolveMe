import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';

/** Placeholder — thread list lands in Phase 2 (docs/08-BUILD-PHASES-ROADMAP.md). */
export default function ChatsScreen() {
  return (
    <Screen style={{ justifyContent: 'center', alignItems: 'center' }}>
      <Text variant="title">Chats</Text>
      <Text variant="body" color="secondary">
        Your conversations will show up here.
      </Text>
    </Screen>
  );
}
