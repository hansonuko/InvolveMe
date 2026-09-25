import { AnimatedSection } from '@/components/AnimatedSection';
import { Card, Eyebrow, Section } from '@/components/Section';

const PERSONAS = [
  {
    title: 'Business & time-conscious professionals',
    body: 'Your calendar is full and your time already has a price. InvolveMe makes sure anyone who wants a piece of it pays for the privilege.',
  },
  {
    title: 'People who value personal space',
    body: "You don't owe anyone free access to your attention. Reply on your own terms, and get paid every time you do.",
  },
  {
    title: 'Remote tutors & trainers',
    body: 'Answering questions between sessions, mentoring, or coaching online stops being free labor and becomes real, extra income.',
  },
  {
    title: 'People who already get a lot of attention',
    body: 'If your inbox is already full of people who want your time, advice, or opinion, InvolveMe turns that demand into real cash.',
  },
];

// Reused on Home and About rather than copy-pasted, same shared-component
// pattern as Card/Section themselves.
export function WhoItsFor() {
  return (
    <>
      <Section className="pb-0 text-center">
        <AnimatedSection>
          <Eyebrow>Who it&apos;s for</Eyebrow>
          <h2 className="mx-auto mt-3 max-w-2xl text-display font-extrabold text-foreground">
            Built for people whose time is already in demand
          </h2>
        </AnimatedSection>
      </Section>

      <Section className="grid gap-6 pt-10 md:grid-cols-2">
        {PERSONAS.map((persona, i) => (
          <AnimatedSection key={persona.title} delay={i * 0.08}>
            <Card className="h-full">
              <h3 className="text-title font-bold text-foreground">{persona.title}</h3>
              <p className="mt-3 text-body text-muted">{persona.body}</p>
            </Card>
          </AnimatedSection>
        ))}
      </Section>
    </>
  );
}
