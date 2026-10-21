// Author configuration only. Player saves, sessions and scores never pass through this module.
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function endpoint(slug) {
  if (typeof slug !== 'string' || slug.length > 200 || !slugPattern.test(slug)) throw new Error('Invalid game slug');
  return `/api/developer/game-integrations/${encodeURIComponent(slug)}`;
}
export async function getGameIntegrations(platform, slug, { feature, boardId } = {}) {
  const path = endpoint(slug), query = new URLSearchParams();
  if (boardId !== undefined && feature !== 'leaderboards') throw new Error('A leaderboard ID requires the leaderboards feature');
  if (feature !== undefined) {
    if (!['cloud-saves', 'leaderboards'].includes(feature)) throw new Error('Invalid integration feature');
    query.set('feature', feature);
    if (feature === 'leaderboards') {
      if (!uuidPattern.test(boardId ?? '')) throw new Error('Select an existing leaderboard ID');
      query.set('boardId', boardId);
    }
  }
  return platform.request(path + (query.size ? `?${query}` : ''));
}
export async function configureCloudSaves(platform, slug, { enabled, schemaVersion }) {
  return platform.request(endpoint(slug), { method: 'PUT', body: { feature: 'cloud-saves', enabled, schemaVersion } });
}
export async function configureLeaderboard(platform, slug, action, board) {
  return platform.request(endpoint(slug), { method: 'POST', body: { feature: 'leaderboards', action, board } });
}
