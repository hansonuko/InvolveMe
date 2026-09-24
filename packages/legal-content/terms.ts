/**
 * Terms of Service — real content, not placeholder copy. Drafted 2026-09-15
 * (docs/00-SESSION-HANDOFF.md session 13, continued) against the actual
 * system this app runs, not generic messaging-app boilerplate: the
 * pay-per-message escrow model (docs/03-ECONOMY-LEDGER.md), KYC-tiered
 * withdrawal limits, peer-to-peer credit transfer, and every fraud-infra
 * piece built this session (device fingerprinting, collusion detection,
 * velocity limits, rate limiting, content moderation).
 *
 * This is a draft prepared for review, not a substitute for qualified
 * Nigerian legal counsel — docs/07-COMPLIANCE-LEGAL.md says the same of
 * itself and stays true here; §15 (Governing Law) is flagged inline as
 * the clause most worth a real lawyer's pass before this ships publicly.
 *
 * Structured as data (not markdown parsed at runtime), shared via this
 * package (docs/15-MARKETING-SITE-PWA-SCOPING.md §6) so the mobile app
 * (apps/mobile/components/LegalDocumentScreen.tsx) and the marketing site
 * (apps/marketing/components/LegalDocument.tsx) render the exact same
 * source with their own native-vs-web presentation primitives — one edit
 * updates both surfaces, they can never silently drift apart. Moved here
 * from apps/mobile/content/legal/terms.ts 2026-09-24 (Phase B); no wording
 * changed in the move.
 */

export interface LegalSection {
  heading: string;
  body: string[];
}

export const TERMS_LAST_UPDATED = '2026-09-15';

