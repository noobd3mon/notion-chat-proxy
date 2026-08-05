// Workspace rotation: createSpace -> poll getSpaces -> findNewSpace -> switch.
// No delete (delete is client-side only in Notion; no server API).
import { createSpace, getSpaces } from "./notion.js";
import { buildCreateSpaceBody, findNewSpace, nid } from "./transcript.js";
import { setActiveSpace } from "./store.js";

export async function rotateWorkspace({ env, kv, currentSpace, pollMs = 500 }) {
  const clientVersion = env.NOTION_CLIENT_VERSION;
  const body = buildCreateSpaceBody({ name: rotationName(), deviceId: nid() });
  // createSpace uses the OLD space as x-notion-space-id (matches the real capture).
  await createSpace({
    token: env.NOTION_TOKEN_V2, userId: currentSpace.userId,
    spaceId: currentSpace.spaceId, clientVersion, body,
  });
  // The new space can lag in getSpaces; poll a few times.
  let rec = null;
  for (let i = 0; i < 5; i++) {
    const gs = await getSpaces({
      token: env.NOTION_TOKEN_V2, userId: currentSpace.userId,
      spaceId: currentSpace.spaceId, clientVersion,
    });
    rec = findNewSpace(gs, currentSpace.spaceId);
    if (rec) break;
    if (pollMs > 0) await new Promise((r) => setTimeout(r, pollMs));
  }
  if (!rec) throw new Error("rotation failed: new space not found in getSpaces");
  await setActiveSpace(kv, rec);
  return rec;
}

function rotationName() {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return `AI Proxy ${stamp}`;
}
