import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import {
  FlatList,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';

import { AppHeader } from '@/components/ui/AppHeader';
import { Button } from '@/components/ui/Button';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';
import { useBanks, useLinkBankAccount, type Bank } from '@/lib/queries/banks';
import { useFindUserByPhone, type FoundUser } from '@/lib/queries/findUserByPhone';
import { useSession } from '@/lib/hooks/useSession';
import { useKycTier } from '@/lib/queries/kyc';
import { toE164NigerianPhone } from '@/lib/phone';
import {
  ledgerEntryLabel,
  useBuyCredit,
  useLedgerEntries,
  useLinkedBankAccount,
  useTopupStatus,
  useTransferCredit,
  useWallets,
  useWithdraw,
  walletBalance,
  type LedgerEntry,
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

function BuyCreditModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
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

/** Add-bank-account flow: pick a bank -> enter account number -> server
 * resolves the name, matches it against the KYC-verified identity, and
 * only then links it. See supabase/functions/link-bank-account's own
 * header comment — a name mismatch is a hard rejection, not something
 * this screen can override. */
function LinkBankAccountModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { colors, spacing, radius } = useTheme();
  const { data: banks, isLoading: banksLoading } = useBanks();
  const linkBankAccount = useLinkBankAccount();

  const [search, setSearch] = useState('');
  const [selectedBank, setSelectedBank] = useState<Bank | null>(null);
  const [accountNumber, setAccountNumber] = useState('');

  const reset = () => {
    setSearch('');
    setSelectedBank(null);
    setAccountNumber('');
    linkBankAccount.reset();
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleLink = () => {
    if (!selectedBank) return;
    linkBankAccount.mutate({
      bankCode: selectedBank.code,
      bankName: selectedBank.name,
      accountNumber,
    });
  };

  const filteredBanks = (banks ?? []).filter((b) =>
    b.name.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={handleClose}>
      <Screen>
        <View
          style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}
        >
          <Text variant="title">Add bank account</Text>
          <Pressable onPress={handleClose} hitSlop={12}>
            <Text variant="body" color="secondary">
              Close
            </Text>
          </Pressable>
        </View>

        {linkBankAccount.isSuccess ? (
          <View style={{ marginTop: spacing.xl, gap: spacing.sm }}>
            <Text variant="bodyMedium" color="success">
              Linked {linkBankAccount.data.bank_name} ····
              {linkBankAccount.data.account_number_last4}
            </Text>
            <Text variant="body" color="secondary">
              {linkBankAccount.data.account_name}
            </Text>
          </View>
        ) : !selectedBank ? (
          <View style={{ marginTop: spacing.xl, gap: spacing.sm, flex: 1 }}>
            <TextInput
              value={search}
              onChangeText={setSearch}
              placeholder="Search for your bank…"
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
            {banksLoading ? (
              <Text variant="body" color="secondary">
                Loading banks…
              </Text>
            ) : (
              <FlatList
                data={filteredBanks}
                keyExtractor={(b) => b.code}
                renderItem={({ item }) => (
                  <Pressable
                    onPress={() => setSelectedBank(item)}
                    style={{ paddingVertical: spacing.md }}
                  >
                    <Text variant="body">{item.name}</Text>
                  </Pressable>
                )}
              />
            )}
          </View>
        ) : (
          <View style={{ marginTop: spacing.xl, gap: spacing.sm }}>
            <Text variant="bodyMedium">{selectedBank.name}</Text>
            <Pressable onPress={() => setSelectedBank(null)}>
              <Text variant="caption" color="secondary">
                Change bank
              </Text>
            </Pressable>
            <TextInput
              value={accountNumber}
              onChangeText={setAccountNumber}
              placeholder="Account number"
              placeholderTextColor={colors.textSecondary}
              keyboardType="number-pad"
              maxLength={10}
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
            {linkBankAccount.isError ? (
              <Text variant="caption" color="danger">
                {linkBankAccount.error.message}
              </Text>
            ) : null}
            <Button
              label={linkBankAccount.isPending ? 'Linking…' : 'Link account'}
              onPress={handleLink}
              disabled={linkBankAccount.isPending || accountNumber.length !== 10}
            />
          </View>
        )}
      </Screen>
    </Modal>
  );
}

/** Send chat credit to another user by phone number — same lookup flow as
 * chats.tsx's NewChatModal (find by phone, then act). See
 * lib/queries/wallet.ts's useTransferCredit comment for the compliance
 * context: this is convertible to cash on the recipient's side, which is
 * why it shipped ahead of (not instead of) the legal review
 * docs/07-COMPLIANCE-LEGAL.md §1 calls for on this exact pattern. */
function TransferCreditModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { colors, spacing, radius } = useTheme();
  const findUser = useFindUserByPhone();
  const transferCredit = useTransferCredit();

  const [phone, setPhone] = useState('');
  const [found, setFound] = useState<FoundUser | null>(null);
  const [credits, setCredits] = useState('');

  const reset = () => {
    setPhone('');
    setFound(null);
    setCredits('');
    findUser.reset();
    transferCredit.reset();
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleLookup = () => {
    findUser.mutate(toE164NigerianPhone(phone), {
      onSuccess: (user) => setFound(user),
    });
  };

  const handleSend = () => {
    if (!found) return;
    const parsed = Number(credits);
    if (!Number.isInteger(parsed) || parsed <= 0) return;
    transferCredit.mutate({ recipientPhone: toE164NigerianPhone(phone), credits: parsed });
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={handleClose}>
      <Screen>
        <View
          style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}
        >
          <Text variant="title">Send credit</Text>
          <Pressable onPress={handleClose} hitSlop={12}>
            <Text variant="body" color="secondary">
              Close
            </Text>
          </Pressable>
        </View>

        {transferCredit.isSuccess ? (
          <View style={{ marginTop: spacing.xl, gap: spacing.sm }}>
            <Text variant="bodyMedium" color="success">
              Sent {transferCredit.data.credits_sent} credits to{' '}
              {found?.display_name ?? 'this user'}.
            </Text>
            <Text variant="caption" color="secondary">
              They will receive {transferCredit.data.credits_received} as withdrawable cash after
              the platform&apos;s cut.
            </Text>
          </View>
        ) : (
          <View style={{ gap: spacing.md, marginTop: spacing.xl }}>
            <Text variant="caption" color="secondary">
              Their phone number
            </Text>
            <TextInput
              value={phone}
              onChangeText={setPhone}
              placeholder="0801 234 5678"
              placeholderTextColor={colors.textSecondary}
              keyboardType="phone-pad"
              editable={!found}
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

            {findUser.isError ? (
              <Text variant="caption" color="danger">
                {findUser.error.message}
              </Text>
            ) : null}

            {!found ? (
              <Button
                label={findUser.isPending ? 'Looking up…' : 'Find'}
                onPress={handleLookup}
                disabled={findUser.isPending || phone.length < 8}
              />
            ) : (
              <>
                <Text variant="bodyMedium" color="success">
                  Sending to {found.display_name ?? 'this user'}
                </Text>
                <Text variant="caption" color="secondary">
                  How many credits?
                </Text>
                <TextInput
                  value={credits}
                  onChangeText={setCredits}
                  placeholder="e.g. 50"
                  placeholderTextColor={colors.textSecondary}
                  keyboardType="number-pad"
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
                {transferCredit.isError ? (
                  <Text variant="caption" color="danger">
                    {transferCredit.error.message}
                  </Text>
                ) : null}
                <Button
                  label={transferCredit.isPending ? 'Sending…' : 'Send credit'}
                  onPress={handleSend}
                  disabled={transferCredit.isPending || !Number(credits)}
                />
              </>
            )}
          </View>
        )}
      </Screen>
    </Modal>
  );
}

