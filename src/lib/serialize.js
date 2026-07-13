import { xpProgress } from './levels.js';
import { db } from '../db/connection.js';

export function serializeUser(user, { includeContact = false } = {}) {
  if (!user) return null;
  const progress = xpProgress(user.xp);
  const company = user.company_id ? db.prepare('SELECT * FROM companies WHERE id = ?').get(user.company_id) : null;
  const ngo = user.ngo_id ? db.prepare('SELECT * FROM ngos WHERE id = ?').get(user.ngo_id) : null;
  const institution = user.institution_id ? db.prepare('SELECT * FROM institutions WHERE id = ?').get(user.institution_id) : null;
  return {
    id: user.id,
    name: user.name,
    avatar: user.avatar,
    mohalla: user.mohalla,
    city: user.city,
    xp: user.xp,
    level: progress.level,
    tier: progress.tier,
    tierColor: progress.tierColor,
    progressPct: progress.progressPct,
    xpIntoLevel: progress.xpIntoLevel,
    xpForNextLevel: progress.xpForNextLevel,
    karmaCoins: user.karma_coins,
    trustScore: user.trust_score,
    streakDays: user.streak_days,
    bio: user.bio || '',
    isAdmin: !!user.is_admin,
    isCsrAdmin: !!user.is_csr_admin,
    isNgoAdmin: !!user.is_ngo_admin,
    company: company ? serializeCompany(company) : null,
    ngo: ngo ? serializeNgo(ngo) : null,
    institution: institution ? serializeInstitution(institution) : null,
    skills: (user.skills || '').split(',').map((s) => s.trim()).filter(Boolean),
    lastSpinAt: user.last_spin_at,
    lastMatchAt: user.last_match_at,
    referralCode: user.referral_code,
    ...(includeContact ? { phone: user.phone } : {}),
  };
}

export function serializeCompany(c) {
  if (!c) return null;
  return {
    id: c.id,
    name: c.name,
    logo: c.logo,
    industry: c.industry,
    plan: c.plan,
    monthlyBudgetCoins: c.monthly_budget_coins,
    matchingRatePaisePerHour: c.matching_rate_paise_per_hour ?? 0,
    matchingRateRupeesPerHour: Math.round((c.matching_rate_paise_per_hour ?? 0) / 100),
  };
}

export function serializeNgo(n) {
  if (!n) return null;
  return {
    id: n.id,
    name: n.name,
    logo: n.logo,
    mission: n.mission,
    isPremium: !!n.is_premium,
    verified: !!n.verified,
  };
}

export function serializeCategory(cat) {
  return {
    id: cat.id,
    slug: cat.slug,
    name: cat.name,
    letter: cat.letter,
    description: cat.description,
    color: cat.color,
    icon: cat.icon,
  };
}

export function serializeQuest(quest, category) {
  return {
    id: quest.id,
    title: quest.title,
    description: quest.description,
    xpReward: quest.xp_reward,
    coinReward: quest.coin_reward,
    type: quest.type,
    difficulty: quest.difficulty,
    requiresGps: !!quest.requires_gps,
    requiresPhoto: !!quest.requires_photo,
    locationHint: quest.location_hint,
    isSponsored: !!quest.is_sponsored,
    sponsorName: quest.sponsor_name,
    ngoFeatured: !!quest.ngo_featured,
    estimatedMinutes: quest.estimated_minutes ?? 20,
    proofExampleHint: quest.proof_example_hint || null,
    site: quest.site_lat != null ? { lat: quest.site_lat, lng: quest.site_lng } : null,
    skillTags: (quest.skill_tags || '').split(',').map((s) => s.trim()).filter(Boolean),
    status: quest.status,
    category: category ? serializeCategory(category) : null,
  };
}

export function serializeCampaign(c) {
  return {
    id: c.id,
    title: c.title,
    description: c.description,
    icon: c.icon,
    color: c.color,
    bonusXp: c.bonus_xp,
    bonusCoins: c.bonus_coins,
    startsAt: c.starts_at,
    endsAt: c.ends_at,
    status: c.status,
  };
}

