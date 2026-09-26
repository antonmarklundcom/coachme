# Spec: read-only lead stats endpoint in VenderCRM (for coachme)

**Status:** proposed. Build it in the `vendercrm` repo, not from coachme. coachme keeps a
task in the vendercrm project that points here, and it closes when Anton marks it done.

## Why

coachme's Portfolio "leads" dot, the `leads_month` goal and the weekly review need
**leads per site per day**. The only read path today is a tenant's contacts CSV feed
(`/api/exports/contacts?token=…`). That feed returns names, phones and emails, and it is
per tenant. coachme uses it as a stopgap: it reads only the `origen` and `creado` columns,
counts in memory and stores counts only. A counts-only endpoint removes the personal data
from the wire altogether, and it covers every tenant in one call.

## Endpoint

```
GET /api/ops/v1/stats/leads?from=YYYY-MM-DD&to=YYYY-MM-DD
Authorization: Bearer <ops token>
```

- **Auth:** the existing ops token (`authenticateOpsRequest` in `src/modules/ops/http.ts`),
  scoped to the token's allowed tenants (`allowedTenantIds`). Read-only: no writes, no call
  counting side effects beyond what ops tokens already do.
- **Range:** `from` and `to` are inclusive calendar days in `America/Asuncion`. The maximum
  span is 90 days, and the default is the last 30 days.
- **Rate limit:** 30 requests a minute per token, like the contacts feed.

## Response

```json
{
  "data": [
    { "tenant_slug": "anton", "site_slug": "propia.com.py", "day": "2026-09-25", "count": 4 },
    { "tenant_slug": "anton", "site_slug": "tasacion.com.py", "day": "2026-09-25", "count": 1 }
  ]
}
```

- One row per (tenant, site, day) with `count > 0`. Days with no leads are omitted.
- `site_slug` is the site a lead came in through: the registered site's domain or slug that
  `POST /api/v1/leads` recorded as the contact `source`. Blank sources are reported as
  `"unknown"`.
- **No personal data:** no names, phones, emails, notes or ids.

## Acceptance checks

- [ ] Unit test: counts group by tenant, site and local day across the UTC midnight boundary.
- [ ] Route test: 401 without a token, 403 for a tenant outside the allowlist, 400 for a range
      over 90 days or bad dates, 200 with the shape above.
- [ ] A test asserts the response keys are exactly `tenant_slug`, `site_slug`, `day` and `count`.
- [ ] Docs: the ops API reference lists the endpoint.

## Wiring it to coachme

Put the ops token in `C:\Claude 1\coachme\.env.local` as `VENDERCRM_STATS_KEY`. The `crm`
collector then prefers this endpoint over the CSV feed on its next run (every 60 minutes, or
`coach collect crm`).
