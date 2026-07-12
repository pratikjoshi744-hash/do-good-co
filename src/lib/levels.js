// Gamification rules: XP -> level number -> tier name, mirroring the pitch deck's
// Sevak -> Karma Hero -> Dharma Guardian progression, with 5 numbered levels per tier.

const XP_PER_LEVEL = 150;

export const TIERS = [
  { name: 'Sevak', minLevel: 1, maxLevel: 5, color: '#6EE7B7' },
  { name: 'Karma Hero', minLevel: 6, maxLevel: 15, color: '#FBBF24' },
  { name: 'Dharma Guardian', minLevel: 16, maxLevel: 999, color: '#F472B6' },
];

export function levelForXp(xp) {
  return Math.max(1, Math.floor(xp / XP_PER_LEVEL) + 1);
}

export function tierForLevel(level) {
  return TIERS.find((t) => level >= t.minLevel && level <= t.maxLevel) ?? TIERS[TIERS.length - 1];
}

export function xpProgress(xp) {
  const level = levelForXp(xp);
  const currentLevelFloor = (level - 1) * XP_PER_LEVEL;
  const nextLevelCeiling = level * XP_PER_LEVEL;
  const tier = tierForLevel(level);
  return {
    xp,
    level,
    tier: tier.name,
    tierColor: tier.color,
    xpIntoLevel: xp - currentLevelFloor,
    xpForNextLevel: XP_PER_LEVEL,
    xpToNextLevel: nextLevelCeiling - xp,
    progressPct: Math.round(((xp - currentLevelFloor) / XP_PER_LEVEL) * 100),
  };
}
