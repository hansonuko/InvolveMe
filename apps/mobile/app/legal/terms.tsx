import { LegalDocumentScreen } from '@/components/LegalDocumentScreen';
import { TERMS_LAST_UPDATED, TERMS_OF_SERVICE } from '@involveme/legal-content';

export default function TermsOfServiceScreen() {
  return (
    <LegalDocumentScreen
      title="Terms of Service"
      lastUpdated={TERMS_LAST_UPDATED}
      sections={TERMS_OF_SERVICE}
    />
  );
}
