import { Stack } from 'expo-router';
import { ScrollView, View } from 'react-native';

import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';
import type { LegalSection } from '@involveme/legal-content';
import { useTheme } from '@/theme';

/**
 * Shared renderer for the Terms of Service / Privacy Policy screens
 * (apps/mobile/app/legal/terms.tsx, privacy.tsx) — see
 * packages/legal-content/terms.ts's header comment for why these are
 * structured data rendered with the existing design-system primitives
 * rather than a markdown file parsed at runtime: no new dependency, works
 * fully offline, ships with the app bundle.
 */
export function LegalDocumentScreen({
  title,
  lastUpdated,
  sections,
}: {
  title: string;
  lastUpdated: string;
  sections: LegalSection[];
}) {
  const { spacing } = useTheme();

  return (
    <>
      <Stack.Screen options={{ headerShown: true, title }} />
      <Screen style={{ paddingHorizontal: 0 }}>
        <ScrollView
          contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.xl }}
        >
          <Text variant="caption" color="secondary" style={{ marginTop: spacing.md }}>
            Last updated {lastUpdated}
          </Text>
          {sections.map((section) => (
            <View key={section.heading} style={{ marginTop: spacing.xl }}>
              <Text variant="bodyMedium" style={{ marginBottom: spacing.sm }}>
                {section.heading}
              </Text>
              {section.body.map((paragraph, i) => (
                <Text
                  key={i}
                  variant="bodyRelaxed"
                  color="secondary"
                  style={{ marginBottom: spacing.sm }}
                >
                  {paragraph}
                </Text>
              ))}
            </View>
          ))}
        </ScrollView>
      </Screen>
    </>
  );
}
