# Running Waduge Inn publicly

This application needs a Node.js server with an outbound PostgreSQL connection. The preview server is for local interface review only; it cannot accept real bookings. Payments remain bank transfers verified by staff.

## Prepare

1. Use a host that runs the existing `npm start` command as one persistent Node process. Deploy the repository, including `public`, `src`, and `schema.sql`. Exclude `.env` and `node_modules`; install with `npm ci --omit=dev`.
2. Configure the environment on the host: `DATABASE_URL`, a unique `ADMIN_PASSWORD`, `NODE_ENV=production`, and `PUBLIC_BASE_URL` set to the actual HTTPS site URL. The database account must be able to apply the startup schema migrations. Keep `CURRENCY` consistent with existing room prices.
3. If the host uses one trusted HTTPS reverse proxy, set `TRUST_PROXY=1`. The application must be reachable only through that proxy for forwarded headers to be trusted. Otherwise leave it unset.
4. Configure the host's health check to `/healthz`. The server uses the host's `PORT` environment variable. Startup applies the schema before listening; failed migrations prevent startup.
5. Use HTTPS. Production admin cookies are secure and will not work over plain HTTP. Use one application instance because admin sessions and login rate limits are held in memory.

## Finish setup

Open `/admin` and enter the real rooms, floor assignments, nightly rates, guest capacities, and descriptions. Add actual room photos using an HTTPS image URL or a `/assets/filename.jpg` path to an image deployed under `public/assets`. Editing rates changes future quotes; saved booking totals remain unchanged. Do not use the landscape banner photos as room photos.

Set `WHATSAPP_NUMBER` to reception's international number. Bank details need `BANK_NAME`, `BANK_ACCOUNT_NAME`, and `BANK_ACCOUNT_NUMBER`; set `BANK_BRANCH` as appropriate. `ADVANCE_PERCENT` defaults to 30. The admin dashboard reports whether these settings are ready. Guests can save requests before WhatsApp is configured and track them through their private link; staff must arrange payment details directly until setup is complete.

Email is optional. Add `RESEND_API_KEY`, `NOTIFICATION_FROM`, and `NOTIFICATION_TO` once a verified sender is available. The worker starts with `npm start`; this sends real queued notifications eligible for retry. Old requests beyond the retry window need manual follow-up. The setup checker never starts the worker or sends notifications.

Set `PUBLIC_PHONE`, `PUBLIC_EMAIL`, `PUBLIC_ADDRESS`, and `PUBLIC_MAP_URL` for guest contact details. Restart the process after changing settings.

## Verify

- Run `node --test`. A separate empty `TEST_DATABASE_URL` enables the PostgreSQL concurrency/payment integration test. Never point it at the real booking database.
- Run `node scripts/verify-setup.js` against the configured database to apply the same startup migrations and check the guest pages, real inventory, availability, admin authentication, and settings. This does not create rooms/bookings or send messages.
- In a browser, test desktop and phone layouts: home → Book now → room/floor → dates → guest details and NIC/passport → save request → private status link. Complete one agreed real booking to check WhatsApp and receipt handling when those settings are available.
- Check the actual bank credit before recording the cumulative paid amount and transfer reference. Confirm separately after the required advance is recorded. Cancellation does not issue a refund.

No hosting target or public domain has been configured by this change. Publishing requires the selected hosting account and domain details.
