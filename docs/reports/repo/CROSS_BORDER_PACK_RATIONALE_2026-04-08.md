# Cross-Border Pack Rationale

Date: 2026-04-08

## Scope

This note records the product rationale for the first `industry-cross-border-ecommerce`
operating pack implementation. It is intentionally narrow:

- Primary audience: Chinese solo operators
- Initial operating modes:
  - SEA / TikTok Shop
  - NA / Amazon
- Automation posture: semi-automated
- Compliance boundary:
  - public rankings
  - public product pages
  - public prices
  - first-party store exports
  - user-provided links, screenshots, and CSVs

It does **not** authorize hidden scraping, policy evasion, or infringement automation.

## Why SEA / TikTok Shop first

These operating signals map directly onto the pack's setup profile, snapshot, and daily/weekly
recommendations:

- TikTok Shop order operations are highly SLA-driven; orders approaching SLA auto-cancel are an
  explicit operating risk.
  - Source: https://seller-us.tiktok.com/university/essay?identity=1&knowledge_id=7774796412471041
- TikTok Shop supports merchant-configured return/refund handling, including refund-without-return
  rules, which makes customer-service and after-sales handling a first-class workflow area.
  - Source: https://seller-us.tiktok.com/university/essay?knowledge_id=3253210454181634
- Shop performance metrics affect seller health and campaign eligibility, which justifies making
  store health, customer service, fulfillment, and benchmark tracking default daily surfaces.
  - Sources:
    - https://seller-us.tiktok.com/university/essay?knowledge_id=5513514539419405&lang=en
    - https://seller-us.tiktok.com/university/essay?default_language=en&knowledge_id=7823403742840619

## Why NA / Amazon first

- Amazon Remote Fulfillment with FBA makes fulfillment, returns, and regional listing readiness a
  concrete operating layer for North America.
  - Source: https://sell.amazon.com/fulfillment-by-amazon/remote-fulfillment
- Amazon Ads has consolidated campaign operations into a command-center style flow, which supports
  daily price/ad/inventory review as a stable operator workflow.
  - Source: https://advertising.amazon.com/es-mx/resources/whats-new/unboxed-2025-campaign-manager

## Why Shopify framework is retained but not first-class in v1

- Shopify Markets, localization, country-specific pricing, and duties/import taxes are important
  for North America, but Friday v1 does not need a second top-level product surface to represent
  them.
  - Sources:
    - https://help.shopify.com/en/manual/international/managing
    - https://help.shopify.com/en/manual/international/localization-and-translation
    - https://help.shopify.com/en/manual/international/pricing/product-prices-by-country
    - https://help.shopify.com/en/manual/international/duties-and-import-taxes/charging-duties

This is why the v1 pack keeps a North America operating mode without introducing Shopify-specific
product branching yet.

## Product Consequences

The pack therefore defaults to:

- operating profile first
- structured imports before deep integrations
- daily health / category / price / customer-service loops
- weekly hot-product and operating-profile tuning loops
- assistant handoff as a structured operator summary, not a freeform consultant persona

## Explicit Non-Goals For v1

- no hidden scraping or policy workarounds
- no automated repricing execution
- no automated listing cloning
- no automated refund adjudication
- no second cross-border top-level pack
