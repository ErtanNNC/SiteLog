// Read-only diagnostics for the owner's phone check (deploy.yml, phone-setup, preview project only):
// field-api's recent requests and function errors from the log store, and the demo orgs' newest
// texts, device audit rows and devices through PostgREST. No phone number or text body is printed.
const ref = process.env.SUPABASE_PROJECT_REF;
const mgmt = { Authorization: `Bearer ${process.env.SUPABASE_ACCESS_TOKEN}` };
const rest = {
  apikey: process.env.SERVICE_KEY,
  Authorization: `Bearer ${process.env.SERVICE_KEY}`,
};
const start = new Date(Date.now() - 24 * 3600e3).toISOString();
const end = new Date().toISOString();

async function logs(sql) {
  const u = new URL(`https://api.supabase.com/v1/projects/${ref}/analytics/endpoints/logs`);
  u.searchParams.set('sql', sql);
  u.searchParams.set('iso_timestamp_start', start);
  u.searchParams.set('iso_timestamp_end', end);
  const r = await fetch(u, { headers: mgmt });
  const j = await r.json().catch(() => ({}));
  return r.ok ? (j.result ?? []) : [{ error: r.status, body: JSON.stringify(j).slice(0, 400) }];
}

async function get(path) {
  const r = await fetch(`https://${ref}.supabase.co/rest/v1/${path}`, { headers: rest });
  return r.ok ? r.json() : [{ error: r.status, body: (await r.text()).slice(0, 400) }];
}

function show(title, rows) {
  console.log(`\n=== ${title} (${rows.length}) ===`);
  for (const row of rows) console.log(JSON.stringify(row));
}

show(
  'field-api requests',
  await logs(
    "select timestamp, req.method, req.url, res.status_code from function_edge_logs cross join unnest(metadata) as m cross join unnest(m.request) as req cross join unnest(m.response) as res where req.url like '%field-api%' order by timestamp desc limit 40",
  ),
);
show(
  'function logs (non-info)',
  await logs(
    "select timestamp, m.function_id, m.level, substr(event_message, 0, 400) as msg from function_logs cross join unnest(metadata) as m where m.level != 'log' and m.level != 'info' order by timestamp desc limit 40",
  ),
);
show('demo orgs', await get('orgs?select=id,name,is_demo,country&is_demo=eq.true'));
show(
  'newest texts',
  await get(
    'messages?select=id,created_at,org_id,reporter_id,channel,direction,copy_key,provider,status,error&order=created_at.desc&limit=15',
  ),
);
show(
  'device audit',
  await get(
    'audit_log?select=created_at,org_id,action,entity,diff&action=like.device.*&order=created_at.desc&limit=20',
  ),
);
show(
  'field devices',
  await get(
    'field_devices?select=reporter_id,verified_at,last_seen_at,code_expires_at&order=last_seen_at.desc.nullslast&limit=10',
  ),
);
show(
  'Marco',
  await get(`reporters?select=id,org_id,name,status,message_channel&name=eq.Marco%20Ruiz`),
);

// Talk now (W3-13): the newest calls, LiveKit's webhooks and the voice requests. Phone-number
// fields are dropped before printing.
const noPhones = (rows) =>
  rows.map((row) =>
    Object.fromEntries(Object.entries(row).filter(([k]) => !/e164|phone|number|caller/i.test(k))),
  );
show('calls', noPhones(await get('calls?select=*&order=created_at.desc&limit=5')));
show(
  'livekit events',
  noPhones(await get('livekit_events?select=*&order=created_at.desc&limit=15')),
);
show(
  'voice requests',
  await logs(
    "select timestamp, req.method, req.url, res.status_code from function_edge_logs cross join unnest(metadata) as m cross join unnest(m.request) as req cross join unnest(m.response) as res where req.url like '%/voice%' or req.url like '%voice-events%' order by timestamp desc limit 40",
  ),
);
show(
  'voice function logs',
  await logs(
    "select timestamp, m.function_id, m.level, substr(event_message, 0, 600) as msg from function_logs cross join unnest(metadata) as m where event_message like '%voice%' or event_message like '%call%' or event_message like '%livekit%' order by timestamp desc limit 40",
  ),
);
