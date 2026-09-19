import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';

import { withAppLockSuppressed } from '@/lib/appLock';

/** Resize + JPEG-compress before upload — shared by every photo-picking
 * flow in the app (profile avatar/cover, group avatar) so they all hit the
 * same budget/tooling (expo-image-manipulator, max 1080px longest edge,
 * 0.7 JPEG quality) rather than each screen inventing its own. Extracted
 * from settings/profile.tsx (punch-list item 2, 2026-09-19) when the group
 * avatar upload needed the exact same pipeline — genuinely identical
 * logic, not just similar, so worth sharing rather than duplicating. */
export async function pickAndPrepareImage(source: 'camera' | 'library'): Promise<string | null> {
  const launch =
    source === 'camera' ? ImagePicker.launchCameraAsync : ImagePicker.launchImageLibraryAsync;
  // Bracketed the same reason every other picker call in this app is — the
  // native camera/gallery UI can background the app on Android, which
  // would otherwise trip useAppLock's re-lock check (see lib/appLock.ts).
  const result = await withAppLockSuppressed(() => launch({ mediaTypes: 'images', quality: 0.8 }));
  if (result.canceled || !result.assets?.[0]) return null;

  const manipulated = await ImageManipulator.manipulateAsync(
    result.assets[0].uri,
    [{ resize: { width: 1080 } }],
    { compress: 0.7, format: ImageManipulator.SaveFormat.JPEG },
  );
  return manipulated.uri;
}
