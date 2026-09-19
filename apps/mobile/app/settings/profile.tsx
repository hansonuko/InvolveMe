import { Ionicons } from '@expo/vector-icons';
import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { Stack, useRouter } from 'expo-router';
import { useState } from 'react';
import { Image, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { KeyboardAvoidingScreen } from '@/components/ui/KeyboardAvoidingScreen';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';
import { withAppLockSuppressed } from '@/lib/appLock';
import { useSession } from '@/lib/hooks/useSession';
import { useCreateProfileUploadUrl, uploadProfileMedia } from '@/lib/queries/profileMedia';
import { type ProfileLink, useProfile, useUpdateProfile } from '@/lib/queries/profile';
import { useTheme } from '@/theme';

const COVER_HEIGHT = 140;
const AVATAR_SIZE = 96;
const MAX_LINKS = 5;

/** Resize + JPEG-compress before upload, same budget/tooling
 * StatusComposer's pickPhoto already establishes (expo-image-manipulator,
 * max 1080px longest edge) — no reason a profile photo needs a different
 * pipeline than a status one. */
async function pickAndPrepareImage(source: 'camera' | 'library'): Promise<string | null> {
  const launch =
    source === 'camera' ? ImagePicker.launchCameraAsync : ImagePicker.launchImageLibraryAsync;
  // Bracketed for the same reason StatusComposer's own picker call is —
  // the native camera/gallery UI can background this app, which would
  // otherwise trip useAppLock's re-lock check (see lib/appLock.ts).
  const result = await withAppLockSuppressed(() => launch({ mediaTypes: 'images', quality: 0.8 }));
  if (result.canceled || !result.assets?.[0]) return null;

  const manipulated = await ImageManipulator.manipulateAsync(
    result.assets[0].uri,
    [{ resize: { width: 1080 } }],
    { compress: 0.7, format: ImageManipulator.SaveFormat.JPEG },
  );
  return manipulated.uri;
}

function LinkRow({
  link,
  onChangeLabel,
  onChangeUrl,
  onRemove,
}: {
  link: ProfileLink;
  onChangeLabel: (v: string) => void;
  onChangeUrl: (v: string) => void;
  onRemove: () => void;
}) {
  const { colors, spacing, radius } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
      <View style={{ flex: 1, gap: spacing.xs }}>
        <TextInput
          value={link.label}
          onChangeText={onChangeLabel}
          placeholder="Label (e.g. Website)"
          placeholderTextColor={colors.textTertiary}
          maxLength={30}
          style={[
            styles.linkInput,
            {
              backgroundColor: colors.bgSurfaceAlt,
              color: colors.textPrimary,
              borderRadius: radius.card,
              borderColor: colors.borderSubtle,
            },
          ]}
        />
        <TextInput
          value={link.url}
          onChangeText={onChangeUrl}
          placeholder="https://…"
          placeholderTextColor={colors.textTertiary}
          autoCapitalize="none"
          keyboardType="url"
          maxLength={200}
          style={[
            styles.linkInput,
            {
              backgroundColor: colors.bgSurfaceAlt,
              color: colors.textPrimary,
              borderRadius: radius.card,
              borderColor: colors.borderSubtle,
            },
          ]}
        />
      </View>
      <Pressable onPress={onRemove} hitSlop={8} style={{ padding: spacing.xs }}>
        <Ionicons name="close-circle" size={22} color={colors.textTertiary} />
      </Pressable>
    </View>
  );
}

/** Full profile editor — punch-list item 2: avatar + cover photo upload,
 * name, About, and up to 5 links. Reached by tapping the profile
 * preview row at the top of the Settings hub. */
