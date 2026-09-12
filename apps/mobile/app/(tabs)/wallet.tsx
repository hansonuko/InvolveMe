import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';

/**
 * Placeholder — the InvolveMe-specific tab. Real balance/withdrawal UI is
 * blocked on Phase 1 (ledger) + Phase 3 (payments) per the roadmap; this
 * screen intentionally shows no numbers yet rather than fake/hardcoded ones.
 */
export default function WalletScreen() {
  return (
    <Screen style={{ justifyContent: 'center', alignItems: 'center' }}>
      <Text variant="title">Wallet</Text>
      <Text variant="body" color="secondary">
        Your chat credit and earnings will show up here.
      </Text>
    </Screen>
  );
}
