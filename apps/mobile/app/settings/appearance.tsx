import { Stack } from 'expo-router';
import { Pressable, View } from 'react-native';

import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';
import { useTheme, type ThemePreference } from '@/theme';

const THEME_PREFERENCE_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

export default function AppearanceSettingsScreen() {
  const { colors, spacing, preference, setPreference } = useTheme();
  return (
    <>
      <Stack.Screen
        options={{
          headerShown: true,
          title: 'Appearance',
          headerStyle: { backgroundColor: colors.bgCanvas },
          headerTintColor: colors.textSecondary,
          headerTitleStyle: { color: colors.textPrimary },
        }}
      />
      <Screen>
        <View style={{ gap: spacing.xs }}>
          {THEME_PREFERENCE_OPTIONS.map((option) => (
            <Pressable
              key={option.value}
              onPress={() => setPreference(option.value)}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: spacing.sm,
                paddingVertical: spacing.md,
              }}
            >
              <Text color={preference === option.value ? 'secondary' : 'tertiary'}>
                {preference === option.value ? '●' : '○'}
              </Text>
              <Text variant="body">{option.label}</Text>
            </Pressable>
          ))}
        </View>
      </Screen>
    </>
  );
}