/** Same "same-day time, else short date" convention chats.tsx's
 * ThreadRow uses — kept local rather than shared, matching that file's
 * own precedent for a screen-specific formatter this small. */
function formatEntryTimestamp(iso: string) {
  const date = new Date(iso);
  const now = new Date();
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  return isToday
    ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** `withdrawable_cash` is stored in kobo, the other two wallets in whole
 * credits — the unit shown depends entirely on which wallet the row
 * landed on, never guessed from the reason string. Converting to ₦ only
 * at this presentation layer, per CLAUDE.md rule #2. */
function formatEntryAmount(entry: LedgerEntry): string {
  const sign = entry.amount > 0 ? '+' : entry.amount < 0 ? '-' : '';
  const magnitude = Math.abs(entry.amount);
  return entry.wallet_kind === 'withdrawable_cash'
    ? `${sign}₦${(magnitude / 100).toLocaleString()}`
    : `${sign}${magnitude.toLocaleString()} cr`;
}

function TransactionRow({ entry }: { entry: LedgerEntry }) {
  const { colors, spacing } = useTheme();
  return (
    <View
      style={[
        styles.transactionRow,
        { paddingVertical: spacing.sm, borderBottomColor: colors.borderSubtle },
      ]}
    >
      <View style={{ flex: 1 }}>
        <Text variant="bodyMedium">{ledgerEntryLabel(entry.reason)}</Text>
        <Text variant="caption" color="tertiary">
          {formatEntryTimestamp(entry.created_at)}
        </Text>
      </View>
      <Text variant="bodyMedium" color={entry.amount >= 0 ? 'success' : 'primary'}>
        {formatEntryAmount(entry)}
      </Text>
    </View>
  );
}

/** Phase 6 (docs/08-BUILD-PHASES-ROADMAP.md): "full transaction history
 * rendered from ledger_entries, user-facing labels mapped from reason."
 * Plain mapped Views inside the screen's existing ScrollView, not a
 * nested FlatList — consistent with BalanceCard etc. above, and fine at
 * the 50-row cap useLedgerEntries defaults to. */
function TransactionHistory({ userId }: { userId: string | undefined }) {
  const { spacing } = useTheme();
  const { data: entries, isLoading } = useLedgerEntries(userId);

  return (
    <View style={{ marginTop: spacing.xl }}>
      <Text variant="title">Transaction history</Text>
      <View style={{ marginTop: spacing.sm }}>
        {isLoading ? (
          <Text variant="body" color="tertiary">
            Loading…
          </Text>
        ) : !entries?.length ? (
          <Text variant="body" color="tertiary">
            No activity yet.
          </Text>
        ) : (
          entries.map((entry) => <TransactionRow key={entry.id} entry={entry} />)
        )}
      </View>
    </View>
  );
}

export default function WalletScreen() {
  const { spacing } = useTheme();
  const router = useRouter();
  const { session } = useSession();
  const userId = session?.user.id;
  const queryClient = useQueryClient();

  const { data: wallets, isLoading, refetch: refetchWallets, isRefetching } = useWallets(userId);
  const { data: bankAccount, refetch: refetchBankAccount } = useLinkedBankAccount(userId);
  const { data: kycTier, refetch: refetchKycTier } = useKycTier(userId);

  const [buyModalVisible, setBuyModalVisible] = useState(false);
  const [withdrawModalVisible, setWithdrawModalVisible] = useState(false);
  const [linkBankModalVisible, setLinkBankModalVisible] = useState(false);
  const [transferModalVisible, setTransferModalVisible] = useState(false);

  const topupCredit = walletBalance(wallets, 'topup_credit');
  const earningsPending = walletBalance(wallets, 'earnings_pending');
  const withdrawableCash = walletBalance(wallets, 'withdrawable_cash');

  const handleRefresh = () => {
    void refetchWallets();
    void refetchBankAccount();
    void refetchKycTier();
    void queryClient.invalidateQueries({ queryKey: ['ledgerEntries', userId] });
  };

  return (
    <Screen>
      {/* Fixed, non-scrolling — a real bug this fixes: the title used to be
          the ScrollView's first child, so it scrolled away with the rest of
          the content instead of staying put like a header should (see
          docs/00-SESSION-HANDOFF.md's header/nav overhaul section). */}
      <AppHeader title="Wallet" />
      <ScrollView
        style={{ flex: 1 }}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={handleRefresh} />}
      >
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

        <View style={{ marginTop: spacing.md }}>
          <Button
            label="Send credit to someone"
            variant="secondary"
            onPress={() => setTransferModalVisible(true)}
            disabled={topupCredit <= 0}
          />
        </View>

        {!bankAccount ? (
          <View style={{ marginTop: spacing.sm, gap: spacing.sm }}>
            <Text variant="caption" color="secondary">
              No verified bank account linked yet — withdrawals are not available until that is set
              up.
            </Text>
            {(kycTier ?? 0) >= 1 ? (
              <Button
                label="Add bank account"
                variant="secondary"
                onPress={() => setLinkBankModalVisible(true)}
              />
            ) : (
              <Pressable onPress={() => router.push('/settings')}>
                <Text variant="caption" color="secondary">
                  Verify your identity first →
                </Text>
              </Pressable>
            )}
          </View>
        ) : null}

        <TransactionHistory userId={userId} />
      </ScrollView>

      <BuyCreditModal visible={buyModalVisible} onClose={() => setBuyModalVisible(false)} />
      <TransferCreditModal
        visible={transferModalVisible}
        onClose={() => setTransferModalVisible(false)}
      />
      {bankAccount ? (
        <WithdrawModal
          visible={withdrawModalVisible}
          onClose={() => setWithdrawModalVisible(false)}
          bankAccountId={bankAccount.id}
          availableKobo={withdrawableCash}
        />
      ) : (
        <LinkBankAccountModal
          visible={linkBankModalVisible}
          onClose={() => setLinkBankModalVisible(false)}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1 },
  input: { borderWidth: 1, paddingHorizontal: 16, paddingVertical: 14, fontSize: 16 },
  transactionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottomWidth: 1,
  },
});
