import { Ionicons } from '@expo/vector-icons';
import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { useState } from 'react';
import { Image, Modal, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { KeyboardAvoidingScreen } from '@/components/ui/KeyboardAvoidingScreen';
import { Text } from '@/components/ui/Text';
import { withAppLockSuppressed } from '@/lib/appLock';
import { useCreateStatusUploadUrl, uploadStatusMedia, usePostStatus } from '@/lib/queries/status';
import { DEFAULT_STATUS_TEXT_TEMPLATE, STATUS_TEXT_TEMPLATES } from '@/lib/statusTextTemplates';
import { useTheme } from '@/theme';

type ComposerStep = 'choose' | 'photoPreview' | 'text';

/**
 * Full-screen status composer (docs/10-UX-REFINEMENT-BACKLOG.md Batch F
 * item 2 — "full-screen, camera-first ... with a small set of clean
 * background/text-style templates for text-only posts"). "Camera-first"
 * here means the camera option leads visually and is the first action
 * offered on the choice step, not that a live camera preview is built from
 * scratch — `ImagePicker.launchCameraAsync` already presents a full-screen
 * native camera UI, which is lighter-weight than adding `expo-camera` on
 * top of `expo-image-picker` just to reimplement what the OS already
 * provides (CLAUDE.md's "stay lite" rule).
 *
 * Client-side compression via the deprecated-but-still-functional
 * `manipulateAsync` (expo-image-manipulator's new context/`renderAsync`
 * API needs more ceremony for what's a single one-shot resize+compress
 * here — deliberate, not an oversight; revisit if a future edit needs the
 * new API's chaining).
 *
 * Both `expo-image-picker` and `expo-image-manipulator` are new native
 * modules — this composer ships JS/config-only, same as Batch C1/E1/this
 * batch's own media-viewing side: nothing here actually works on-device
 * until the held `eas build` runs (see docs/00-SESSION-HANDOFF.md).
 */
export function StatusComposer({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { colors, spacing, radius } = useTheme();
  const [step, setStep] = useState<ComposerStep>('choose');
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [caption, setCaption] = useState('');
  const [template, setTemplate] = useState(DEFAULT_STATUS_TEXT_TEMPLATE);
  const [error, setError] = useState<string | null>(null);
  const [isPosting, setIsPosting] = useState(false);

  const createUploadUrl = useCreateStatusUploadUrl();
  const postStatus = usePostStatus();

  const reset = () => {
    setStep('choose');
    setPhotoUri(null);
    setCaption('');
    setTemplate(DEFAULT_STATUS_TEXT_TEMPLATE);
    setError(null);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const pickPhoto = async (source: 'camera' | 'library') => {
    setError(null);
    const launch =
      source === 'camera' ? ImagePicker.launchCameraAsync : ImagePicker.launchImageLibraryAsync;
    // The native camera/gallery UI is a separate Activity on Android (and
    // can transiently background this app on iOS too) — without this
    // bracket, returning from it used to trip useAppLock's re-lock check,
    // which unmounted the navigator and dropped the user straight back to
    // the chat list mid-post (see lib/appLock.ts's header comment).
    const result = await withAppLockSuppressed(() =>
      launch({ mediaTypes: 'images', quality: 0.8 }),
    );
    if (result.canceled || !result.assets?.[0]) return;

    // Resize to a max 1080px longest edge + re-encode as compressed JPEG —
    // docs/01-ARCHITECTURE.md §5's "stay lite" media budgets, tuned for
    // status specifically (no existing status-specific dimension was
    // documented to match instead).
    const manipulated = await ImageManipulator.manipulateAsync(
      result.assets[0].uri,
      [{ resize: { width: 1080 } }],
      { compress: 0.7, format: ImageManipulator.SaveFormat.JPEG },
    );
    setPhotoUri(manipulated.uri);
    setStep('photoPreview');
  };

  const handlePostPhoto = async () => {
    if (!photoUri) return;
    setError(null);
    setIsPosting(true);
    try {
      const { path, token } = await createUploadUrl.mutateAsync();
      await uploadStatusMedia(photoUri, path, token);
      await postStatus.mutateAsync({ mediaPath: path, caption: caption.trim() || undefined });
      handleClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setIsPosting(false);
    }
  };

  const handlePostText = async () => {
    if (!caption.trim()) return;
    setError(null);
    setIsPosting(true);
    try {
      await postStatus.mutateAsync({ caption: caption.trim(), textStyle: template.key });
      handleClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setIsPosting(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={handleClose}>
      <KeyboardAvoidingScreen
        isModal
        style={[styles.flex, { backgroundColor: step === 'text' ? template.background : '#000' }]}
      >
        <View style={[styles.closeRow, { paddingHorizontal: spacing.lg }]}>
          <Pressable onPress={handleClose} hitSlop={12}>
            <Ionicons
              name="close"
              size={28}
              color={step === 'text' ? template.foreground : '#fff'}
            />
          </Pressable>
        </View>

        {step === 'choose' ? (
          <View style={[styles.flex, styles.centered, { gap: spacing.lg, padding: spacing.lg }]}>
            <Pressable
              onPress={() => pickPhoto('camera')}
              style={[
                styles.bigOption,
                { backgroundColor: colors.brandPrimary, borderRadius: radius.card },
              ]}
            >
              <Ionicons name="camera" size={32} color={colors.textInverse} />
              <Text variant="bodyMedium" color="inverse" style={{ marginTop: spacing.sm }}>
                Take Photo
              </Text>
            </Pressable>

            <Pressable
              onPress={() => pickPhoto('library')}
              style={[styles.bigOption, { backgroundColor: '#333', borderRadius: radius.card }]}
            >
              <Ionicons name="images" size={28} color="#fff" />
              <Text variant="bodyMedium" color="inverse" style={{ marginTop: spacing.sm }}>
                Choose from Gallery
              </Text>
            </Pressable>

            <Pressable
              onPress={() => setStep('text')}
              hitSlop={8}
              style={{ marginTop: spacing.md }}
            >
              <Text variant="body" color="inverse" style={{ textDecorationLine: 'underline' }}>
                Aa Write a text status
              </Text>
            </Pressable>

            {error ? (
              <Text variant="caption" color="danger">
                {error}
              </Text>
            ) : null}
          </View>
        ) : null}

        {step === 'photoPreview' && photoUri ? (
          <View style={styles.flex}>
            <Image source={{ uri: photoUri }} style={styles.previewImage} resizeMode="contain" />
            <View style={[styles.captionBar, { padding: spacing.lg, gap: spacing.sm }]}>
              <TextInput
                value={caption}
                onChangeText={setCaption}
                placeholder="Add a caption…"
                placeholderTextColor="#ccc"
                style={[styles.captionInput, { borderRadius: radius.card }]}
              />
              {error ? (
                <Text variant="caption" color="danger">
                  {error}
                </Text>
              ) : null}
              <Button
                label={isPosting ? 'Posting…' : 'Post status'}
                onPress={handlePostPhoto}
                disabled={isPosting}
              />
            </View>
          </View>
        ) : null}

        {step === 'text' ? (
          <View style={[styles.flex, styles.centered, { padding: spacing.lg, gap: spacing.lg }]}>
            <TextInput
              value={caption}
              onChangeText={setCaption}
              placeholder="What's on your mind?"
              placeholderTextColor={template.foreground + '99'}
              multiline
              autoFocus
              style={[styles.textStatusInput, { color: template.foreground }]}
            />

            <View style={styles.paletteRow}>
              {STATUS_TEXT_TEMPLATES.map((t) => (
                <Pressable
                  key={t.key}
                  onPress={() => setTemplate(t)}
                  style={[
                    styles.paletteSwatch,
                    { backgroundColor: t.background },
                    t.key === template.key ? styles.paletteSwatchSelected : null,
                  ]}
                  accessibilityLabel={t.label}
                />
              ))}
            </View>

            {error ? (
              <Text variant="caption" color="danger">
                {error}
              </Text>
            ) : null}

            <Button
              label={isPosting ? 'Posting…' : 'Post status'}
              onPress={handlePostText}
              disabled={isPosting || !caption.trim()}
            />
          </View>
        ) : null}
      </KeyboardAvoidingScreen>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  centered: { alignItems: 'center', justifyContent: 'center' },
  closeRow: { paddingTop: 12, alignItems: 'flex-end' },
  bigOption: {
    width: 220,
    paddingVertical: 24,
    alignItems: 'center',
  },
  previewImage: { flex: 1, backgroundColor: '#000' },
  captionBar: { backgroundColor: 'rgba(0,0,0,0.6)' },
  captionInput: {
    backgroundColor: 'rgba(255,255,255,0.15)',
    color: '#fff',
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 16,
  },
  textStatusInput: {
    fontSize: 28,
    fontWeight: '600',
    textAlign: 'center',
    minHeight: 120,
  },
  paletteRow: { flexDirection: 'row', gap: 12 },
  paletteSwatch: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  paletteSwatchSelected: { borderColor: '#fff' },
});
