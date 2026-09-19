import { Ionicons } from '@expo/vector-icons';
import { Image, Modal, Pressable, StyleSheet, View } from 'react-native';

import { useTheme } from '@/theme';

/**
 * Full-screen avatar viewer (punch-list item 3, 2026-09-19) — tapping a
 * contact's avatar on their profile screen pops it up full screen, same
 * WhatsApp/Telegram-standard "tap a contact's photo to see it clearly"
 * pattern. Deliberately scoped to *other people's* profile screens
 * (`profile/[id].tsx`), not the owner's own editable profile
 * (`settings/profile.tsx`) — there, tapping the avatar already opens the
 * photo picker to *change* it, and that's the more useful action on a
 * screen whose whole purpose is editing, not viewing; WhatsApp's own
 * "Edit profile photo" screen has the same asymmetry.
 */
export function FullScreenAvatar({
  visible,
  uri,
  onClose,
}: {
  visible: boolean;
  uri: string | null | undefined;
  onClose: () => void;
}) {
  const { colors } = useTheme();

  if (!uri) return null;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Image source={{ uri }} style={styles.image} resizeMode="contain" />
        <View style={styles.closeButtonWrap}>
          <Pressable onPress={onClose} hitSlop={12}>
            <Ionicons name="close" size={30} color={colors.textInverse} />
          </Pressable>
        </View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.92)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  image: { width: '100%', height: '80%' },
  closeButtonWrap: { position: 'absolute', top: 56, right: 24 },
});
