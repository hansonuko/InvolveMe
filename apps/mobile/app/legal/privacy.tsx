import { LegalDocumentScreen } from '@/components/LegalDocumentScreen';
import { PRIVACY_LAST_UPDATED, PRIVACY_POLICY } from '@involveme/legal-content';

export default function PrivacyPolicyScreen() {
  return (
    <LegalDocumentScreen
      title="Privacy Policy"
      lastUpdated={PRIVACY_LAST_UPDATED}
      sections={PRIVACY_POLICY}
    />
  );
}