export function serializeProof(proof, { quest, user } = {}) {
  return {
    id: proof.id,
    questId: proof.quest_id,
    quest: quest ? { id: quest.id, title: quest.title, xpReward: quest.xp_reward, coinReward: quest.coin_reward } : undefined,
    userId: proof.user_id,
    user: user ? { id: user.id, name: user.name, avatar: user.avatar, mohalla: user.mohalla } : undefined,
    caption: proof.caption,
    photoPlaceholder: proof.photo_placeholder,
    mediaType: proof.media_type || null,
    mediaData: proof.media_data || null,
    gps: proof.gps_lat != null ? { lat: proof.gps_lat, lng: proof.gps_lng } : null,
    status: proof.status,
    upvoteCount: proof.upvote_count,
    flagCount: proof.flag_count,
    commentCount: proof.comment_count ?? 0,
    aiDuplicateFlag: !!proof.ai_duplicate_flag,
    aiFlagReason: proof.ai_flag_reason || null,
    aiVisionScore: proof.ai_vision_score ?? null,
    voiceNoteData: proof.voice_note_data || null,
    distanceMeters: proof.distance_meters ?? null,
    ngoVerified: !!proof.ngo_verified,
    witnessCount: proof.witness_count ?? 0,
    submittedAt: proof.submitted_at,
    reviewedAt: proof.reviewed_at,
  };
}

export function serializeWitnessRequest(w, { quest, requester, witness } = {}) {
  return {
    id: w.id,
    proofId: w.proof_id,
    status: w.status,
    note: w.note,
    rewardCoins: w.reward_coins,
    requestedAt: w.requested_at,
    confirmedAt: w.confirmed_at,
    quest: quest ? { id: quest.id, title: quest.title } : undefined,
    requester: requester ? { id: requester.id, name: requester.name, avatar: requester.avatar, mohalla: requester.mohalla } : undefined,
    witness: witness ? { id: witness.id, name: witness.name, avatar: witness.avatar } : undefined,
  };
}

export function serializeComment(c, user) {
  return {
    id: c.id,
    proofId: c.proof_id,
    text: c.text,
    createdAt: c.created_at,
    user: user ? { id: user.id, name: user.name, avatar: user.avatar } : undefined,
  };
}

export function serializeMessage(m) {
  return {
    id: m.id,
    conversationId: m.conversation_id,
    senderId: m.sender_id,
    text: m.text,
    createdAt: m.created_at,
    readAt: m.read_at,
  };
}

export function serializeTransaction(t) {
  return {
    id: t.id,
    direction: t.direction,
    amount: t.amount,
    description: t.description,
    redemptionOptionId: t.redemption_option_id,
    status: t.status,
    createdAt: t.created_at,
  };
}

export function serializeRedemption(r) {
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    coinCost: r.coin_cost,
    description: r.description,
    partnerName: r.partner_name,
    icon: r.icon,
  };
}

export function serializeBadge(b, earnedAt) {
  return { id: b.id, name: b.name, description: b.description, icon: b.icon, earnedAt: earnedAt ?? null };
}

export function serializeInstitution(i, { memberCount, isAdmin } = {}) {
  if (!i) return null;
  return {
    id: i.id,
    name: i.name,
    type: i.type,
    icon: i.icon,
    joinCode: i.join_code,
    memberCount: memberCount ?? undefined,
    isAdmin: isAdmin ?? undefined,
    createdAt: i.created_at,
  };
}

export function serializeCashoutRequest(c) {
  return {
    id: c.id,
    coins: c.coins,
    amountRupees: Math.round(c.amount_paise / 100),
    upiId: c.upi_id,
    status: c.status,
    adminNote: c.admin_note || null,
    requestedAt: c.requested_at,
    processedAt: c.processed_at,
  };
}

export function serializeKarmaCard(card, extra = {}) {
  return {
    id: card.id,
    name: card.name,
    rarity: card.rarity,
    art: card.art,
    description: card.description,
    color: card.color,
    ...extra,
  };
}

export function serializeVoucher(v, option) {
  return {
    id: v.id,
    code: v.code,
    status: v.status,
    issuedAt: v.issued_at,
    redeemedAt: v.redeemed_at,
    option: option ? { id: option.id, name: option.name, partnerName: option.partner_name, icon: option.icon } : undefined,
  };
}
