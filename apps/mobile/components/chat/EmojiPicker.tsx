import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState } from 'react';
import { FlatList, Pressable, View } from 'react-native';

import { Text } from '@/components/ui/Text';
import {
  EMOJI_CATEGORIES,
  MAX_RECENT_EMOJI,
  RECENT_EMOJI_STORAGE_KEY,
  type EmojiCategory,
} from '@/lib/emojiData';
import { useTheme } from '@/theme';

// Fixed height rather than measuring the real keyboard — this app has no
// device to measure against in this sandbox (a standing gap flagged
// elsewhere), and every reference chat app's own emoji drawer is a fixed
// height close to a typical keyboard's, not a per-device dynamic
// measurement either. 280 lands close to a typical soft-keyboard height
// at this app's own 160dp/in baseline (theme/tokens.ts).
const PANEL_HEIGHT = 280;
const COLUMNS = 8;

async function loadRecentEmoji(): Promise<string[]> {
  const raw = await AsyncStorage.getItem(RECENT_EMOJI_STORAGE_KEY);
  return raw ? (JSON.parse(raw) as string[]) : [];
}

async function pushRecentEmoji(emoji: string): Promise<string[]> {
  const current = await loadRecentEmoji();
  const next = [emoji, ...current.filter((e) => e !== emoji)].slice(0, MAX_RECENT_EMOJI);
  await AsyncStorage.setItem(RECENT_EMOJI_STORAGE_KEY, JSON.stringify(next));
  return next;
}

/**
 * WhatsApp-style in-line emoji picker (punch-list item 3, 2026-09-19) —
 * plain Unicode emoji rendered via the system's own emoji font (no image
 * assets, no new dependency), a category tab strip, a "Recently used"
 * category (AsyncStorage-backed, same lightweight-local-state pattern
 * `components/ErrorBoundary.tsx`'s crash record already uses in this
 * app), and a backspace key. Deliberately NOT a `Modal` — this renders
 * in-line, swapped in for the native keyboard by the composer that owns
 * it (see thread/[id].tsx), matching how every reference chat app's own
 * emoji drawer behaves: it occupies the same screen region the keyboard
 * would, rather than floating on top of it.
 *
 * Real custom stickers (image-based) are a separate, later feature —
 * scoped out here per the user's own explicit 2026-09-19 choice, not an
 * oversight.
 */
export function EmojiPicker({
  onSelectEmoji,
  onBackspace,
}: {
  onSelectEmoji: (emoji: string) => void;
  onBackspace: () => void;
}) {
  const { colors, spacing } = useTheme();
  const [recent, setRecent] = useState<string[]>([]);
  const [activeCategoryKey, setActiveCategoryKey] = useState(EMOJI_CATEGORIES[0].key);

  useEffect(() => {
    let cancelled = false;
    loadRecentEmoji().then((r) => {
      if (!cancelled) setRecent(r);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const categories: EmojiCategory[] = recent.length
    ? [{ key: 'recent', label: 'Recent', icon: '🕓', emojis: recent }, ...EMOJI_CATEGORIES]
    : EMOJI_CATEGORIES;

  const activeCategory = categories.find((c) => c.key === activeCategoryKey) ?? categories[0];

  const handleSelect = (emoji: string) => {
    onSelectEmoji(emoji);
    pushRecentEmoji(emoji).then(setRecent);
  };

  return (
    <View style={{ height: PANEL_HEIGHT, backgroundColor: colors.bgSurface }}>
      <FlatList
        key={activeCategory.key}
        data={activeCategory.emojis}
        numColumns={COLUMNS}
        keyExtractor={(emoji, index) => `${emoji}-${index}`}
        contentContainerStyle={{ paddingHorizontal: spacing.sm, paddingTop: spacing.sm }}
        renderItem={({ item }) => (
          <Pressable
            onPress={() => handleSelect(item)}
            style={{
              flex: 1 / COLUMNS,
              aspectRatio: 1,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Text style={{ fontSize: 26 }}>{item}</Text>
          </Pressable>
        )}
      />

      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          borderTopWidth: 1,
          borderTopColor: colors.borderSubtle,
          paddingHorizontal: spacing.sm,
        }}
      >
        <FlatList
          data={categories}
          horizontal
          showsHorizontalScrollIndicator={false}
          keyExtractor={(c) => c.key}
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingVertical: spacing.xs }}
          renderItem={({ item }) => (
            <Pressable
              onPress={() => setActiveCategoryKey(item.key)}
              accessibilityLabel={item.label}
              style={{
                width: 40,
                height: 40,
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 20,
                backgroundColor:
                  item.key === activeCategory.key ? colors.bgSurfaceAlt : 'transparent',
              }}
            >
              <Text style={{ fontSize: 18 }}>{item.icon}</Text>
            </Pressable>
          )}
        />
        <Pressable
          onPress={onBackspace}
          hitSlop={8}
          style={{ width: 40, height: 40, alignItems: 'center', justifyContent: 'center' }}
        >
          <Ionicons name="backspace-outline" size={22} color={colors.textSecondary} />
        </Pressable>
      </View>
    </View>
  );
}
