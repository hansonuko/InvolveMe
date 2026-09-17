import { useState } from 'react';
import { Modal, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { useTopupStatus, useBuyCredit } from '@/lib/queries/wallet';
import { useTheme } from '@/theme';

import { Button } from './Button';
import { Screen } from './Screen';
import { Text } from './Text';

/** Shown once useTopupStatus reports the topup as 'completed' — see that
 * hook's comment for how it detects this without the user having to back
 * out and check the wallet manually. "Continue" just closes the modal;
 * the wallet screen behind it already reflects the new balance via the
 * same Realtime subscription that drove this. */
function TopupCongrats({ onContinue }: { onContinue: () => void }) {
  const { spacing } = useTheme();
  return (
    <View style={{ gap: spacing.md, marginTop: spacing.xl, alignItems: 'center', flex: 1 }}>
      <Text variant="display">🎉</Text>
      <Text variant="title" style={{ textAlign: 'center' }}>
        Congratulations!
      </Text>
      <Text variant="body" color="secondary" style={{ textAlign: 'center' }}>
        Your credit has landed — you can now start chatting with your loved ones, engage with
        groups, and also earn from it.
      </Text>
      <Button label="Go to wallet" onPress={onContinue} style={{ marginTop: spacing.lg }} />
    </View>
  );
}

/** Shared "buy chat credit" flow — originally wallet.tsx-only, extracted
 * (docs/10-UX-REFINEMENT-BACKLOG.md Batch B, B1) so the thread screen's
 * no-credit prompt can open the exact same flow rather than duplicating
 * it or forcing a detour through the wallet tab. */
export function BuyCreditModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { colors, spacing, radius } = useTheme();
  const buyCredit = useBuyCredit();
  const { data: topupStatus } = useTopupStatus(buyCredit.data?.topup_id);
  const [amountNaira, setAmountNaira] = useState('1000');

  const handleClose = () => {
    buyCredit.reset();
    onClose();
  };

  const handleBuy = () => {
    const kobo = Math.round(Number(amountNaira) * 100);
    if (!Number.isFinite(kobo) || kobo <= 0) return;
    buyCredit.mutate(kobo);
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={handleClose}>
      <Screen>
        <View
          style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}
        >
          <Text variant="title">Buy credit</Text>
          <Pressable onPress={handleClose} hitSlop={12}>
            <Text variant="body" color="secondary">
              Close
            </Text>
          </Pressable>
        </View>

        {topupStatus === 'completed' ? (
          <TopupCongrats onContinue={handleClose} />
        ) : !buyCredit.data ? (
          <View style={{ gap: spacing.md, marginTop: spacing.xl }}>
            <Text variant="caption" color="secondary">
              Amount (₦)
            </Text>
            <TextInput
              value={amountNaira}
              onChangeText={setAmountNaira}
              keyboardType="number-pad"
              placeholderTextColor={colors.textSecondary}
              style={[
                styles.input,
                {
                  backgroundColor: colors.bgSurfaceAlt,
                  color: colors.textPrimary,
                  borderRadius: radius.card,
                  borderColor: colors.borderSubtle,
                },
              ]}
            />
            {buyCredit.isError ? (
              <Text variant="caption" color="danger">
                {buyCredit.error.message}
              </Text>
            ) : null}
            <Button
              label={buyCredit.isPending ? 'Starting…' : 'Continue'}
              onPress={handleBuy}
              disabled={buyCredit.isPending}
            />
          </View>
        ) : (
          <View style={{ gap: spacing.sm, marginTop: spacing.xl }}>
            <Text variant="bodyMedium" color="success">
              You will get {buyCredit.data.credits_issued} credits once this clears.
            </Text>
            <Text variant="caption" color="secondary">
              Transfer ₦{(buyCredit.data.amount_kobo_paid / 100).toLocaleString()} to:
            </Text>
            <View
              style={[
                styles.card,
                {
                  backgroundColor: colors.bgSurfaceAlt,
                  borderColor: colors.borderSubtle,
                  borderRadius: radius.card,
                  padding: spacing.lg,
                },
              ]}
            >
              <Text variant="title" selectable>
                {buyCredit.data.bank_transfer.account_number}
              </Text>
              <Text variant="body" color="secondary">
                {buyCredit.data.bank_transfer.bank_name ?? 'Flutterwave'}
              </Text>
            </View>
            <Text variant="caption" color="secondary">
              Tap and hold the account number to copy it.
            </Text>
            <Text variant="caption" color="secondary">
              Credits land automatically once the transfer is confirmed — this screen updates
              itself, no need to back out and check.
            </Text>
          </View>
        )}
      </Screen>
    </Modal>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1 },
  input: { borderWidth: 1, paddingHorizontal: 16, paddingVertical: 14, fontSize: 16 },
});
