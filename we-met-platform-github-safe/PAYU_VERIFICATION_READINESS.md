# We Met — PayU verification readiness

Release: 5.17.0
Updated: 8 August 2026

## Important: website fixes cannot guarantee PayU approval

The public site is now materially clearer and more reviewable, but PayU may still reject the business model based on its current restricted/banned business rules. PayU's published list includes web-based telephony / voice services, intangible goods or services, and some mature/friend-finder businesses. Do not disguise the actual service or submit a false category. Ask PayU support to confirm whether this exact business model is eligible before repeatedly resubmitting.

Suggested truthful eligibility question:

> We Met is an 18+ online conversation platform. Customers purchase prepaid talk-time and use it for one-to-one browser audio conversations with available Malayalam listeners. We do not arrange offline meet-ups and do not provide escort or sexual services. Is this business model eligible for PayU Payment Gateway?

## Changes in 5.17.0

- Added public About Us, Contact Us, Pricing, Service Delivery, Terms, Privacy, Refund & Cancellation, and Community Guidelines pages.
- Added a public footer linking every verification-relevant page.
- Added server-driven public talk-time pricing before sign-in.
- Added a clear service disclosure explaining what customers buy and when billing starts.
- Clarified that there are no physical goods or shipping.
- Strengthened refund, privacy, safety and delivery wording.
- Registration now links directly to the Terms and Privacy Policy.
- Synthetic demo/test listener profiles are no longer shown to customers; only real connected listener accounts appear in the customer directory.
- Added robots.txt and sitemap.xml for https://wemet.xyz.
- Bumped customer release/cache version to 5.17.0.

## Before resubmitting to PayU

1. Deploy this release and verify all public URLs load over HTTPS without login.
2. Make sure the business/legal name submitted to PayU matches the PAN/bank/KYC entity. Do not invent or shorten a legal name to force a match.
3. Use a bank account whose holder name matches the relevant PAN/merchant entity requirements.
4. If PayU asks for a business address, phone or legal-owner name on the website, add the exact KYC-matching information. This package deliberately does not invent those details.
5. Keep listener availability truthful. Do not present demo/bot profiles as real people or fake online/busy activity.
6. Keep all marketing consistent with the real service. Do not advertise sexual services, escorts, explicit content, or offline meet-ups if those are prohibited by the platform.
7. Test the full customer path: main page -> pricing -> account -> checkout -> payment result -> wallet credit -> call.
8. Check that wemetsite@gmail.com is monitored and can answer refund/payment requests.

## Public pages to test

- https://wemet.xyz/
- https://wemet.xyz/about.html
- https://wemet.xyz/contact.html
- https://wemet.xyz/pricing.html
- https://wemet.xyz/delivery.html
- https://wemet.xyz/terms.html
- https://wemet.xyz/privacy.html
- https://wemet.xyz/refund.html
- https://wemet.xyz/community-guidelines.html

## Do not do this

Do not rename or describe We Met as a different type of business just to bypass PayU risk checks. If PayU confirms this category is not eligible, use a payment provider that explicitly accepts the real business model.
