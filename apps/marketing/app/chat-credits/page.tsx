import type { Metadata } from 'next';
import { ChatCreditsContent } from '@/components/ChatCreditsContent';

export const metadata: Metadata = {
  title: 'Chat Credits',
  description: 'Buy Chat Credits to get someone’s time on InvolveMe — from ₦100.',
};

export default function ChatCreditsPage() {
  return <ChatCreditsContent />;
}
