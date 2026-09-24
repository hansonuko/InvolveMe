import type { Metadata } from 'next';
import { TERMS_LAST_UPDATED, TERMS_OF_SERVICE } from '@involveme/legal-content';
import { LegalDocument } from '@/components/LegalDocument';

export const metadata: Metadata = {
  title: 'Terms of Service',
  description: 'InvolveMe Terms of Service.',
};

export default function TermsOfServicePage() {
  return (
    <LegalDocument
      title="Terms of Service"
      lastUpdated={TERMS_LAST_UPDATED}
      sections={TERMS_OF_SERVICE}
    />
  );
}
