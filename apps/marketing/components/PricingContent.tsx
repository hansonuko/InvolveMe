'use client';

import Link from 'next/link';
import { AnimatedSection } from '@/components/AnimatedSection';
import { Card, Eyebrow, Section } from '@/components/Section';
import {
  creditsForBytes,
  creditsForWords,
  earningsForBytes,
  earningsForWords,
  formatNaira,
} from '@/lib/pricing';
import { usePublicPricing } from '@/lib/usePublicPricing';

export function PricingContent() {
  const pricing = usePublicPricing();
  const examples = [10, 50, 150, 500].map((words) => ({
    words,
    credits: creditsForWords(pricing, words),
    earnings: earningsForWords(pricing, words),
  }));

  // Encrypted-conversation pricing (byte-based) — same 4 tiers as the
  // word-based examples above, scaled by the block-size ratio
  // (message_byte_block_size / message_word_block_size, 300/50 = 6 bytes
  // per "word" at the calibration point) so the two example sets line up
  // side by side rather than picking arbitrary, unrelated byte counts.
  const bytesPerWord = pricing.message_byte_block_size / pricing.message_word_block_size;
  const byteExamples = [10, 50, 150, 500].map((words) => {
    const bytes = Math.round(words * bytesPerWord);
    return {
      bytes,
      credits: creditsForBytes(pricing, bytes),
      earnings: earningsForBytes(pricing, bytes),
    };
  });

  return (
    <>
      <Section className="pb-10 pt-16 text-center">
        <AnimatedSection>
          <Eyebrow>Pricing</Eyebrow>
          <h1 className="mx-auto mt-4 max-w-2xl text-display font-extrabold text-foreground">
            One credit price. No subscriptions, no hidden fees.
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-body text-muted">
            What people pay to message you, and what you actually earn when you reply. These figures
            come straight from our live pricing configuration, not a page someone forgot to update.
          </p>
        </AnimatedSection>
      </Section>

      <Section className="grid gap-6 md:grid-cols-2">
        <AnimatedSection>
          <Card className="h-full text-center">
            <p className="text-caption font-semibold uppercase tracking-wide text-muted">
              Credit price
            </p>
            <p className="mt-4 text-balance font-extrabold text-foreground">
              1 credit = {formatNaira(pricing.credit_unit_kobo)}
            </p>
            <p className="mt-4 text-body text-muted">
              A small platform fee applies on top-ups and on what you earn, enough to cover payment
              processing and the fraud/escrow infrastructure that keeps your money safe.
            </p>
          </Card>
        </AnimatedSection>

        <AnimatedSection delay={0.1}>
          <Card className="h-full">
            <p className="text-caption font-semibold uppercase tracking-wide text-muted">
              What you earn per reply
            </p>
            <ul className="mt-4 flex flex-col gap-3">
              {examples.map((e) => (
                <li
                  key={e.words}
                  className="flex items-center justify-between border-b border-border pb-3 text-body last:border-0 last:pb-0"
                >
                  <span className="text-muted">~{e.words}-word message</span>
                  <span className="font-semibold text-foreground">
                    {e.earnings} credits · {formatNaira(e.earnings * pricing.credit_unit_kobo)}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-4 text-caption text-muted">
              The sender pays {Math.min(...examples.map((e) => e.credits))}-
              {Math.max(...examples.map((e) => e.credits))} credits for these same messages; the
              platform&apos;s fee is the difference.
            </p>
          </Card>
        </AnimatedSection>
      </Section>

      <Section>
        <AnimatedSection>
          <Card>
            <p className="text-caption font-semibold uppercase tracking-wide text-muted">
              🔒 Encrypted conversations
            </p>
            <p className="mt-3 max-w-2xl text-body text-muted">
              Turn on end-to-end encryption for a conversation and pricing works the same way, just
              measured differently: since the server can never read an encrypted message&apos;s
              content, it can&apos;t count words in it, only the encrypted message&apos;s byte
              length. The rate is calibrated to land on the same numbers as an equivalent-length
              unencrypted message.
            </p>
            <ul className="mt-4 grid gap-3 sm:grid-cols-2">
              {byteExamples.map((e) => (
                <li
                  key={e.bytes}
                  className="flex items-center justify-between border-b border-border pb-3 text-body last:border-0 last:pb-0 sm:border-0 sm:pb-0"
                >
                  <span className="text-muted">~{e.bytes}-byte message</span>
                  <span className="font-semibold text-foreground">
                    {e.earnings} credits · {formatNaira(e.earnings * pricing.credit_unit_kobo)}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-4 text-caption text-muted">
              Encrypted messages are capped at {pricing.message_max_bytes} bytes per message.
            </p>
          </Card>
        </AnimatedSection>
      </Section>

      <Section className="rounded-sheet bg-surface-alt text-center">
        <AnimatedSection>
          <h2 className="text-title font-bold text-foreground">
            Want the exact formula behind these numbers?
          </h2>
          <Link
            href="/how-it-works"
            className="mt-4 inline-block text-body font-semibold text-foreground-accent hover:underline"
          >
            See how it works →
          </Link>
        </AnimatedSection>
      </Section>
    </>
  );
}
