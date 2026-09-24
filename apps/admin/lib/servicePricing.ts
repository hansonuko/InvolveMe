// Service Pricing registry (docs/14-ADMIN-DASHBOARD-SCOPING.md §4.2,
// "Free-vs-charged toggles"). A small, explicit list rather than a new DB
// table — today there is exactly one such kill-switch
// (group_chat_enabled), and the doc's own "future services register
// themselves into this same table" language is explicitly forward-looking
// (docs/11's voice/video calls, not yet built). Standing up a registry
// table for one row would be premature; this list is cheap to extend the
// same way lib/pricingCategories.ts already is, and the day a second
// service toggle is needed is the right time to revisit whether a real
// table earns its keep.
//
// `kind: 'flag'` is a pure on/off kill-switch (enabled always means
// "live and billed," there's no "live but free" state) — the only shape
// that exists today. `kind: 'rate'` is reserved for a future service
// whose free/charged status is really "is the rate currently zero,"
// distinct from whether the feature runs at all; nothing uses it yet.
export type ServicePricingEntry = {
  serviceName: string;
  configKey: string;
  currency: string;
  kind: 'flag' | 'rate';
  description: string;
};

export const SERVICE_PRICING_REGISTRY: ServicePricingEntry[] = [
  {
    serviceName: 'Group messaging',
    configKey: 'group_chat_enabled',
    currency: 'NGN',
    kind: 'flag',
    description:
      'Whether group chat billing is live platform-wide — a pure kill-switch, not a rate. Stays gated behind Phase 5 fraud infra regardless of this control existing.',
  },
];
