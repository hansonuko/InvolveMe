import type { Metadata } from 'next';
import { PRIVACY_LAST_UPDATED, PRIVACY_POLICY } from '@involveme/legal-content';
import { LegalDocument } from '@/components/LegalDocument';

export const metadata: Metadata = {
  title: 'Privacy Policy',
  description: 'InvolveMe Privacy Policy.',
};

export default function PrivacyPolicyPage() {
  return (
    <LegalDocument
      title="Privacy Policy"
      lastUpdated={PRIVACY_LAST_UPDATED}
      sections={PRIVACY_POLICY}
    />
  );
}
