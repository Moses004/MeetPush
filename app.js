(() => {
  const STORAGE_KEY = 'meetpush-v2';
  const COLORS = ['violet', 'peach', 'mint', 'blue'];
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const localDateKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const dateAtOffset = (offset) => { const date = new Date(); date.setHours(0, 0, 0, 0); date.setDate(date.getDate() + offset); return date; };
  const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const prettyDate = (key, options = { weekday: 'long', month: 'long', day: 'numeric' }) => new Intl.DateTimeFormat(undefined, options).format(new Date(`${key}T12:00:00`));
  const shortDate = (key) => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(`${key}T12:00:00`));
  const dateWeekday = (key) => new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(new Date(`${key}T12:00:00`));
  const startOfWeek = (date) => { const result = new Date(date); result.setHours(0, 0, 0, 0); result.setDate(result.getDate() - ((result.getDay() + 6) % 7)); return result; };
  const uid = () => (crypto?.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const displayTime = (time) => {
    if (!time) return '';
    const [hour, minute] = time.split(':').map(Number);
    const date = new Date(); date.setHours(hour, minute, 0, 0);
    return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date);
  };
  const timeRange = (event) => {
    const [hour, minute] = event.time.split(':').map(Number);
    const end = new Date(); end.setHours(hour, minute + Number(event.duration || 60), 0, 0);
    return `${displayTime(event.time)} – ${new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(end)}`;
  };
  const initials = (name = '') => name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || '?';
  const validEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  const validPhone = (value) => /^\+?[\d\s().-]{7,}$/.test(value) && value.replace(/\D/g, '').length >= 7;
  const contactType = (value) => validEmail(value) ? 'email' : validPhone(value) ? 'phone' : null;
  const cleanPhone = (value) => value.replace(/[\s().-]/g, '');

  function makeSeed() {
    return { events: [], contacts: [] };
  }

  function readData() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (saved && Array.isArray(saved.events) && Array.isArray(saved.contacts)) return saved;
    } catch { /* Start with a fresh local schedule if saved data cannot be read. */ }
    const fresh = makeSeed();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(fresh));
    return fresh;
  }

  let data = readData();
  let currentView = 'overview';
  let weekOffset = 0;
  let selectedDate = localDateKey(new Date());
  let toastTimer;
  let supabaseClient = null;
  let cloudUser = null;
  let cloudUnavailable = false;
  let cloudClientPromise = null;

  function persist() { if (!cloudUser) localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); }
  function remoteGuest(row) {
    return { id: row.id, name: row.name, contact: row.contact, type: row.channel === 'sms' ? 'phone' : 'email', status: row.status || 'ready', sentAt: row.sent_at || null };
  }
  function remoteEvent(row) {
    const date = new Date(row.starts_at);
    const zone = row.timezone || 'UTC';
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
    const pick = (type) => parts.find((part) => part.type === type)?.value || '00';
    const dateKey = `${pick('year')}-${pick('month')}-${pick('day')}`;
    const time = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
    return { id: row.id, title: row.title, kind: row.kind, date: dateKey, time, duration: Number(row.duration_minutes), location: row.location || '', timezone: zone, startsAt: row.starts_at, guests: (row.event_guests || []).map(remoteGuest) };
  }
  async function loadCloudData() {
    const { data: events, error: eventsError } = await supabaseClient.from('events').select('*, event_guests(*)').order('starts_at', { ascending: true });
    if (eventsError) throw eventsError;
    const { data: contacts, error: contactsError } = await supabaseClient.from('contacts').select('*').order('name', { ascending: true });
    if (contactsError) throw contactsError;
    data = {
      events: (events || []).map(remoteEvent),
      contacts: (contacts || []).map((person) => ({ id: person.id, name: person.name, contact: person.contact, type: person.channel === 'sms' ? 'phone' : 'email' }))
    };
  }
  function updateSyncButton() {
    const button = $('#sync-button');
    button.classList.toggle('connected', Boolean(cloudUser));
    button.classList.toggle('unavailable', cloudUnavailable);
    $('#sync-label').textContent = cloudUser ? 'Cloud synced' : cloudUnavailable ? 'Sync unavailable' : 'Local mode · Sign in';
    button.setAttribute('aria-label', cloudUser ? `Signed in as ${cloudUser.email || 'your account'}` : 'Sign in to sync your schedule');
  }
  async function ensureCloudClient() {
    if (supabaseClient) return supabaseClient;
    if (cloudClientPromise) return cloudClientPromise;
    const config = window.MEETPUSH_CONFIG;
    if (!config?.supabaseUrl || !config?.supabaseKey) { cloudUnavailable = true; updateSyncButton(); return null; }
    cloudClientPromise = import('https://esm.sh/@supabase/supabase-js@2.95.0').then(({ createClient }) => {
      supabaseClient = createClient(config.supabaseUrl, config.supabaseKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
      return supabaseClient;
    }).catch((error) => { console.warn('MeetPush cloud sync is unavailable.', error); cloudUnavailable = true; updateSyncButton(); return null; });
    return cloudClientPromise;
  }
  async function initializeCloud() {
    const client = await ensureCloudClient();
    if (!client) return;
    try {
      const { data: sessionData, error } = await client.auth.getSession();
      if (error) throw error;
      cloudUser = sessionData.session?.user || null;
      if (cloudUser) await loadCloudData();
      client.auth.onAuthStateChange((event, session) => {
        const nextUser = session?.user || null;
        window.setTimeout(async () => {
          const changed = nextUser?.id !== cloudUser?.id;
          cloudUser = nextUser;
          try {
            if (cloudUser && (changed || event === 'SIGNED_IN')) await loadCloudData();
            else if (!cloudUser && changed) data = readData();
            cloudUnavailable = false;
          } catch (loadError) {
            console.error('MeetPush could not load cloud data.', loadError);
            showToast('Could not load your cloud schedule. Refresh and try again.');
          }
          updateSyncButton(); renderAll();
        }, 0);
      });
    } catch (error) {
      console.error('MeetPush cloud initialization failed.', error);
      cloudUnavailable = true;
    }
    updateSyncButton(); renderAll();
  }
  function weekDates(offset = weekOffset) {
    const start = startOfWeek(new Date()); start.setDate(start.getDate() + offset * 7);
    return Array.from({ length: 7 }, (_, index) => { const day = new Date(start); day.setDate(start.getDate() + index); return day; });
  }
  function eventsOn(dateKey) { return data.events.filter((event) => event.date === dateKey).sort((a, b) => a.time.localeCompare(b.time)); }
  function weekEvents() {
    const dates = weekDates(); const first = localDateKey(dates[0]); const last = localDateKey(dates[6]);
    return data.events.filter((event) => event.date >= first && event.date <= last).sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
  }
  function showToast(message) {
    const toast = $('#toast'); toast.textContent = message; toast.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('show'), 2500);
  }
  function setView(view) {
    currentView = view;
    $$('.view-panel').forEach((panel) => panel.classList.toggle('active', panel.id === `view-${view}`));
    $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === view));
    $('#breadcrumb-current').textContent = ({ overview: 'Overview', schedule: 'Schedule', invitations: 'Invitations', people: 'People' })[view] || 'Overview';
    if (view === 'schedule') renderSchedule();
    if (view === 'invitations') renderInvitations();
    if (view === 'people') renderPeople();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function renderHeader() {
    const now = new Date();
    $('#today-label').textContent = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(now);
    $('#greeting').textContent = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(now).toUpperCase();
    $('#schedule-count').textContent = String(data.events.length);
    const next = data.events.filter((event) => new Date(`${event.date}T${event.time}:00`) >= now).sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`))[0];
    $('#art-card-title').textContent = next?.title || 'Your next plan';
    $('#art-date').textContent = next ? new Date(`${next.date}T12:00:00`).getDate() : '—';
    $('#art-when').textContent = next ? `${dateWeekday(next.date)}, ${displayTime(next.time)}` : 'Make room for something good';
    updateSyncButton();
  }

  function renderStats() {
    const dates = weekDates(0); const first = localDateKey(dates[0]); const last = localDateKey(dates[6]);
    const events = data.events.filter((event) => event.date >= first && event.date <= last);
    $('#stat-events').textContent = events.length;
    $('#stat-invites').textContent = events.reduce((sum, event) => sum + event.guests.length, 0);
    const now = new Date();
    const upcoming = data.events.filter((event) => new Date(`${event.date}T${event.time}:00`) >= now).sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`))[0];
    if (!upcoming) {
      $('#stat-next').textContent = '—'; $('#stat-next-caption').textContent = 'your next moment together'; $('#stat-next-date').textContent = 'Add an event to get started';
    } else {
      $('#stat-next').textContent = displayTime(upcoming.time);
      $('#stat-next-caption').textContent = upcoming.title;
      $('#stat-next-date').textContent = `${prettyDate(upcoming.date, { weekday: 'short', month: 'short', day: 'numeric' })}${upcoming.location ? ` · ${upcoming.location}` : ''}`;
    }
  }

  function renderWeekStrip() {
    const dates = weekDates();
    const fmt = (date) => localDateKey(date);
    $('#week-label').textContent = weekOffset === 0 ? 'This week' : `${shortDate(fmt(dates[0]))} – ${shortDate(fmt(dates[6]))}`;
    $('#agenda-caption').textContent = weekOffset === 0 ? 'Your plans for the week ahead.' : 'Your plans for the week.';
    $('#week-strip').innerHTML = dates.map((date) => {
      const key = fmt(date); const today = key === localDateKey(new Date());
      return `<button class="day-chip ${key === selectedDate ? 'selected' : ''} ${eventsOn(key).length ? 'has-event' : ''}" data-date="${key}" aria-label="${escapeHtml(prettyDate(key))}${today ? ', today' : ''}"><span>${dateWeekday(key)}</span><strong>${date.getDate()}</strong><i class="day-dot"></i></button>`;
    }).join('');
    $$('#week-strip .day-chip').forEach((button) => button.addEventListener('click', () => { selectedDate = button.dataset.date; renderOverviewAgenda(); renderWeekStrip(); }));
  }

  function eventRow(event, index = 0) {
    const guests = event.guests || [];
    const guestStack = guests.length ? `<div class="event-guest-stack" title="${guests.length} ${guests.length === 1 ? 'guest' : 'guests'}">${guests.slice(0, 3).map((guest) => `<i>${escapeHtml(initials(guest.name))}</i>`).join('')}${guests.length > 3 ? `<i>+${guests.length - 3}</i>` : ''}</div>` : '<span></span>';
    const meta = [event.location || '', `${guests.length} ${guests.length === 1 ? 'guest' : 'guests'}`].filter(Boolean).map(escapeHtml).join('<span>·</span>');
    return `<article class="event-row"><div class="event-time"><strong>${escapeHtml(displayTime(event.time))}</strong>${escapeHtml(String(event.duration))} min</div><div class="event-accent ${COLORS[index % COLORS.length]}"></div><div class="event-detail"><div class="event-title-line"><h3>${escapeHtml(event.title)}</h3><span class="kind-tag">${escapeHtml(event.kind || 'Meeting')}</span></div><div class="event-meta">${meta}</div></div>${guestStack}</article>`;
  }

  function renderOverviewAgenda() {
    const list = eventsOn(selectedDate);
    $('#agenda-list').innerHTML = list.length ? list.map(eventRow).join('') : `<div class="agenda-empty"><strong>A little room in your day.</strong>No plans on ${escapeHtml(prettyDate(selectedDate, { weekday: 'long', month: 'short', day: 'numeric' }))} yet.<br /><button class="text-button" data-action="new-event" data-date="${selectedDate}">Make a plan <span>→</span></button></div>`;
    bindActions($('#agenda-list'));
  }

  function renderSchedule() {
    const dates = weekDates();
    const label = weekOffset === 0 ? 'This week' : `${prettyDate(localDateKey(dates[0]), { month: 'short', day: 'numeric' })} – ${prettyDate(localDateKey(dates[6]), { month: 'short', day: 'numeric' })}`;
    $('#schedule-week-label').textContent = label;
    const grouped = dates.map((date) => ({ date, key: localDateKey(date), events: eventsOn(localDateKey(date)) })).filter((entry) => entry.events.length);
    if (!grouped.length) {
      $('#schedule-list').innerHTML = `<div class="empty-state"><strong>A week with room to breathe.</strong><p>Nothing’s on the calendar for this week yet. Make a plan and invite the people who should be there.</p><button class="primary-button" data-action="new-event"><span class="plus">+</span> New event</button></div>`;
    } else {
      $('#schedule-list').innerHTML = grouped.map(({ date, key, events }) => `<section class="schedule-day"><header class="schedule-day-header"><strong>${escapeHtml(prettyDate(key))}</strong><span>· ${events.length} ${events.length === 1 ? 'plan' : 'plans'}</span>${key === localDateKey(new Date()) ? '<span class="today-tag">TODAY</span>' : ''}</header><div class="agenda-list">${events.map(eventRow).join('')}</div></section>`).join('');
    }
    bindActions($('#schedule-list'));
  }

  function buildMessage(event) {
    const when = `${prettyDate(event.date)} at ${displayTime(event.time)}`;
    const where = event.location ? `\nWhere: ${event.location}` : '';
    return `Hi! You’re invited to ${event.title}.\n\nWhen: ${when}${where}\n\nHope you can make it!`;
  }
  function mailtoLink(event, guest) {
    const subject = `You're invited: ${event.title}`;
    const message = buildMessage(event);
    return `mailto:${encodeURIComponent(guest.contact).replace(/%40/gi, '@')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(message)}`;
  }
  function smsLink(event, guest) {
    return `sms:${cleanPhone(guest.contact)}?body=${encodeURIComponent(buildMessage(event))}`;
  }
  function openInvite(event, guest, channel) {
    const type = channel === 'auto' ? guest.type : channel;
    if (type === 'phone') window.location.href = smsLink(event, guest);
    else window.location.href = mailtoLink(event, guest);
    showToast(`Opening ${type === 'phone' ? 'messages' : 'email'} for ${guest.name}…`);
  }
  function escapeIcs(value = '') { return String(value).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;'); }
  function downloadCalendar(event) {
    const start = event.startsAt ? new Date(event.startsAt) : new Date(`${event.date}T${event.time}:00`);
    const end = new Date(start.getTime() + Number(event.duration || 60) * 60000);
    const stamp = (date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//MeetPush//Schedule//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'BEGIN:VEVENT', `UID:${event.id}@meetpush.local`, `DTSTAMP:${stamp(new Date())}`, `DTSTART:${stamp(start)}`, `DTEND:${stamp(end)}`, `SUMMARY:${escapeIcs(event.title)}`, event.location ? `LOCATION:${escapeIcs(event.location)}` : '', `DESCRIPTION:${escapeIcs(`You're invited to ${event.title}.`)}`, 'END:VEVENT', 'END:VCALENDAR'].filter(Boolean).join('\r\n');
    const blob = new Blob([lines], { type: 'text/calendar;charset=utf-8' }); const url = URL.createObjectURL(blob); const link = document.createElement('a');
    link.href = url; link.download = `${event.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'meetpush-event'}.ics`; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast('Calendar file downloaded. Attach it to an email or open it to add the event.');
  }
  async function copyMessage(event) {
    try { await navigator.clipboard.writeText(buildMessage(event)); showToast('Invite message copied to clipboard.'); }
    catch { showToast('Clipboard access isn’t available in this browser.'); }
  }

  function renderInvitations() {
    const list = [...data.events].sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
    if (!list.length) { $('#invitation-list').innerHTML = '<div class="empty-state"><strong>Your invitations will live here.</strong><p>Create an event and add people by phone or email. Then choose how you want to invite them.</p><button class="primary-button" data-action="new-event"><span class="plus">+</span> New event</button></div>'; bindActions(); return; }
    $('#invitation-list').innerHTML = list.map((event) => `<article class="invitation-card"><div class="invitation-event-head"><div><h2 class="invitation-event-name">${escapeHtml(event.title)}</h2><div class="invitation-event-meta">${escapeHtml(prettyDate(event.date, { weekday: 'short', month: 'short', day: 'numeric' }))} · ${escapeHtml(displayTime(event.time))}${event.location ? ` · ${escapeHtml(event.location)}` : ''}</div></div><div class="invitation-actions"><button class="small-action" data-action="copy-message" data-event="${event.id}">Copy invite</button><button class="small-action" data-action="download-ics" data-event="${event.id}">↓ Calendar file</button><button class="small-action" data-action="delete-event" data-event="${event.id}">Remove</button></div></div><div class="guest-list">${event.guests.length ? event.guests.map((guest) => `<div class="guest-line"><span class="guest-avatar">${escapeHtml(initials(guest.name))}</span><span class="guest-data"><strong>${escapeHtml(guest.name)}</strong><small>${escapeHtml(guest.contact)}</small></span><span class="channel-badge">${guest.type === 'phone' ? 'PHONE' : 'EMAIL'}</span><div class="guest-actions">${guest.status === 'sent' ? '<span class="sent-label">Sent</span>' : ''}${guest.type === 'phone' ? `<button data-action="send-sms" data-event="${event.id}" data-guest="${guest.id}">${guest.status === 'sent' ? 'Send again' : 'Text'}</button>` : `<button data-action="send-email" data-event="${event.id}" data-guest="${guest.id}">${guest.status === 'sent' ? 'Send again' : 'Email'}</button>`}</div></div>`).join('') : '<span class="no-guest">No guests yet — you can still download a calendar file.</span>'}</div></article>`).join('');
    bindActions();
  }

  function getAllPeople() {
    const map = new Map();
    [...data.contacts, ...data.events.flatMap((event) => event.guests)].forEach((person) => {
      const key = String(person.contact || '').toLowerCase().replace(/[\s().-]/g, '');
      if (!key) return;
      if (!map.has(key)) map.set(key, { ...person, eventCount: 0 });
      if (person.id && data.events.some((event) => event.guests.some((guest) => guest.id === person.id))) map.get(key).eventCount += 1;
    });
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  function renderPeople() {
    const query = ($('#people-search').value || '').trim().toLowerCase();
    const people = getAllPeople().filter((person) => `${person.name} ${person.contact}`.toLowerCase().includes(query));
    $('#people-count').textContent = `${people.length} ${people.length === 1 ? 'person' : 'people'}`;
    $('#people-grid').innerHTML = people.length ? people.map((person) => `<article class="person-card"><span class="guest-avatar">${escapeHtml(initials(person.name))}</span><div class="person-info"><strong>${escapeHtml(person.name)}</strong><small>${escapeHtml(person.contact)}</small></div><button class="small-action" data-action="invite-person" data-contact="${escapeHtml(person.contact)}" title="Invite ${escapeHtml(person.name)}">Invite</button></article>`).join('') : `<div class="empty-state" style="grid-column:1/-1"><strong>${query ? 'No one by that name.' : 'Your people, all in one place.'}</strong><p>${query ? 'Try searching with another name, phone number, or email.' : 'People you invite to an event will show up here. You can also add someone now.'}</p>${query ? '' : '<button class="primary-button" data-action="add-person"><span class="plus">+</span> Add a person</button>'}</div>`;
    bindActions();
  }

  function openEventModal(date = '') {
    const modal = $('#event-modal'); modal.classList.add('open'); modal.setAttribute('aria-hidden', 'false');
    $('#event-date').value = date || localDateKey(new Date()); $('#event-time').value = '10:00'; $('#event-form').reset();
    $('#event-date').value = date || localDateKey(new Date()); $('#event-time').value = '10:00'; $('#form-error').textContent = '';
    setTimeout(() => $('#event-title').focus(), 30);
  }
  function closeModals() { $$('.modal-backdrop').forEach((modal) => { modal.classList.remove('open'); modal.setAttribute('aria-hidden', 'true'); }); }
  function parseGuests(text) {
    const entries = [...new Set(text.split(/[\n,;]+/).map((entry) => entry.trim()).filter(Boolean))];
    const invalid = entries.find((entry) => !contactType(entry));
    if (invalid) return { error: `“${invalid}” doesn’t look like a phone number or email address.` };
    return { guests: entries.map((contact) => {
      const type = contactType(contact); const existing = getAllPeople().find((person) => person.contact.toLowerCase().replace(/[\s().-]/g, '') === contact.toLowerCase().replace(/[\s().-]/g, ''));
      const inferredName = type === 'email' ? contact.split('@')[0].replace(/[._+-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()) : `Guest ·${cleanPhone(contact).slice(-4)}`;
      return { id: uid(), name: existing?.name || inferredName, contact, type, status: 'ready' };
    }) };
  }
  async function handleCreateEvent(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget); const parsed = parseGuests(String(form.get('guests') || ''));
    if (parsed.error) { $('#form-error').textContent = parsed.error; return; }
    const title = String(form.get('title') || '').trim(); const date = String(form.get('date') || ''); const time = String(form.get('time') || '');
    if (!title || !date || !time) { $('#form-error').textContent = 'Add an event name, date, and start time.'; return; }
    const newEvent = { id: uid(), title, date, time, duration: Number(form.get('duration') || 60), kind: String(form.get('kind') || 'Meeting'), location: String(form.get('location') || '').trim(), guests: parsed.guests };
    if (cloudUser) {
      const startsAt = new Date(`${date}T${time}:00`);
      if (Number.isNaN(startsAt.getTime())) { $('#form-error').textContent = 'That date and time could not be saved.'; return; }
      const { data: insertedEvent, error: eventError } = await supabaseClient.from('events').insert({
        owner_id: cloudUser.id, title, kind: newEvent.kind, starts_at: startsAt.toISOString(),
        duration_minutes: newEvent.duration, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', location: newEvent.location || null
      }).select().single();
      if (eventError) { $('#form-error').textContent = eventError.message || 'Could not save this event.'; return; }
      let savedGuests = [];
      if (parsed.guests.length) {
        const guestRows = parsed.guests.map((guest) => ({
          event_id: insertedEvent.id, owner_id: cloudUser.id, name: guest.name, contact: guest.contact,
          channel: guest.type === 'phone' ? 'sms' : 'email'
        }));
        const { data: insertedGuests, error: guestError } = await supabaseClient.from('event_guests').insert(guestRows).select();
        if (guestError) {
          await supabaseClient.from('events').delete().eq('id', insertedEvent.id);
          $('#form-error').textContent = guestError.message || 'Could not save the invite list. Please check the phone numbers and emails.';
          return;
        }
        savedGuests = (insertedGuests || []).map(remoteGuest);
      }
      Object.assign(newEvent, remoteEvent({ ...insertedEvent, event_guests: savedGuests.map((guest) => ({ ...guest, channel: guest.type === 'phone' ? 'sms' : 'email', sent_at: guest.sentAt })) }));
    }
    data.events.push(newEvent); persist(); closeModals(); weekOffset = 0; selectedDate = newEvent.date; renderAll(); setView('invitations');
    showToast(parsed.guests.length ? 'Event created. Your invitations are ready to send.' : 'Your event is on the schedule.');
  }

  function openPersonModal() { $('#person-modal').classList.add('open'); $('#person-modal').setAttribute('aria-hidden', 'false'); $('#person-error').textContent = ''; setTimeout(() => $('#person-name').focus(), 30); }
  async function handleAddPerson(event) {
    event.preventDefault(); const formElement = event.currentTarget; const form = new FormData(formElement); const name = String(form.get('name') || '').trim(); const contact = String(form.get('contact') || '').trim();
    const type = contactType(contact);
    if (!type) { $('#person-error').textContent = 'Enter a valid phone number or email address.'; return; }
    const duplicate = getAllPeople().find((person) => person.contact.toLowerCase().replace(/[\s().-]/g, '') === contact.toLowerCase().replace(/[\s().-]/g, ''));
    if (duplicate) { $('#person-error').textContent = `${duplicate.name} is already in your people list.`; return; }
    const person = { id: uid(), name, contact, type };
    if (cloudUser) {
      const { data: saved, error } = await supabaseClient.from('contacts').insert({ owner_id: cloudUser.id, name, contact, channel: type === 'phone' ? 'sms' : 'email' }).select().single();
      if (error) { $('#person-error').textContent = error.message || 'Could not save this person.'; return; }
      person.id = saved.id;
    }
    data.contacts.push(person); persist(); formElement.reset(); closeModals(); renderPeople(); showToast(`${name} added to your people.`);
  }

  async function sendInvitation(event, guest) {
    if (!cloudUser) { openInvite(event, guest, 'auto'); return; }
    const { data: result, error } = await supabaseClient.functions.invoke('send-invitation', { body: { eventId: event.id, guestId: guest.id } });
    let detail = result;
    if (error?.context?.json) { try { detail = await error.context.json(); } catch { /* Keep the invoke error below. */ } }
    if (detail?.error === 'provider_not_configured' || error?.context?.status === 503) {
      openInvite(event, guest, 'auto');
      showToast(`${guest.type === 'phone' ? 'SMS' : 'Email'} sending is not configured yet. Your app is ready to send the invite.`);
      return;
    }
    if (error || !result?.ok) {
      showToast(detail?.error === 'provider_failed' ? 'The delivery provider could not send this invite. Check its settings and try again.' : 'Could not send this invitation. Please try again.');
      return;
    }
    guest.status = 'sent'; guest.sentAt = new Date().toISOString(); renderAll();
    showToast(`Invitation sent to ${guest.name}.`);
  }

  async function handleAuthSubmit(event) {
    event.preventDefault(); $('#auth-error').textContent = '';
    const client = await ensureCloudClient();
    if (!client) { $('#auth-error').textContent = 'Cloud sign-in is unavailable. Open MeetPush from its published web address and try again.'; return; }
    const email = $('#auth-email').value.trim(); const password = $('#auth-password').value;
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) { $('#auth-error').textContent = error.message; return; }
    closeModals(); showToast('Signed in. Your schedule is syncing.');
  }
  async function handleAuthSignup() {
    $('#auth-error').textContent = '';
    const client = await ensureCloudClient();
    if (!client) { $('#auth-error').textContent = 'Cloud sign-in is unavailable. Open MeetPush from its published web address and try again.'; return; }
    const email = $('#auth-email').value.trim(); const password = $('#auth-password').value;
    if (!email || password.length < 8) { $('#auth-error').textContent = 'Enter an email and a password with at least 8 characters.'; return; }
    const { data: result, error } = await client.auth.signUp({ email, password });
    if (error) { $('#auth-error').textContent = error.message; return; }
    if (result.session) { closeModals(); showToast('Account created. Your schedule is syncing.'); }
    else { $('#auth-hint').textContent = 'Account created. Check your email for the confirmation link, then return here and sign in.'; showToast('Check your email to confirm your account.'); }
  }
  async function openAuthModal() {
    $('#auth-modal').classList.add('open'); $('#auth-modal').setAttribute('aria-hidden', 'false'); $('#auth-error').textContent = '';
    const client = await ensureCloudClient();
    if (!client) { $('#auth-hint').textContent = 'Cloud sign-in needs an internet connection and the published MeetPush address. Your current device can still use the local schedule.'; }
    const signedIn = Boolean(cloudUser);
    $('#auth-email').classList.toggle('hidden', signedIn);
    $('#auth-password').classList.toggle('hidden', signedIn);
    $('#auth-modal').querySelector('label[for="auth-password"]').classList.toggle('hidden', signedIn);
    $('#auth-modal').querySelector('label[for="auth-email"]').classList.toggle('hidden', signedIn);
    $('[data-auth-action="signup"]').classList.toggle('hidden', signedIn);
    $('#auth-submit').classList.toggle('hidden', signedIn);
    $('#auth-signout').classList.toggle('hidden', !signedIn);
    $('#auth-title').textContent = signedIn ? `Signed in as ${cloudUser.email || 'your account'}` : 'Sign in to MeetPush';
    $('#auth-hint').textContent = signedIn ? 'Your events and people are saved securely to your MeetPush account.' : 'Create an account to sync your events between devices. If email confirmation is enabled, confirm your address and return here to sign in.';
  }

  function bindActions(root = document) {
    $$('[data-action]', root).forEach((button) => {
      if (button.dataset.bound === 'true') return;
      button.dataset.bound = 'true';
      button.addEventListener('click', async () => {
        const action = button.dataset.action;
        if (action === 'new-event') openEventModal(button.dataset.date || '');
        else if (action === 'add-person') openPersonModal();
        else if (action === 'close-modal') closeModals();
        else if (action === 'auth-modal') openAuthModal();
        else if (action === 'signout') {
          const { error } = await supabaseClient.auth.signOut();
          if (error) { $('#auth-error').textContent = error.message; return; }
          closeModals(); showToast('Signed out of MeetPush.');
        }
        else if (action === 'download-ics') { const event = data.events.find((item) => item.id === button.dataset.event); if (event) downloadCalendar(event); }
        else if (action === 'copy-message') { const event = data.events.find((item) => item.id === button.dataset.event); if (event) copyMessage(event); }
        else if (action === 'send-sms' || action === 'send-email') { const event = data.events.find((item) => item.id === button.dataset.event); const guest = event?.guests.find((item) => item.id === button.dataset.guest); if (event && guest) await sendInvitation(event, guest); }
        else if (action === 'delete-event') {
          const event = data.events.find((item) => item.id === button.dataset.event);
          if (event && window.confirm(`Remove “${event.title}” from your schedule?`)) {
            if (cloudUser) {
              const { error } = await supabaseClient.from('events').delete().eq('id', event.id);
              if (error) { showToast('Could not remove this event. Please try again.'); return; }
            }
            data.events = data.events.filter((item) => item.id !== event.id); persist(); renderAll(); showToast('Event removed from your schedule.');
          }
        }
        else if (action === 'invite-person') { const contact = button.dataset.contact; closeModals(); openEventModal(); $('#event-guests').value = contact; }
      });
    });
  }

  function renderAll() { renderHeader(); renderStats(); renderWeekStrip(); renderOverviewAgenda(); renderSchedule(); renderInvitations(); renderPeople(); }
  function bindStaticEvents() {
    $$('.nav-item').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
    $$('[data-view-link]').forEach((button) => button.addEventListener('click', () => setView(button.dataset.viewLink)));
    $$('[data-week]').forEach((button) => button.addEventListener('click', () => {
      const direction = button.dataset.week;
      if (direction === 'today') { weekOffset = 0; selectedDate = localDateKey(new Date()); }
      else { weekOffset += direction === 'prev' ? -1 : 1; if (currentView === 'overview') selectedDate = localDateKey(weekDates()[0]); }
      renderWeekStrip(); renderOverviewAgenda(); renderSchedule();
    }));
    $('#event-form').addEventListener('submit', handleCreateEvent);
    $('#person-form').addEventListener('submit', handleAddPerson);
    $('#auth-form').addEventListener('submit', handleAuthSubmit);
    $('[data-auth-action="signup"]').addEventListener('click', handleAuthSignup);
    $('#people-search').addEventListener('input', renderPeople);
    $$('.modal-backdrop').forEach((backdrop) => backdrop.addEventListener('click', (event) => { if (event.target === backdrop) closeModals(); }));
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeModals(); });
    bindActions();
  }

  bindStaticEvents();
  renderAll();
  initializeCloud();
})();