export const TERMS_OF_SERVICE: LegalSection[] = [
  {
    heading: '1. Who we are, and acceptance of these terms',
    body: [
      'InvolveMe is operated by Sun Media Limited, a company registered in Nigeria ("Sun Media", "we", "us", "our"). These Terms of Service ("Terms") govern your access to and use of the InvolveMe mobile application and related services (together, the "Service").',
      'By creating an account, or by using the Service in any way, you agree to be bound by these Terms and by our Privacy Policy, which is incorporated into these Terms by reference. If you do not agree, do not use the Service.',
      'We may update these Terms from time to time — see Section 16. Continued use of the Service after an update takes effect means you accept the revised Terms.',
    ],
  },
  {
    heading: '2. Eligibility',
    body: [
      'You must be at least 18 years old to create an account or use the Service. InvolveMe involves the exchange of real money, and we do not offer any version of the Service to minors.',
      'You must register with a valid Nigerian phone number capable of receiving SMS one-time passcodes. You may hold only one InvolveMe account per person; creating or controlling multiple accounts to circumvent limits, fees, or fraud controls is a violation of these Terms (see Section 10).',
      'By confirming your age at signup, you represent to us that the confirmation is accurate. We rely on this representation, alongside the identity-verification steps described in Section 8, as part of our overall approach to age and identity assurance — it is not, on its own, a guarantee that every user is who or what age they claim to be.',
    ],
  },
  {
    heading: '3. Your account and its security',
    body: [
      'Accounts are created and accessed using a one-time passcode sent by SMS to your registered phone number — InvolveMe does not use passwords. You are responsible for maintaining control of the phone number and device associated with your account, and for all activity that occurs under your account.',
      'Notify us promptly at the contact address in Section 17 if you believe your account or phone number has been compromised. We are not liable for losses arising from unauthorized access to your account that results from your failure to secure your phone number or device.',
    ],
  },
  {
    heading: '4. The Service',
    body: [
      'InvolveMe is a messaging application where sending a message to another user costs InvolveMe credit, and the recipient earns real money (subject to a platform fee) when they reply. This pay-per-message model is the core, disclosed premise of the Service — not an incidental feature.',
      'The Service is for genuine personal communication between consenting adults. It is not, and may not be used as, a platform for soliciting or arranging sexual services, escort services, or any other service or transaction prohibited by applicable law. We actively moderate for this (Section 11) and will suspend accounts that use the Service for these purposes.',
      'We do not vet, endorse, or take responsibility for the identity, intentions, or conduct of any user you communicate with. You are solely responsible for your interactions with other users and should exercise the same judgment you would with any stranger.',
    ],
  },
  {
    heading: '5. Credits, payments, and fees',
    body: [
      'InvolveMe credit is purchased with real money ("top-up") and spent to send messages. A platform fee applies to top-ups, and a separate platform fee is deducted from the credit released to a recipient when their reply clears escrow (Section 6). Current fee rates, the cost of sending a message of a given length, and any other pricing are always shown in the app before you complete a top-up or send a message that would incur a novel cost — we do not fix specific percentages in these Terms because rates are configurable and may be adjusted from time to time; the in-app disclosure at the time of your action is authoritative.',
      'Credit purchased on InvolveMe has no cash value to you except as expressly provided by these Terms (for example, money you earn by replying to messages, which becomes withdrawable subject to Section 7). Purchased credit is not a stored-value instrument redeemable outside the Service, is non-transferable except via the peer-to-peer transfer feature described in Section 9, and is non-refundable once spent, except where required by law or where we determine in our discretion that a refund is appropriate (for example, a technical error that debited you without delivering the corresponding message).',
      'All payments are processed through licensed third-party payment service providers. We do not store your full card or bank account details ourselves — see our Privacy Policy for details of what payment data we do hold.',
    ],
  },
  {
    heading: '6. How pay-per-message escrow works',
    body: [
      'When you send the first message in a conversation, the cost is calculated from the message length and immediately deducted from your credit balance, then held in escrow — not yet paid to the recipient.',
      'If the recipient replies, the escrowed credit for every message you sent them since their last reply is released to them (subject to the platform fee in Section 5) and their reply is billed and escrowed the same way to you. If the recipient never replies, escrowed credit for that message is automatically refunded to you after a disclosed holding period (currently 48 hours, shown in the app), without you needing to take any action.',
      'Release of escrowed credit is also subject to the anti-abuse limits described in Section 10 — an unusually high rate of messages or near-identical repeated replies may cause a release to be delayed or withheld rather than paid out immediately, even though your message itself still sends normally.',
    ],
  },
  {
    heading: '7. Withdrawals',
    body: [
      'Money you earn by replying to messages converts to a withdrawable cash balance. Withdrawing to a bank account requires identity verification (Section 8) — we do not pay out to unverified identities, and we will never pay out to a bank account whose registered name does not match your verified identity.',
      'Daily withdrawal limits depend on your verification tier and are shown in the app. We aim to make verified withdrawals available within 24 hours, and we operate an automatic sweep so you do not have to remember to withdraw — but this target applies to verified accounts with a linked, name-matched bank account; it is not an unconditional guarantee for every account or every circumstance, and funds are held (never forcibly redirected or forfeited) if you have not yet linked a verified bank account.',
      "We may delay, hold, or decline a withdrawal where we reasonably suspect fraud, a chargeback risk on the funds' origin, or a violation of these Terms, pending review.",
    ],
  },
  {
    heading: '8. Identity verification (KYC)',
    body: [
      'Before you can withdraw money, or transfer credit to another user (Section 9), we require identity verification against your Bank Verification Number (BVN) or National Identification Number (NIN) through a licensed verification provider, as required by Nigerian financial regulation.',
      'We do not store your raw BVN or NIN. We store only a one-way cryptographic hash of the number (combined with a secret value we control, so the hash cannot practically be reversed) and the verified name your provider returns, which we use solely to confirm a match against the bank account you link. See our Privacy Policy for the full detail on how this data is handled.',
    ],
  },
  {
    heading: '9. Peer-to-peer credit transfer',
    body: [
      'You may transfer purchased credit directly to another verified InvolveMe user, subject to a per-transfer cap shown in the app and a platform fee deducted from the amount received. The recipient must have completed identity verification (Section 8) before they can receive a transfer — we do not allow credit to convert into withdrawable cash for an unverified identity through this feature or any other.',
      'This feature moves real value between users independent of any message being sent. We monitor transfers for patterns consistent with fraud or money laundering (see Section 10) and may freeze funds or suspend accounts involved in suspicious transfer activity pending review.',
    ],
  },
  {
    heading: '10. Prohibited conduct',
    body: [
      'In addition to the restrictions elsewhere in these Terms, you agree not to:',
      '• Create or control more than one account, or use a device, payment instrument, or identity document already associated with another account, to circumvent limits, fees, or verification requirements.',
      '• Engage in "wash chatting" — controlling both sides of a conversation, alone or with an accomplice, to extract money from the platform without genuine engagement — or otherwise attempt to game the escrow-release, withdrawal, or transfer mechanics described above.',
      '• Send spam, near-identical repeated messages, or automate message sending (by bot, script, or otherwise) to farm earnings.',
      '• Use the Service to harass, threaten, defraud, or solicit prohibited services from another user (Section 4).',
      '• Attempt to circumvent, disable, or interfere with our fraud-detection systems, including device-fingerprint linkage, velocity limits, collusion detection, or content moderation.',
      '• Use a stolen or unauthorized payment instrument to top up credit.',
      'We use a combination of automated systems (device fingerprinting, transaction-pattern and collusion detection, rate limiting, content moderation) and manual review to detect violations of this section. Violations may result in message rejection, credit forfeiture, wallet freezing, withdrawal denial, account suspension, or reporting to law enforcement or financial regulators, at our discretion and depending on severity.',
    ],
  },
  {
    heading: '11. Content moderation and enforcement',
    body: [
      'Messages and status updates are screened by an automated moderation system before being sent or posted. Content identified as severe — including sexual content involving minors, credible threats of violence, and similar high-severity categories — is blocked outright and never delivered or charged. Content flagged as lower-severity is delivered normally but logged for review, and repeated or serious flags may lead to account-level enforcement under Section 10.',
      'You may also report another user or a specific conversation to us directly from within the app. We review reports and may take any of the enforcement actions described in Section 10 as a result.',
      'Automated moderation is not perfect. If you believe your content was blocked or flagged in error, contact us at the address in Section 17.',
    ],
  },
  {
    heading: '12. Blocking and reporting',
    body: [
      'You may block another user at any time from within a conversation. Blocking prevents further messages between you and that user in both directions and can be reversed by the person who initiated the block.',
      'Reporting a user or conversation (Section 11) is separate from blocking and is reviewed by us; it does not automatically notify the reported user.',
    ],
  },
  {
    heading: '13. Termination and account deletion',
    body: [
      'You may request deletion of your account at any time from Settings. Because InvolveMe custodies real funds, account deletion is handled as a reviewed request rather than an instant, fully automated action — your outstanding wallet balance needs to be resolved (withdrawn or otherwise settled) as part of that process before your account can be closed.',
      'Following deletion, we retain your financial and ledger transaction records for the period required by applicable anti-money-laundering regulation, even though your profile is deleted or anonymized — this is a legal retention obligation, not a choice we can waive on request. See our Privacy Policy, Section 6, for detail.',
      'We may suspend or terminate your account, with or without notice, for violation of these Terms, suspected fraud, or as required by law or a payment/KYC provider we rely on.',
    ],
  },
  {
    heading: '14. Disclaimers and limitation of liability',
    body: [
      'The Service is provided "as is." We do not guarantee that the Service will be uninterrupted, error-free, or available at all times, or that any particular user you interact with is trustworthy, genuine, or who they claim to be.',
      'To the maximum extent permitted by applicable Nigerian law, Sun Media Limited is not liable for indirect, incidental, or consequential damages arising from your use of the Service, or for the conduct of any other user. Nothing in these Terms limits liability that cannot lawfully be limited, including liability for our own fraud or willful misconduct.',
    ],
  },
  {
    heading: '15. Dispute resolution and governing law',
    body: [
      'These Terms are governed by the laws of the Federal Republic of Nigeria. Any dispute arising from these Terms or the Service will first be addressed through good-faith negotiation via the contact channel in Section 17 before either party pursues formal proceedings before the courts of Nigeria.',
      'This section, more than any other in this document, has not yet been reviewed by qualified Nigerian legal counsel and should be treated as a placeholder for that review, not a final clause — see docs/07-COMPLIANCE-LEGAL.md.',
    ],
  },
  {
    heading: '16. Changes to these Terms',
    body: [
      'We may revise these Terms from time to time to reflect changes to the Service, applicable law, or our practices. We will update the "last updated" date shown in the app when we do. Material changes will be highlighted in-app; continuing to use the Service after a change takes effect constitutes acceptance of the revised Terms.',
    ],
  },
  {
    heading: '17. Contact',
    body: [
      'Questions about these Terms, or requests relating to your account (including deletion requests), can be sent to support@sunmedialimited.com.ng.',
    ],
  },
];
