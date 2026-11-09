# ADR 0001: Tenancy model

- **Status:** Accepted 2026-11-09 (owner)
- **Context:** The MVP is single-tenant. A missed tenant filter would expose another institution's student records, the top risk of the SaaS upgrade.
- **Decision:**
  - One shared MongoDB database; every business collection carries `tenantId`, included in every index (users unique on `(tenantId, email)`).
  - The tenant is resolved once per request in a single middleware (path slug `/t/<slug>/...` first; subdomain can be added later in the same middleware) and cross-checked with the tenant claim in the JWT; a mismatch is rejected.
  - A Mongoose plugin / repository layer injects `tenantId` into every find, update and aggregate, so a forgotten filter cannot leak data. Cross-tenant lookups return 404.
  - `SUPER_ADMIN` is tenantless, its actions are audited, and it never reads document contents.
- **Alternatives:** database per tenant (stronger isolation, much higher cost and operational load); rejected for now, revisit if a customer requires it.
- **Consequences:** Every new route needs a cross-tenant test. Migration creates a "Default Institution" tenant for existing data (idempotent, run on a copy first).
