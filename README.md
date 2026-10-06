# MeetPush

MeetPush helps you schedule meetings, appointments, and events, then invite people by email or phone. The production site is hosted on Vercel at <https://meetpush.vercel.app>. The Vercel project is connected to this repository and deploys from `main`.

The workflow in `.github/workflows/deploy.yml` can also publish a copy on GitHub Pages after Pages is enabled with **GitHub Actions** in repository settings.

## Run locally

Open `index.html` for the local-only schedule. Cloud sign-in uses the Supabase project configured in `config.js` and requires a network connection. No build step is needed.

## Configure Supabase

1. In **Authentication → URL Configuration**, set the Site URL to `https://meetpush.vercel.app` and add it to Redirect URLs. If you enable GitHub Pages, add `https://moses004.github.io/MeetPush/` as an additional redirect URL.
2. In **Edge Functions → Secrets**, set `RESEND_API_KEY` and `RESEND_FROM_EMAIL` for email. The sender address must use a domain verified with Resend.
3. For automated SMS, set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and either `TWILIO_MESSAGING_SERVICE_SID` or `TWILIO_PHONE_NUMBER`. Until a provider is configured, the app opens the device's email or SMS composer instead.

The database migrations are in `supabase/migrations/`; the authenticated invitation sender is in `supabase/functions/send-invitation/`. Never put provider credentials or Supabase secret keys in `config.js`.
