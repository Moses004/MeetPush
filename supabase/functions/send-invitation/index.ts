import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";

const allowedOrigins = new Set([
  "https://moses004.github.io",
  "https://meetpush.vercel.app"
]);

function corsHeaders(origin: string | null) {
  const headers = new Headers({
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
    "Vary": "Origin"
  });
  if (origin && allowedOrigins.has(origin)) headers.set("Access-Control-Allow-Origin", origin);
  return headers;
}

function icsEscape(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
}

function icsUtc(date: Date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function formatWhen(date: Date, timeZone: string) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: "UTC"
    }).format(date);
  }
}

function calendarFile(event: { id: string; title: string; starts_at: string; duration_minutes: number; location: string | null }) {
  const start = new Date(event.starts_at);
  const end = new Date(start.getTime() + event.duration_minutes * 60_000);
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//MeetPush//Calendar Invite//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${event.id}@meetpush`,
    `DTSTAMP:${icsUtc(new Date())}`,
    `DTSTART:${icsUtc(start)}`,
    `DTEND:${icsUtc(end)}`,
    `SUMMARY:${icsEscape(event.title)}`,
    event.location ? `LOCATION:${icsEscape(event.location)}` : "",
    "END:VEVENT",
    "END:VCALENDAR"
  ].filter(Boolean).join("\r\n");
}

function base64Utf8(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

Deno.serve(async (request: Request) => {
  const responseHeaders = corsHeaders(request.headers.get("Origin"));
  const reply = (body: Record<string, unknown>, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: responseHeaders });

  if (request.method === "OPTIONS") return new Response("ok", { headers: responseHeaders });
  if (request.method !== "POST") return reply({ error: "method_not_allowed" }, 405);

  const authorization = request.headers.get("Authorization");
  if (!authorization) return reply({ error: "unauthorized" }, 401);

  const projectUrl = Deno.env.get("SUPABASE_URL");
  const publicKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!projectUrl || !publicKey) return reply({ error: "backend_not_configured" }, 500);

  const client = createClient(projectUrl, publicKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authorization } }
  });

  const { data: authData, error: authError } = await client.auth.getUser();
  if (authError || !authData.user) return reply({ error: "unauthorized" }, 401);
  const user = authData.user;

  let body: { eventId?: string; guestId?: string };
  try {
    body = await request.json();
  } catch {
    return reply({ error: "invalid_request" }, 400);
  }
  if (!body.eventId || !body.guestId) return reply({ error: "event_and_guest_required" }, 400);

  const { data: event, error: eventError } = await client
    .from("events")
    .select("id,title,kind,starts_at,duration_minutes,timezone,location")
    .eq("id", body.eventId)
    .eq("owner_id", user.id)
    .maybeSingle();
  if (eventError || !event) return reply({ error: "event_not_found" }, 404);

  const { data: guest, error: guestError } = await client
    .from("event_guests")
    .select("id,name,contact,channel,status")
    .eq("id", body.guestId)
    .eq("event_id", event.id)
    .eq("owner_id", user.id)
    .maybeSingle();
  if (guestError || !guest) return reply({ error: "guest_not_found" }, 404);

  const startsAt = new Date(event.starts_at);
  const when = formatWhen(startsAt, event.timezone || "UTC");
  const where = event.location ? `\nWhere: ${event.location}` : "";
  const message = `Hi ${guest.name}, you're invited to ${event.title} (${event.kind.toLowerCase()}).\n\nWhen: ${when}${where}\n\nHope you can make it!${guest.channel === "sms" ? "\n\nMeetPush · Reply STOP to opt out of texts." : "\n\nMeetPush"}`;

  if (guest.channel === "email") {
    const apiKey = Deno.env.get("RESEND_API_KEY");
    const from = Deno.env.get("RESEND_FROM_EMAIL");
    if (!apiKey || !from) return reply({ error: "provider_not_configured", channel: guest.channel }, 503);

    const ics = calendarFile(event);
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: [guest.contact],
        subject: `You're invited: ${event.title}`,
        text: message,
        attachments: [{ filename: "meetpush-invite.ics", content: base64Utf8(ics) }]
      })
    });
    if (!response.ok) {
      console.error("Resend rejected an invitation:", response.status);
      return reply({ error: "provider_failed", channel: guest.channel }, 502);
    }
  } else if (guest.channel === "sms") {
    const accountSid = Deno.env.get("TWILIO_ACCOUNT_SID");
    const authToken = Deno.env.get("TWILIO_AUTH_TOKEN");
    const messagingServiceSid = Deno.env.get("TWILIO_MESSAGING_SERVICE_SID");
    const fromNumber = Deno.env.get("TWILIO_PHONE_NUMBER");
    if (!accountSid || !authToken || (!messagingServiceSid && !fromNumber)) {
      return reply({ error: "provider_not_configured", channel: guest.channel }, 503);
    }

    const form = new URLSearchParams({ To: guest.contact, Body: message });
    if (messagingServiceSid) form.set("MessagingServiceSid", messagingServiceSid);
    else form.set("From", fromNumber!);
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${btoa(`${accountSid}:${authToken}`)}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: form
    });
    if (!response.ok) {
      console.error("Twilio rejected an invitation:", response.status);
      return reply({ error: "provider_failed", channel: guest.channel }, 502);
    }
  } else {
    return reply({ error: "unsupported_channel" }, 400);
  }

  const { error: updateError } = await client
    .from("event_guests")
    .update({ status: "sent", sent_at: new Date().toISOString() })
    .eq("id", guest.id)
    .eq("owner_id", user.id);
  if (updateError) console.error("Invite sent, but status update failed.");

  return reply({ ok: true, status: "sent", guestId: guest.id });
});
