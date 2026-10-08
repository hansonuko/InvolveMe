import type { Metadata } from 'next';
import { PricingContent } from '@/components/PricingContent';

export const metadata: Metadata = {
  title: 'Pricing',
  description: 'InvolveMe credit pricing: what messages cost, and what you earn per reply.',
};

export default function PricingPage() {
  return <PricingContent />;
}
