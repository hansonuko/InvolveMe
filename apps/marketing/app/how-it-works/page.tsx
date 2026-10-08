import type { Metadata } from 'next';
import { HowItWorksContent } from '@/components/HowItWorksContent';

export const metadata: Metadata = {
  title: 'How it works',
  description: "How InvolveMe's earn-per-message credit system actually works.",
};

export default function HowItWorksPage() {
  return <HowItWorksContent />;
}