export default function ProfileSettingsScreen() {
  const { colors, spacing, radius } = useTheme();
  const router = useRouter();
  const { session } = useSession();
  const userId = session?.user.id;

  const { data: profile, isLoading } = useProfile(userId);
  const updateProfile = useUpdateProfile();
  const createUploadUrl = useCreateProfileUploadUrl();

  const [name, setName] = useState(profile?.display_name ?? '');
  const [about, setAbout] = useState(profile?.status_text ?? '');
  const [links, setLinks] = useState<ProfileLink[]>(profile?.links ?? []);
  const [avatarUrl, setAvatarUrl] = useState(profile?.avatar_url ?? null);
  const [coverUrl, setCoverUrl] = useState(profile?.cover_url ?? null);
  const [hydrated, setHydrated] = useState(false);
  const [uploadingKind, setUploadingKind] = useState<'avatar' | 'cover' | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Hydrate local editable state once the real profile arrives, not on
  // every render — same "seed from server data once" shape
  // EditProfileModal's own original version already used, just no longer
  // gated behind a modal's `visible` prop toggling.
  if (profile && !hydrated) {
    setName(profile.display_name ?? '');
    setAbout(profile.status_text ?? '');
    setLinks(profile.links);
    setAvatarUrl(profile.avatar_url);
    setCoverUrl(profile.cover_url);
    setHydrated(true);
  }

  const handlePickPhoto = async (kind: 'avatar' | 'cover') => {
    if (!userId) return;
    setError(null);
    setUploadingKind(kind);
    try {
      const localUri = await pickAndPrepareImage('library');
      if (!localUri) return;

      const { path, token, public_url } = await createUploadUrl.mutateAsync(kind);
      await uploadProfileMedia(localUri, path, token);

      if (kind === 'avatar') setAvatarUrl(public_url);
      else setCoverUrl(public_url);

      await updateProfile.mutateAsync({
        userId,
        ...(kind === 'avatar' ? { avatarUrl: public_url } : { coverUrl: public_url }),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setUploadingKind(null);
    }
  };

  const handleAddLink = () => {
    if (links.length >= MAX_LINKS) return;
    setLinks((prev) => [...prev, { label: '', url: '' }]);
  };

  const handleSave = () => {
    if (!userId) return;
    setError(null);
    const cleanedLinks = links
      .map((l) => ({ label: l.label.trim(), url: l.url.trim() }))
      .filter((l) => l.label.length > 0 && l.url.length > 0);

    updateProfile.mutate(
      { userId, displayName: name.trim(), statusText: about.trim(), links: cleanedLinks },
      {
        onSuccess: () => router.back(),
        onError: (e) => setError(e.message),
      },
    );
  };

  return (
    <>
      <Stack.Screen
        options={{
          headerShown: true,
          title: 'Profile',
          headerStyle: { backgroundColor: colors.bgCanvas },
          headerTintColor: colors.textSecondary,
          headerTitleStyle: { color: colors.textPrimary },
        }}
      />
      <Screen style={{ paddingHorizontal: 0 }}>
        {isLoading ? (
          <Text variant="body" color="secondary" style={{ paddingHorizontal: spacing.lg }}>
            Loading…
          </Text>
        ) : (
          <KeyboardAvoidingScreen>
            <View style={{ flex: 1 }}>
              <Pressable onPress={() => handlePickPhoto('cover')} disabled={uploadingKind !== null}>
                <View style={[styles.cover, { backgroundColor: colors.bgSurfaceAlt }]}>
                  {coverUrl ? (
                    <Image source={{ uri: coverUrl }} style={StyleSheet.absoluteFill} />
                  ) : null}
                  <View style={styles.coverEditBadge}>
                    <Ionicons name="camera" size={16} color="#fff" />
                    <Text variant="caption" color="inverse" style={{ marginLeft: 4 }}>
                      {uploadingKind === 'cover' ? 'Uploading…' : 'Edit cover'}
                    </Text>
                  </View>
                </View>
              </Pressable>

              <View style={{ alignItems: 'center', marginTop: -AVATAR_SIZE / 2 }}>
                <Pressable
                  onPress={() => handlePickPhoto('avatar')}
                  disabled={uploadingKind !== null}
                >
                  <View
                    style={[
                      styles.avatarWrap,
                      { borderColor: colors.bgCanvas, backgroundColor: colors.bgCanvas },
                    ]}
                  >
                    <Avatar uri={avatarUrl} displayName={name} size={AVATAR_SIZE} />
                    <View
                      style={[styles.avatarEditBadge, { backgroundColor: colors.brandPrimary }]}
                    >
                      <Ionicons name="camera" size={14} color="#fff" />
                    </View>
                  </View>
                </Pressable>
                {uploadingKind === 'avatar' ? (
                  <Text variant="caption" color="secondary" style={{ marginTop: spacing.xs }}>
                    Uploading…
                  </Text>
                ) : null}
              </View>

              <View
                style={{ paddingHorizontal: spacing.lg, marginTop: spacing.lg, gap: spacing.md }}
              >
                <Text variant="caption" color="tertiary">
                  Name
                </Text>
                <TextInput
                  value={name}
                  onChangeText={setName}
                  placeholder="Your name"
                  placeholderTextColor={colors.textTertiary}
                  maxLength={60}
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

                <Text variant="caption" color="tertiary">
                  About
                </Text>
                <TextInput
                  value={about}
                  onChangeText={setAbout}
                  placeholder="Hey there! I'm using InvolveMe"
                  placeholderTextColor={colors.textTertiary}
                  maxLength={120}
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

                <View
                  style={{
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                >
                  <Text variant="caption" color="tertiary">
                    Links
                  </Text>
                  {links.length < MAX_LINKS ? (
                    <Pressable onPress={handleAddLink} hitSlop={8}>
                      <Text variant="caption" color="secondary">
                        + Add link
                      </Text>
                    </Pressable>
                  ) : null}
                </View>
                {links.map((link, index) => (
                  <LinkRow
                    key={index}
                    link={link}
                    onChangeLabel={(v) =>
                      setLinks((prev) => prev.map((l, i) => (i === index ? { ...l, label: v } : l)))
                    }
                    onChangeUrl={(v) =>
                      setLinks((prev) => prev.map((l, i) => (i === index ? { ...l, url: v } : l)))
                    }
                    onRemove={() => setLinks((prev) => prev.filter((_, i) => i !== index))}
                  />
                ))}

                {error ? (
                  <Text variant="caption" color="danger">
                    {error}
                  </Text>
                ) : null}

                <Button
                  label={updateProfile.isPending ? 'Saving…' : 'Save'}
                  onPress={handleSave}
                  disabled={updateProfile.isPending || name.trim().length === 0}
                  style={{ marginTop: spacing.md, marginBottom: spacing.xl }}
                />
              </View>
            </View>
          </KeyboardAvoidingScreen>
        )}
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  cover: { height: COVER_HEIGHT, overflow: 'hidden', justifyContent: 'flex-end' },
  coverEditBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 4,
    margin: 8,
  },
  avatarWrap: { borderRadius: 999, borderWidth: 4, padding: 0 },
  avatarEditBadge: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#fff',
  },
  // fontSize matches typography.body (17) so these text inputs' actual
  // typed values read at the same size as the rest of the app's body text
  // — linkInput previously hardcoded a smaller 14, inconsistent with the
  // name/about input right above it (punch-list item 4, 2026-09-19).
  input: { borderWidth: 1, paddingHorizontal: 16, paddingVertical: 14, fontSize: 17 },
  linkInput: { borderWidth: 1, paddingHorizontal: 14, paddingVertical: 10, fontSize: 17 },
});
