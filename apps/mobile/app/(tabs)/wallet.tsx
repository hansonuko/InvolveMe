import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';
import { useSession } from '@/lib/hooks/useSession';
import {
  useBuyCredit,
  useLinkedBankAccount,
  useWallets,
  useWithdraw,
  walletBalance,
} from '@/lib/queries/wallet';
import { useTheme } from '@/theme';

function BalanceCard({ label, value, suffix }: { label: string; value: number; suffix: string }) {
  const { colors, spacing, radius } = useTheme();
  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: colors.bgSurface,
          borderColor: colors.borderSubtle,
          borderRadius: radius.card,
          padding: spacing.lg,
        },
      ]}
    >
      <Text variant="caption" color="secondary">
        {label}
      </Text>
      <Text variant="balance" style={{ marginTop: spacing.xs }}>
        {value.toLocaleString()} {suffix}
      </Text>
    </View>
  );
}

function BuyCreditModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { colors, spacing, radius } = useTheme();
  const buyCredit = useBuyCredit();
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

        {!buyCredit.data ? (
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
              <Text variant="title">{buyCredit.data.bank_transfer.account_number}</Text>
              <Text variant="body" color="secondary">
                {buyCredit.data.bank_transfer.bank_name ?? 'Flutterwave'}
              </Text>
            </View>
            <Text variant="caption" color="secondary">
              Credits land automatically once the transfer is confirmed — no need to come back and
              check.
            </Text>
          </View>
        )}
      </Screen>
    </Modal>
  );
}

function WithdrawModal({
  visible,
  onClose,
  bankAccountId,
  availableKobo,
}: {
  visible: boolean;
  onClose: () => void;
  bankAccountId: string;
  availableKobo: number;
}) {
  const withdraw = useWithdraw();

  const handleClose = () => {
    withdraw.reset();
    onClose();
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={handleClose}>
      <Screen>
        <View
          style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}
        >
          <Text variant="title">Withdraw</Text>
          <Pressable onPress={handleClose} hitSlop={12}>
            <Text variant="body" color="secondary">
              Close
            </Text>
          </Pressable>
        </View>

        <View style={{ marginTop: 24, gap: 12 }}>
          <Text variant="body" color="secondary">
            Withdraw your full available balance (₦{(availableKobo / 100).toLocaleString()}) to your
            linked bank account.
          </Text>
          {withdraw.isError ? (
            <Text variant="caption" color="danger">
              {withdraw.error.message}
            </Text>
          ) : null}
          {withdraw.data ? (
            <Text variant="bodyMedium" color="success">
              Withdrawal started — status: {withdraw.data.status}.
            </Text>
          ) : (
            <Button
              label={withdraw.isPending ? 'Requesting…' : 'Withdraw all'}
              onPress={() => withdraw.mutate({ bankAccountId })}
              disabled={withdraw.isPending || availableKobo <= 0}
            />
          )}
        </View>
      </Screen>
    </Modal>
  );
}

export default function WalletScreen() {
  const { spacing } = useTheme();
  const { session } = useSession();
  const userId = session?.user.id;

  const { data: wallets, isLoading } = useWallets(userId);
  const { data: bankAccount } = useLinkedBankAccount(userId);

  const [buyModalVisible, setBuyModalVisible] = useState(false);
  const [withdrawModalVisible, setWithdrawModalVisible] = useState(false);

  const topupCredit = walletBalance(wallets, 'topup_credit');
  const earningsPending = walletBalance(wallets, 'earnings_pending');
  const withdrawableCash = walletBalance(wallets, 'withdrawable_cash');

  return (
    <Screen>
      <ScrollView showsVerticalScrollIndicator={false}>
        <Text variant="display" style={{ marginBottom: spacing.lg }}>
          Wallet
        </Text>

        {isLoading ? (
          <Text variant="body" color="secondary">
            Loading…
          </Text>
        ) : (
          <View style={{ gap: spacing.md }}>
            <BalanceCard label="Chat credit" value={topupCredit} suffix="cr" />
            <BalanceCard label="Pending earnings" value={earningsPending} suffix="cr" />
            <BalanceCard label="Withdrawable" value={withdrawableCash / 100} suffix="₦" />
          </View>
        )}

        <View style={{ flexDirection: 'row', gap: spacing.md, marginTop: spacing.xl }}>
          <View style={{ flex: 1 }}>
            <Button label="Buy credit" onPress={() => setBuyModalVisible(true)} />
          </View>
          <View style={{ flex: 1 }}>
            <Button
              label="Withdraw"
              variant="secondary"
              onPress={() => setWithdrawModalVisible(true)}
              disabled={!bankAccount || withdrawableCash <= 0}
            />
          </View>
        </View>

        {!bankAccount ? (
          <Text variant="caption" color="secondary" style={{ marginTop: spacing.sm }}>
            No verified bank account linked yet — withdrawals are not available until that is set
            up.
          </Text>
        ) : null}
      </ScrollView>

      <BuyCreditModal visible={buyModalVisible} onClose={() => setBuyModalVisible(false)} />
      {bankAccount ? (
        <WithdrawModal
          visible={withdrawModalVisible}
          onClose={() => setWithdrawModalVisible(false)}
          bankAccountId={bankAccount.id}
          availableKobo={withdrawableCash}
        />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1 },
  input: { borderWidth: 1, paddingHorizontal: 16, paddingVertical: 14, fontSize: 16 },
});
