export async function getGameMaterials(platform, gameSlug) {
  if (typeof gameSlug !== 'string' || gameSlug.length > 200 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(gameSlug)) {
    return { error: '请提供有效的游戏标识。', code: 'INVALID_GAME_SLUG' };
  }
  const result = await platform.request(`/api/developer/game-materials/${encodeURIComponent(gameSlug)}`);
  if (!result || typeof result !== 'object' || Array.isArray(result)) return { error: '平台返回异常物料状态。', code: 'PLATFORM_ERROR' };
  if (result.error) return result;
  if (!result.game || !result.original || !Array.isArray(result.languages) || !result.covers) return { error: '平台返回不完整的物料状态。', code: 'PLATFORM_ERROR' };
  return result;
}

export async function fillGameMaterials(platform, gameSlug, input) {
  if (typeof gameSlug !== 'string' || gameSlug.length > 200 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(gameSlug)) {
    return { error: '请提供有效的游戏标识。', code: 'INVALID_GAME_SLUG' };
  }
  const result = await platform.request(`/api/developer/game-materials/${encodeURIComponent(gameSlug)}`, {
    method: 'PATCH', body: { ...(input?.titles ? { titles: input.titles } : {}), ...(input?.descriptions ? { descriptions: input.descriptions } : {}),
      ...(input?.genre !== undefined ? { genre: input.genre } : {}), ...(input?.tags !== undefined ? { tags: input.tags } : {}), fillMissing: true },
  });
  if (!result || typeof result !== 'object' || Array.isArray(result)) return { error: '平台返回异常物料保存结果。', code: 'PLATFORM_ERROR' };
  if (result.error) return result;
  if (result.ok !== true || !result.filled || !result.skipped) return { error: '平台返回不完整的物料保存结果。', code: 'PLATFORM_ERROR' };
  return result;
}
