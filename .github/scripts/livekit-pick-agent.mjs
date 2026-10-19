// deploy.yml voice-setup: which agent of the LiveKit Cloud project is SiteLog's, from the JSON of
// `lk agent list --json` (protojson: {"agents": [{"agentId", "agentName", …}]}). Prints the id of
// the agent whose dispatch name is LIVEKIT_AGENT_NAME, else of the only agent, else nothing (none
// yet: the job creates one). Exits 3 when several agents exist and none, or more than one, has
// that name: the job then stops rather than deploy over someone else's agent.
import { readFileSync } from 'node:fs';

const name = process.env.LIVEKIT_AGENT_NAME || 'sitelog-voice';
const raw = readFileSync(process.argv[2], 'utf8').trim();
const agents = (raw ? JSON.parse(raw).agents : null) ?? [];
const idOf = (a) => a.agentId ?? a.agent_id ?? '';
const named = agents.filter((a) => (a.agentName ?? a.agent_name) === name);
const pick =
  named.length === 1 ? named[0] : named.length === 0 && agents.length === 1 ? agents[0] : null;
if (!pick && agents.length > 0) {
  console.error(
    `${agents.length} agents, ${named.length} named ${name}: ${agents.map(idOf).join(', ')}`,
  );
  process.exit(3);
}
console.log(pick ? idOf(pick) : '');
