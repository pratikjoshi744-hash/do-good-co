import { randomUUID } from 'node:crypto';
import { db, tableIsEmpty } from './connection.js';
import { initSchema } from './schema.js';

const CATEGORIES = [
  { slug: 'seva', name: 'Seva', letter: 'S', color: '#F97316', icon: '🤲', description: 'Feed strangers, help elders, assist disabled' },
  { slug: 'prakriti', name: 'Prakriti', letter: 'P', color: '#22C55E', icon: '🌱', description: 'Plant saplings, clean beaches, reduce plastic' },
  { slug: 'gyan-daan', name: 'Gyan Daan', letter: 'G', color: '#3B82F6', icon: '📚', description: 'Teach literacy, digital skills, tutor kids' },
  { slug: 'swasthya', name: 'Swasthya', letter: 'S', color: '#EC4899', icon: '❤️', description: 'Blood donation, health camps, mental wellness' },
  { slug: 'ahimsa', name: 'Ahimsa', letter: 'A', color: '#14B8A6', icon: '🐾', description: 'Feed strays, adopt animals, wildlife care' },
  { slug: 'swachh', name: 'Swachh', letter: 'S', color: '#06B6D4', icon: '🧹', description: 'Clean mohalla, waste segregation, fix roads' },
  { slug: 'maitri', name: 'Maitri', letter: 'M', color: '#8B5CF6', icon: '🤝', description: 'Visit lonely neighbours, befriend migrants' },
  { slug: 'kala', name: 'Kala', letter: 'K', color: '#F59E0B', icon: '🎨', description: 'Teach art/music, perform at old-age homes' },
  { slug: 'pragati', name: 'Pragati', letter: 'P', color: '#6366F1', icon: '💻', description: 'Tech help for elders, digital literacy drives' },
  { slug: 'nagrik', name: 'Nagrik', letter: 'N', color: '#EF4444', icon: '🏛️', description: 'Report potholes, attend sabha, voter drives' },
];

// The app isn't hardcoded to a single city — `city` and `mohalla` are plain
// text fields set per user, filtered by exact string match everywhere they're
// used (feed scope, leaderboard, etc). This seed spreads demo citizens across
// several cities to prove that out; a real signup flow would just ask the
// user for their own city/neighborhood instead of picking from this list.
const CITIES = {
  Pune: ['Kothrud', 'Baner', 'Aundh', 'Camp', 'Deccan Gymkhana', 'Viman Nagar', 'Hadapsar', 'Katraj'],
  Mumbai: ['Andheri', 'Bandra', 'Powai', 'Dadar'],
  Bengaluru: ['Indiranagar', 'Koramangala', 'Whitefield', 'HSR Layout'],
  Delhi: ['Hauz Khas', 'Dwarka', 'Saket', 'Rohini'],
};
const CITY_NAMES = Object.keys(CITIES);
// Flat list of every neighborhood across every city — used where a location
// just needs to feel real (quest location hints, feed activity pings)
// without needing to track which city it belongs to.
const MOHALLAS = Object.values(CITIES).flat();

function pickLocation() {
  const city = pick(CITY_NAMES);
  return { city, mohalla: pick(CITIES[city]) };
}

// Approximate city-center coordinates — matches the client's GPS-fallback
// simulation (see QuestDetail.js CITY_COORDS) so a quest's "site" and a
// user's simulated location land in the same real-world neighborhood,
// making the GPS-radius check in the proof flow a genuine (if approximate)
// distance calculation rather than pure theatre.
const CITY_COORDS = {
  Pune: [18.52, 73.85],
  Mumbai: [19.08, 72.88],
  Bengaluru: [12.97, 77.59],
  Delhi: [28.61, 77.21],
};
function siteCoordsFor(city) {
  const [lat, lng] = CITY_COORDS[city] || [22.35, 78.67];
  // Jitter within roughly a 1-2km box so quests in the same city aren't
  // literally stacked on the same point.
  return { lat: lat + (Math.random() - 0.5) * 0.02, lng: lng + (Math.random() - 0.5) * 0.02 };
}

// Corporate CSR clients — matches the deck's GTM target list (Tata, HDFC, Infosys
// Foundation, Amul) and revenue model (sponsored quests, CSR Dashboard SaaS).
const COMPANIES = [
  { slug: 'tata-salt', name: 'Tata Salt', logo: '🧂', industry: 'FMCG', monthly_budget_coins: 40000 },
  { slug: 'hdfc-bank', name: 'HDFC Bank', logo: '🏦', industry: 'Banking & Finance', monthly_budget_coins: 60000 },
  { slug: 'infosys-foundation', name: 'Infosys Foundation', logo: '💡', industry: 'CSR Foundation', monthly_budget_coins: 50000 },
  { slug: 'amul', name: 'Amul', logo: '🥛', industry: 'FMCG', monthly_budget_coins: 30000 },
];

// Sponsored quests tied to a company, layered on top of QUESTS_BY_CATEGORY below.
// [companySlug, categorySlug, title, description, xp, coins, type]
const SPONSORED_QUESTS = [
  ['tata-salt', 'seva', 'Feed 5 People Quest', "Tata Salt's flagship CSR quest: distribute a wholesome meal to 5 people in need.", 45, 90, 'weekly'],
  ['hdfc-bank', 'pragati', 'Financial Literacy for a Vendor', 'Help a local shopkeeper set up UPI and understand digital banking basics.', 40, 85, 'weekly'],
  ['infosys-foundation', 'gyan-daan', 'Code Club for Kids', "Run a beginner coding or digital-skills session for underprivileged students.", 65, 120, 'weekly'],
  ['amul', 'swasthya', 'Milk & Nutrition Drive', 'Distribute milk/nutrition kits at a local health or anganwadi camp.', 50, 100, 'weekly'],
];

// NGO partners — from the deck's GTM slide (Jnana Prabodhini, SWaCH) plus the two
// donation partners already used in the redemption catalog. Drives "NGO Premium
// Listings" (featured quests) and "NGO Verified Badges" (trust engine) revenue.
const NGOS = [
  { slug: 'jnana-prabodhini', name: 'Jnana Prabodhini', logo: '📘', mission: 'Education and youth development across Pune', is_premium: 1 },
  { slug: 'swach', name: 'SWaCH', logo: '♻️', mission: "Pune's waste-picker cooperative driving Swachh Bharat on the ground", is_premium: 1 },
  { slug: 'akshaya-patra', name: 'Akshaya Patra Foundation', logo: '🍛', mission: 'Mid-day meals for underprivileged children', is_premium: 0 },
  { slug: 'cry', name: 'CRY - Child Rights and You', logo: '📖', mission: "Protecting children's right to education and safety", is_premium: 0 },
];

// [ngoSlug, categorySlug, title, description, xp, coins, type, featured]
const NGO_QUESTS = [
  ['jnana-prabodhini', 'gyan-daan', 'Weekend Tutoring Circle', 'Join a Jnana Prabodhini-run weekend tutoring session for local students.', 55, 100, 'weekly', 1],
  ['swach', 'swachh', 'SWaCH Segregation Drive', 'Support SWaCH waste-pickers with a door-to-door dry/wet waste segregation drive.', 45, 85, 'weekly', 1],
];

const NAMES = [
  'Aarav Kulkarni', 'Ishita Deshpande', 'Vivaan Joshi', 'Ananya Patil', 'Kabir Shah',
  'Diya Kelkar', 'Arjun Bhosale', 'Myra Gokhale', 'Reyansh Pawar', 'Saanvi Naik',
  'Aditya Mane', 'Anika Chavan', 'Vihaan Sane', 'Riya Apte', 'Krishna Jadhav',
  'Sara Kale', 'Ayaan Phadke', 'Zara Wagh', 'Dhruv Nikam', 'Kiara Ranade',
  'Ibrahim Sheikh', 'Priya Menon', 'Rohan Iyer', 'Neha Kapoor',
];

export const AVATARS = ['🧑', '👩', '🧔', '👨', '👩‍🦱', '🧑‍🦳', '👨‍🦰', '👩‍🦰', '🧑‍🎓', '👨‍💼', '👩‍💼', '🧑‍🏫'];

const BADGES = [
  { id: 'first-deed', name: 'First Deed', description: 'Completed your first quest', icon: '🌟' },
  { id: 'streak-7', name: '7-Day Streak', description: '7 days of good deeds in a row', icon: '🔥' },
  { id: 'century', name: 'Century Club', description: 'Crossed 100 XP', icon: '💯' },
  { id: 'mohalla-champion', name: 'Mohalla Champion', description: '#1 on your mohalla leaderboard', icon: '🏆' },
  { id: 'trusted-verifier', name: 'Trusted Verifier', description: 'Upvoted 25+ community proofs', icon: '🛡️' },
  { id: 'festival-hero', name: 'Festival Hero', description: 'Completed a festival special quest', icon: '🪔' },
  { id: 'green-thumb', name: 'Green Thumb', description: 'Completed 5 Prakriti quests', icon: '🌿' },
  { id: 'gyan-guru', name: 'Gyan Guru', description: 'Completed 5 Gyan Daan quests', icon: '🎓' },
];

const REDEMPTIONS = [
  { id: 'upi-10', name: 'UPI Cashback ₹10', type: 'upi', coin_cost: 100, description: 'Instant UPI transfer to your linked account', partner_name: 'Razorpay UPI', icon: '💸' },
  { id: 'upi-50', name: 'UPI Cashback ₹50', type: 'upi', coin_cost: 450, description: 'Instant UPI transfer to your linked account', partner_name: 'Razorpay UPI', icon: '💸' },
  { id: 'upi-100', name: 'UPI Cashback ₹100', type: 'upi', coin_cost: 850, description: 'Instant UPI transfer to your linked account', partner_name: 'Razorpay UPI', icon: '💸' },
  { id: 'ngo-akshaya', name: 'Donate to Akshaya Patra', type: 'ngo', coin_cost: 200, description: 'Fund a mid-day meal for a child', partner_name: 'Akshaya Patra Foundation', icon: '🍛' },
  { id: 'ngo-cry', name: 'Donate to CRY', type: 'ngo', coin_cost: 200, description: "Support a child's education", partner_name: 'CRY - Child Rights and You', icon: '📖' },
  { id: 'voucher-swiggy', name: 'Swiggy Voucher ₹100', type: 'voucher', coin_cost: 900, description: 'Redeemable on your next Swiggy order', partner_name: 'Swiggy', icon: '🍔' },
  { id: 'voucher-amazon', name: 'Amazon Voucher ₹100', type: 'voucher', coin_cost: 900, description: 'Amazon.in gift voucher', partner_name: 'Amazon', icon: '🛒' },
  { id: 'voucher-zomato', name: 'Zomato Voucher ₹50', type: 'voucher', coin_cost: 500, description: 'Redeemable on your next Zomato order', partner_name: 'Zomato', icon: '🍕' },
];

const PROMO_CODES = [
  { code: 'WELCOME50', coin_bonus: 50, description: 'New citizen welcome bonus', max_uses: null, expires_at: null },
  { code: 'DOGOOD100', coin_bonus: 100, description: 'Launch campaign bonus', max_uses: 500, expires_at: null },
  { code: 'MOHALLA25', coin_bonus: 25, description: 'Community drive bonus', max_uses: null, expires_at: null },
];

const QUESTS_BY_CATEGORY = {
  seva: [
    ['Feed 5 Strangers', 'Distribute food to 5 people in need near your area.', 40, 'daily', 'easy'],
    ['Help an Elder Cross Traffic', 'Assist an elderly person safely crossing a busy road.', 15, 'daily', 'easy'],
    ['Assist a Person with Disability', 'Help someone with a disability with daily tasks or mobility.', 25, 'daily', 'medium'],
    ['Weekly Langar Volunteer', 'Volunteer at a community kitchen or langar for 2 hours.', 90, 'weekly', 'medium'],
  ],
  prakriti: [
    ['Plant a Sapling', 'Plant a native tree sapling in your neighbourhood or a park.', 50, 'daily', 'easy'],
    ['Beach or Riverbank Cleanup', 'Join or organise a cleanup drive along a water body.', 80, 'weekly', 'medium'],
    ['Say No to Single-Use Plastic', 'Swap single-use plastic for reusable alternatives for a full day.', 20, 'daily', 'easy'],
    ['Compost Kitchen Waste', 'Start or contribute to a home/community composting setup.', 35, 'weekly', 'medium'],
  ],
  'gyan-daan': [
    ['Tutor a Child for an Hour', 'Teach basic literacy or numeracy to an underprivileged child.', 60, 'daily', 'medium'],
    ['Digital Literacy Session', "Teach someone how to use a smartphone or apps safely.", 45, 'weekly', 'medium'],
    ['Donate Old Books', 'Donate school books or story books to a library or NGO.', 20, 'daily', 'easy'],
    ['Career Guidance Talk', 'Give a short career/skills talk at a local school or college.', 70, 'weekly', 'hard'],
  ],
  swasthya: [
    ['Donate Blood', 'Donate blood at a certified blood bank or camp.', 100, 'weekly', 'medium'],
    ['Attend/Host a Health Camp', 'Participate in or help organise a free health check-up camp.', 70, 'weekly', 'medium'],
    ['Mental Wellness Check-in', 'Have a genuine wellbeing conversation with someone who seems low.', 25, 'daily', 'easy'],
    ['Diwali Health Camp Special', 'Volunteer at a festival season health and eye check-up camp.', 90, 'festival', 'medium'],
  ],
  ahimsa: [
    ['Feed Street Animals', 'Feed stray dogs, cats or cows in your area.', 25, 'daily', 'easy'],
    ['Assist an Animal Rescue', 'Help transport or care for an injured street animal.', 55, 'weekly', 'medium'],
    ['Set Up a Water Bowl', 'Place a water bowl for birds/strays during summer.', 15, 'daily', 'easy'],
    ['Volunteer at Animal Shelter', 'Spend 2 hours helping at a local animal shelter.', 65, 'weekly', 'medium'],
  ],
  swachh: [
    ['Clean Your Mohalla Street', 'Sweep and clear litter from your street or lane.', 30, 'daily', 'easy'],
    ['Waste Segregation Drive', 'Help neighbours set up wet/dry waste segregation at home.', 40, 'weekly', 'medium'],
    ['Report & Fix a Pothole', 'Report a pothole to civic authorities and follow up on it.', 35, 'daily', 'easy'],
    ['Swachh Bharat Sunday', 'Join the weekly community-wide mohalla cleanliness drive.', 60, 'weekly', 'medium'],
  ],
  maitri: [
    ['Visit a Lonely Neighbour', 'Spend time with an elderly or isolated neighbour.', 30, 'daily', 'easy'],
    ['Welcome a Migrant Family', 'Help a newly moved family settle into your building/street.', 40, 'weekly', 'medium'],
    ['Host a Mohalla Chai Meetup', 'Organise an informal tea meetup to build street camaraderie.', 50, 'weekly', 'medium'],
    ['Eid Charity Connect', 'Share a festival meal with a neighbour from another community.', 45, 'festival', 'easy'],
  ],
  kala: [
    ['Teach Music or Art', 'Give a free art, music or dance lesson to kids.', 45, 'weekly', 'medium'],
    ['Perform at an Old-Age Home', 'Organise or join a performance for senior citizens.', 55, 'weekly', 'medium'],
    ['Street Art for a Cause', 'Paint a wall mural promoting a civic or social message.', 70, 'weekly', 'hard'],
    ['Diwali Rangoli for Elders', "Make a festive rangoli at an elder's home or old-age facility.", 35, 'festival', 'easy'],
  ],
  pragati: [
    ['Tech Help for an Elder', 'Help a senior citizen with UPI, video calls or online forms.', 25, 'daily', 'easy'],
    ['Digital Literacy Drive', 'Run a group session teaching smartphone basics to non-tech users.', 55, 'weekly', 'medium'],
    ['Help Someone Get Aadhaar/PAN Online', 'Assist with an online government service application.', 30, 'daily', 'easy'],
    ['Set Up UPI for a Local Vendor', 'Help a small shopkeeper start accepting UPI payments.', 40, 'daily', 'medium'],
  ],
  nagrik: [
    ['Report a Civic Issue', 'Report a broken streetlight, pothole or leak via the civic app.', 20, 'daily', 'easy'],
    ['Attend a Mohalla Sabha', 'Attend your local ward/RWA meeting and note action items.', 35, 'weekly', 'easy'],
    ['Voter Awareness Drive', 'Help first-time voters complete registration or verify rolls.', 50, 'weekly', 'medium'],
    ['Republic Day Civic Pledge', 'Organise a civic responsibility pledge event in your mohalla.', 60, 'festival', 'medium'],
  ],
};

export function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Rough time-to-complete per difficulty, and a category-specific example of
// what a good proof photo looks like — shown on the quest detail page and
// during capture so "prove it" has a concrete target instead of a blank
// camera screen. Deliberately per-category rather than per-quest: keeps this
// maintainable while still being far more specific than a generic hint.
const ESTIMATED_MINUTES_BY_DIFFICULTY = { easy: 10, medium: 25, hard: 45 };
const PROOF_HINTS_BY_CATEGORY = {
  seva: 'A clear photo of you actively helping — the person or group you assisted should be visible (blur faces if you want to protect their privacy).',
  prakriti: 'A before/after or in-progress shot of the environmental action — the sapling in the ground, the cleaned water body, the compost bin.',
  'gyan-daan': 'A photo of the teaching moment itself, or the books/materials being handed over.',
  swasthya: 'A photo at the camp or blood bank, or of the wellness conversation in progress — no medical documents or ID cards.',
  ahimsa: 'A photo of the animal being fed or helped, with the food or care setup clearly visible.',
  swachh: 'A before/after shot of the cleaned area — litter removed, waste segregated, pothole reported.',
  maitri: 'A photo of the shared moment — tea, conversation, or welcome gesture with your neighbour.',
  kala: 'A photo or short clip of the performance, lesson, or artwork actually in progress.',
  pragati: 'A photo of the tech help in action — the screen, device, or person you assisted.',
  nagrik: 'A screenshot of the civic report you filed, or a photo from the meeting/drive.',
};
function proofHintFor(slug) {
  return PROOF_HINTS_BY_CATEGORY[slug] || 'A clear photo showing the deed was actually completed, taken at the location.';
}
function estimatedMinutesFor(difficulty) {
  return ESTIMATED_MINUTES_BY_DIFFICULTY[difficulty] || 20;
}
function randomSite() {
  return siteCoordsFor(pick(CITY_NAMES));
}

// Short, shareable referral codes (e.g. "K7F3QX") - every user gets one so
// the Invite feature always has something to share, even for seeded demo
// personas. Uniqueness only matters within a single process/DB, so a short
// random alphabet plus a live "seen" set is plenty.
const REFERRAL_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I - avoids visual ambiguity
const usedReferralCodes = new Set();
let referralCodesPrimed = false;
function primeReferralCodes() {
  if (referralCodesPrimed) return;
  referralCodesPrimed = true;
  try {
    for (const row of db.prepare(`SELECT referral_code FROM users WHERE referral_code IS NOT NULL`).all()) {
      usedReferralCodes.add(row.referral_code);
    }
  } catch { /* users table may not exist yet on a brand-new DB - fine */ }
}
export function genReferralCode() {
  primeReferralCodes();
  let code;
  do {
    code = Array.from({ length: 6 }, () => REFERRAL_ALPHABET[Math.floor(Math.random() * REFERRAL_ALPHABET.length)]).join('');
  } while (usedReferralCodes.has(code));
  usedReferralCodes.add(code);
  return code;
}

function daysAgoIso(days, hourOffset = 0) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(d.getHours() - hourOffset);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

// Dummy media for the seeded proof feed — makes the app feel alive on first
// login instead of an empty/emoji-only feed. Second generation of this pool:
// swapped away from the original MDN/w3schools sample clips + plain Picsum
// seeds (repetitive, and a couple of the original clip URLs proved flaky)
// to Google's long-stable public GTV sample-video bucket for video, and a
// wider spread of Picsum seeds (including a grayscale/blur mix for visual
// variety) for photos. A real deploy replaces all of this with actual user
// uploads over time — this only exists so a fresh install doesn't look empty.
const SAMPLE_VIDEOS = [
  'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoyrides.mp4',
  'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerFun.mp4',
  'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4',
  'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
];

let mediaCounter = 0;
// Every ~4th proof becomes a "reel" (video) so the Reels tab has content;
// the rest get a deterministic dummy photo. Seeds use a fresh namespace
// ("dgc2-") so every generated photo differs from the previous media pool
// even where the counter values overlap.
function pickMedia() {
  mediaCounter += 1;
  const seed = `dgc2-${mediaCounter}-${Math.random().toString(36).slice(2, 8)}`;
  if (mediaCounter % 4 === 0) {
    return { media_type: 'video', media_data: SAMPLE_VIDEOS[mediaCounter % SAMPLE_VIDEOS.length] };
  }
  const grayscale = mediaCounter % 7 === 0 ? '?grayscale' : '';
  return { media_type: 'image', media_data: `https://picsum.photos/seed/${seed}/800/1000${grayscale}` };
}

export function seedIfEmpty() {
  initSchema();
  if (!tableIsEmpty('users')) {
    return { seeded: false };
  }

  const insertUser = db.prepare(`
    INSERT INTO users (id, name, phone, avatar, mohalla, city, xp, karma_coins, trust_score, streak_days, is_admin, is_csr_admin, is_ngo_admin, company_id, ngo_id, referral_code, created_at)
    VALUES (@id, @name, @phone, @avatar, @mohalla, @city, @xp, @karma_coins, @trust_score, @streak_days, @is_admin, @is_csr_admin, @is_ngo_admin, @company_id, @ngo_id, @referral_code, @created_at)
  `);
  const insertCompany = db.prepare(`
    INSERT INTO companies (id, name, logo, industry, plan, monthly_budget_coins) VALUES (@id, @name, @logo, @industry, @plan, @monthly_budget_coins)
  `);
  const insertNgo = db.prepare(`
    INSERT INTO ngos (id, name, logo, mission, is_premium, verified) VALUES (@id, @name, @logo, @mission, @is_premium, 1)
  `);
  const insertCategory = db.prepare(`
    INSERT INTO categories (id, slug, name, letter, description, color, icon) VALUES (@id, @slug, @name, @letter, @description, @color, @icon)
  `);
  const insertQuest = db.prepare(`
    INSERT INTO quests (id, category_id, title, description, xp_reward, coin_reward, type, difficulty, requires_gps, requires_photo, location_hint, is_sponsored, sponsor_name, company_id, ngo_id, ngo_featured, estimated_minutes, proof_example_hint, site_lat, site_lng, status)
    VALUES (@id, @category_id, @title, @description, @xp_reward, @coin_reward, @type, @difficulty, @requires_gps, @requires_photo, @location_hint, @is_sponsored, @sponsor_name, @company_id, @ngo_id, @ngo_featured, @estimated_minutes, @proof_example_hint, @site_lat, @site_lng, @status)
  `);
  const insertCampaign = db.prepare(`
    INSERT INTO campaigns (id, title, description, icon, color, bonus_xp, bonus_coins, starts_at, ends_at, status)
    VALUES (@id, @title, @description, @icon, @color, @bonus_xp, @bonus_coins, @starts_at, @ends_at, @status)
  `);
  const insertCampaignQuest = db.prepare(`INSERT INTO campaign_quests (id, campaign_id, quest_id, sort_order) VALUES (@id, @campaign_id, @quest_id, @sort_order)`);
  const insertBadge = db.prepare(`INSERT INTO badges (id, name, description, icon) VALUES (@id, @name, @description, @icon)`);
  const insertUserBadge = db.prepare(`INSERT INTO user_badges (id, user_id, badge_id, earned_at) VALUES (@id, @user_id, @badge_id, @earned_at)`);
  const insertRedemption = db.prepare(`
    INSERT INTO redemption_options (id, name, type, coin_cost, description, partner_name, icon, status)
    VALUES (@id, @name, @type, @coin_cost, @description, @partner_name, @icon, 'active')
  `);
  const insertPromoCode = db.prepare(`
    INSERT INTO promo_codes (id, code, coin_bonus, description, max_uses, expires_at, status)
    VALUES (@id, @code, @coin_bonus, @description, @max_uses, @expires_at, 'active')
  `);
  const insertProof = db.prepare(`
    INSERT INTO proofs (id, quest_id, user_id, caption, photo_placeholder, media_type, media_data, gps_lat, gps_lng, status, upvote_count, flag_count, comment_count, ai_duplicate_flag, submitted_at, reviewed_at, reviewed_by)
    VALUES (@id, @quest_id, @user_id, @caption, @photo_placeholder, @media_type, @media_data, @gps_lat, @gps_lng, @status, @upvote_count, @flag_count, @comment_count, @ai_duplicate_flag, @submitted_at, @reviewed_at, @reviewed_by)
  `);
  const insertComment = db.prepare(`INSERT INTO comments (id, proof_id, user_id, text, created_at) VALUES (@id, @proof_id, @user_id, @text, @created_at)`);
  const insertConversation = db.prepare(`
    INSERT INTO conversations (id, user_a_id, user_b_id, last_message_at, created_at) VALUES (@id, @user_a_id, @user_b_id, @last_message_at, @created_at)
  `);
  const insertMessage = db.prepare(`
    INSERT INTO messages (id, conversation_id, sender_id, text, created_at, read_at) VALUES (@id, @conversation_id, @sender_id, @text, @created_at, @read_at)
  `);
  const insertUpvote = db.prepare(`INSERT OR IGNORE INTO upvotes (id, proof_id, user_id, created_at) VALUES (@id, @proof_id, @user_id, @created_at)`);
  const insertFlag = db.prepare(`INSERT OR IGNORE INTO flags (id, proof_id, user_id, reason, created_at) VALUES (@id, @proof_id, @user_id, @reason, @created_at)`);
  const insertTx = db.prepare(`
    INSERT INTO wallet_transactions (id, user_id, direction, amount, description, related_proof_id, redemption_option_id, status, created_at)
    VALUES (@id, @user_id, @direction, @amount, @description, @related_proof_id, @redemption_option_id, @status, @created_at)
  `);

  const tx = db.exec.bind(db);
  tx('BEGIN');

  // Categories
  const categoryIds = {};
  for (const c of CATEGORIES) {
    const id = randomUUID();
    categoryIds[c.slug] = id;
    insertCategory.run({ id, ...c });
  }

  // CSR client companies
  const companyIds = {};
  for (const c of COMPANIES) {
    const id = randomUUID();
    companyIds[c.slug] = id;
    insertCompany.run({
      id,
      name: c.name,
      logo: c.logo,
      industry: c.industry,
      plan: 'CSR Dashboard (SaaS)',
      monthly_budget_coins: c.monthly_budget_coins,
    });
  }

  // NGO partners
  const ngoIds = {};
  for (const n of NGOS) {
    const id = randomUUID();
    ngoIds[n.slug] = id;
    insertNgo.run({ id, name: n.name, logo: n.logo, mission: n.mission, is_premium: n.is_premium });
  }

  // Badges
  for (const b of BADGES) insertBadge.run(b);

  // Redemption options
  for (const r of REDEMPTIONS) insertRedemption.run({ ...r, partner_name: r.partner_name ?? null });

  // Promo codes (demo launch bonuses a user can type into the wallet)
  for (const p of PROMO_CODES) insertPromoCode.run({ id: randomUUID(), ...p });

  // Demo user "You" - the logged in persona
  const meId = 'demo-user-you';
  insertUser.run({
    id: meId,
    name: 'You',
    phone: '9999900000',
    avatar: '🧑‍🚀',
    mohalla: 'Kothrud',
    city: 'Pune',
    xp: 340,
    karma_coins: 620,
    trust_score: 82,
    streak_days: 4,
    is_admin: 0,
    is_csr_admin: 0,
    is_ngo_admin: 0,
    company_id: null,
    ngo_id: null,
    referral_code: genReferralCode(),
    created_at: daysAgoIso(30),
  });

  // Admin/moderator persona
  const adminId = 'demo-user-admin';
  insertUser.run({
    id: adminId,
    name: 'Moderator Anjali',
    phone: '9999900001',
    avatar: '🧑‍⚖️',
    mohalla: 'Camp',
    city: 'Pune',
    xp: 2100,
    karma_coins: 1500,
    trust_score: 96,
    streak_days: 12,
    is_admin: 1,
    is_csr_admin: 0,
    is_ngo_admin: 0,
    company_id: null,
    ngo_id: null,
    referral_code: genReferralCode(),
    created_at: daysAgoIso(120),
  });

  // CSR admin personas - one per client company, for the corporate dashboard demo
  const CSR_ADMIN_META = [
    { slug: 'tata-salt', name: 'CSR Lead — Tata Salt', avatar: '👨‍💼', phone: '9999900002' },
    { slug: 'hdfc-bank', name: 'CSR Lead — HDFC Bank', avatar: '👩‍💼', phone: '9999900003' },
    { slug: 'infosys-foundation', name: 'CSR Lead — Infosys Fdn', avatar: '🧑‍💼', phone: '9999900004' },
    { slug: 'amul', name: 'CSR Lead — Amul', avatar: '👩‍💼', phone: '9999900005' },
  ];
  const csrAdminIds = {};
  CSR_ADMIN_META.forEach((c, i) => {
    const id = randomUUID();
    csrAdminIds[c.slug] = id;
    insertUser.run({
      id,
      name: c.name,
      phone: c.phone,
      avatar: c.avatar,
      mohalla: pick(MOHALLAS),
      city: 'Pune',
      xp: 0,
      karma_coins: 0,
      trust_score: 90,
      streak_days: 0,
      is_admin: 0,
      is_csr_admin: 1,
      is_ngo_admin: 0,
      company_id: companyIds[c.slug],
      ngo_id: null,
      referral_code: genReferralCode(),
      created_at: daysAgoIso(200 - i * 10),
    });
  });

  // NGO admin personas - one per NGO partner, for the NGO dashboard demo
  const NGO_ADMIN_META = [
    { slug: 'jnana-prabodhini', name: 'NGO Lead — Jnana Prabodhini', avatar: '🧑‍🏫', phone: '9999900006' },
    { slug: 'swach', name: 'NGO Lead — SWaCH', avatar: '👩‍🔧', phone: '9999900007' },
  ];
  const ngoAdminIds = {};
  NGO_ADMIN_META.forEach((n, i) => {
    const id = randomUUID();
    ngoAdminIds[n.slug] = id;
    insertUser.run({
      id,
      name: n.name,
      phone: n.phone,
      avatar: n.avatar,
      mohalla: pick(MOHALLAS),
      city: 'Pune',
      xp: 0,
      karma_coins: 0,
      trust_score: 92,
      streak_days: 0,
      is_admin: 0,
      is_csr_admin: 0,
      is_ngo_admin: 1,
      company_id: null,
      ngo_id: ngoIds[n.slug],
      referral_code: genReferralCode(),
      created_at: daysAgoIso(220 - i * 10),
    });
  });

  // Other community users - a subset are "employees" of a CSR client company,
  // giving the CSR dashboard real participation data to show.
  const otherUserIds = [];
  const employeesByCompany = {}; // companySlug -> [userId]
  const companySlugs = COMPANIES.map((c) => c.slug);
  NAMES.forEach((name, i) => {
    const id = randomUUID();
    otherUserIds.push(id);
    const isEmployee = i % 3 === 0; // every 3rd citizen is an employee at a company
    const employerSlug = companySlugs[i % companySlugs.length];
    if (isEmployee) {
      (employeesByCompany[employerSlug] ||= []).push(id);
    }
    const { city, mohalla } = pickLocation();
    insertUser.run({
      id,
      name,
      phone: `9${String(800000000 + i * 137).padStart(9, '0')}`,
      avatar: pick(AVATARS),
      mohalla,
      city,
      xp: Math.floor(Math.random() * 3200) + 20,
      karma_coins: Math.floor(Math.random() * 1200),
      trust_score: Math.floor(Math.random() * 40) + 55,
      streak_days: Math.floor(Math.random() * 20),
      is_admin: 0,
      is_csr_admin: 0,
      is_ngo_admin: 0,
      company_id: isEmployee ? companyIds[employerSlug] : null,
      ngo_id: null,
      referral_code: genReferralCode(),
      created_at: daysAgoIso(Math.floor(Math.random() * 90) + 1),
    });
  });

  // Quests
  const questIdsByCategory = {};
  for (const [slug, quests] of Object.entries(QUESTS_BY_CATEGORY)) {
    questIdsByCategory[slug] = [];
    quests.forEach(([title, description, xp, type, difficulty]) => {
      const id = randomUUID();
      questIdsByCategory[slug].push(id);
      const site = randomSite();
      insertQuest.run({
        id,
        category_id: categoryIds[slug],
        title,
        description,
        xp_reward: xp,
        coin_reward: Math.round(xp * 1.5),
        type,
        difficulty,
        requires_gps: 1,
        requires_photo: 1,
        location_hint: pick(MOHALLAS),
        is_sponsored: 0,
        sponsor_name: null,
        company_id: null,
        ngo_id: null,
        ngo_featured: 0,
        estimated_minutes: estimatedMinutesFor(difficulty),
        proof_example_hint: proofHintFor(slug),
        site_lat: site.lat,
        site_lng: site.lng,
        status: 'active',
      });
    });
  }

  // Sponsored quests, tied to a real CSR client company each
  const sponsoredQuestIds = [];
  const companyNameBySlug = Object.fromEntries(COMPANIES.map((c) => [c.slug, c.name]));
  for (const [companySlug, categorySlug, title, description, xp, coinReward, type] of SPONSORED_QUESTS) {
    const id = randomUUID();
    sponsoredQuestIds.push({ id, companySlug });
    questIdsByCategory[categorySlug].push(id);
    const site1 = randomSite();
    insertQuest.run({
      id,
      category_id: categoryIds[categorySlug],
      title,
      description,
      xp_reward: xp,
      coin_reward: coinReward,
      type,
      difficulty: 'medium',
      requires_gps: 1,
      requires_photo: 1,
      location_hint: pick(MOHALLAS),
      is_sponsored: 1,
      sponsor_name: companyNameBySlug[companySlug],
      company_id: companyIds[companySlug],
      ngo_id: null,
      ngo_featured: 0,
      estimated_minutes: estimatedMinutesFor('medium'),
      proof_example_hint: proofHintFor(categorySlug),
      site_lat: site1.lat,
      site_lng: site1.lng,
      status: 'active',
    });
  }

  // NGO quests - Premium Listing NGOs get their quests featured at the top of the feed
  const ngoQuestIds = [];
  for (const [ngoSlug, categorySlug, title, description, xp, coinReward, type, featured] of NGO_QUESTS) {
    const id = randomUUID();
    ngoQuestIds.push({ id, ngoSlug });
    questIdsByCategory[categorySlug].push(id);
    const site2 = randomSite();
    insertQuest.run({
      id,
      category_id: categoryIds[categorySlug],
      title,
      description,
      xp_reward: xp,
      coin_reward: coinReward,
      type,
      difficulty: 'medium',
      requires_gps: 1,
      requires_photo: 1,
      location_hint: pick(MOHALLAS),
      is_sponsored: 0,
      sponsor_name: null,
      company_id: null,
      ngo_id: ngoIds[ngoSlug],
      ngo_featured: featured,
      estimated_minutes: estimatedMinutesFor('medium'),
      proof_example_hint: proofHintFor(categorySlug),
      site_lat: site2.lat,
      site_lng: site2.lng,
      status: 'active',
    });
  }

  const allQuestIds = Object.values(questIdsByCategory).flat();

  // Campaigns — themed bundles pulling 3 quests from a couple of related
  // categories, with a bonus payout for clearing every quest in the set.
  // Gives Home something more compelling to lead with than a flat list.
  const CAMPAIGNS = [
    {
      title: 'Clean Water Week',
      description: 'Three quests, one goal — protect the water your mohalla depends on.',
      icon: '💧',
      color: '#38BDF8',
      bonusXp: 60,
      bonusCoins: 40,
      questSlugs: ['prakriti', 'prakriti', 'swachh'],
      questPicks: [0, 1, 0], // index within questIdsByCategory[slug]
    },
    {
      title: 'Neighbours First',
      description: 'A week of small acts that make your street feel like home.',
      icon: '🤝',
      color: '#F472B6',
      bonusXp: 50,
      bonusCoins: 35,
      questSlugs: ['maitri', 'seva', 'ahimsa'],
      questPicks: [0, 1, 0],
    },
    {
      title: 'Future Ready',
      description: 'Pass on a skill, close a digital gap, teach what you know.',
      icon: '📚',
      color: '#8B5CF6',
      bonusXp: 55,
      bonusCoins: 35,
      questSlugs: ['gyan-daan', 'pragati', 'kala'],
      questPicks: [0, 0, 0],
    },
  ];
  for (const c of CAMPAIGNS) {
    const campaignId = randomUUID();
    insertCampaign.run({
      id: campaignId,
      title: c.title,
      description: c.description,
      icon: c.icon,
      color: c.color,
      bonus_xp: c.bonusXp,
      bonus_coins: c.bonusCoins,
      starts_at: daysAgoIso(3),
      ends_at: null,
      status: 'active',
    });
    c.questSlugs.forEach((slug, i) => {
      const questId = questIdsByCategory[slug]?.[c.questPicks[i]];
      if (!questId) return;
      insertCampaignQuest.run({ id: randomUUID(), campaign_id: campaignId, quest_id: questId, sort_order: i });
    });
  }

  // Sponsored-quest completions by company employees — gives the CSR dashboard
  // real participation numbers (unique employees engaged, deeds completed, XP contributed)
  const sponsorCaptions = [
    'Great CSR turnout from the team today!',
    'Proud to represent the company doing good.',
    'Team volunteering day well spent.',
    'Small effort, real community impact.',
  ];
  for (const { id: questId, companySlug } of sponsoredQuestIds) {
    const employees = employeesByCompany[companySlug] || [];
    const participantCount = Math.min(employees.length, 3 + Math.floor(Math.random() * 3));
    employees.slice(0, participantCount).forEach((userId, i) => {
      insertProof.run({
        id: randomUUID(),
        quest_id: questId,
        user_id: userId,
        caption: pick(sponsorCaptions),
        photo_placeholder: '🏢',
        ...pickMedia(),
        gps_lat: 18.5 + Math.random() * 0.1,
        gps_lng: 73.8 + Math.random() * 0.1,
        status: 'approved',
        upvote_count: Math.floor(Math.random() * 10) + 5,
        flag_count: 0,
        comment_count: 0,
        ai_duplicate_flag: 0,
        submitted_at: daysAgoIso(Math.floor(Math.random() * 20), i),
        reviewed_at: daysAgoIso(Math.floor(Math.random() * 15)),
        reviewed_by: 'system-auto',
      });
    });
  }

  // NGO-quest completions — populates the NGO dashboard's impact stats and gives
  // the NGO admin persona a few real proofs to click "Verify" on live in a demo.
  ngoQuestIds.forEach(({ id: questId }, qIdx) => {
    const participants = otherUserIds.slice(qIdx * 3, qIdx * 3 + 3);
    participants.forEach((userId, i) => {
      insertProof.run({
        id: randomUUID(),
        quest_id: questId,
        user_id: userId,
        caption: pick(sponsorCaptions),
        photo_placeholder: '🤝',
        ...pickMedia(),
        gps_lat: 18.5 + Math.random() * 0.1,
        gps_lng: 73.8 + Math.random() * 0.1,
        status: 'approved',
        upvote_count: Math.floor(Math.random() * 10) + 5,
        flag_count: 0,
        comment_count: 0,
        ai_duplicate_flag: 0,
        submitted_at: daysAgoIso(Math.floor(Math.random() * 15), i),
        reviewed_at: daysAgoIso(Math.floor(Math.random() * 10)),
        reviewed_by: 'system-auto',
      });
    });
    // Mark the first participant's proof as already NGO-verified, leave the rest pending verification
    if (participants.length) {
      const firstProof = db.prepare('SELECT id FROM proofs WHERE quest_id = ? AND user_id = ?').get(questId, participants[0]);
      if (firstProof) db.prepare('UPDATE proofs SET ngo_verified = 1 WHERE id = ?').run(firstProof.id);
    }
  });

  // Badges earned by "You"
  ['first-deed', 'century'].forEach((badgeId) => {
    insertUserBadge.run({ id: randomUUID(), user_id: meId, badge_id: badgeId, earned_at: daysAgoIso(5) });
  });

  // Wallet transactions for "You" - earn history + one redemption
  insertTx.run({ id: randomUUID(), user_id: meId, direction: 'earn', amount: 40, description: "Completed 'Feed 5 Strangers'", related_proof_id: null, redemption_option_id: null, status: 'completed', created_at: daysAgoIso(6) });
  insertTx.run({ id: randomUUID(), user_id: meId, direction: 'earn', amount: 50, description: "Completed 'Plant a Sapling'", related_proof_id: null, redemption_option_id: null, status: 'completed', created_at: daysAgoIso(4) });
  insertTx.run({ id: randomUUID(), user_id: meId, direction: 'earn', amount: 30, description: "Completed 'Clean Your Mohalla Street'", related_proof_id: null, redemption_option_id: null, status: 'completed', created_at: daysAgoIso(2) });
  insertTx.run({ id: randomUUID(), user_id: meId, direction: 'redeem', amount: -100, description: 'Redeemed UPI Cashback ₹10', related_proof_id: null, redemption_option_id: 'upi-10', status: 'completed', created_at: daysAgoIso(1) });

  // Community proofs: mix of approved (populate feed + leaderboard justification), pending, and flagged (for moderation demo)
  const captions = [
    'Great turnout today, mohalla came together!',
    'Small act, big smile 🙂',
    'Every bit counts towards a cleaner city.',
    'Proud to give back to my community.',
    'Kids loved the session, will do this weekly now.',
  ];

  const communityProofIds = [];
  otherUserIds.slice(0, 14).forEach((userId, i) => {
    const questId = pick(allQuestIds);
    const proofId = randomUUID();
    communityProofIds.push(proofId);
    insertProof.run({
      id: proofId,
      quest_id: questId,
      user_id: userId,
      caption: pick(captions),
      photo_placeholder: pick(['📷', '🌳', '🧹', '🍛', '🐕', '📚']),
      ...pickMedia(),
      gps_lat: 18.5 + Math.random() * 0.1,
      gps_lng: 73.8 + Math.random() * 0.1,
      status: 'approved',
      upvote_count: Math.floor(Math.random() * 12) + 5,
      flag_count: 0,
      comment_count: 0,
      ai_duplicate_flag: 0,
      submitted_at: daysAgoIso(Math.floor(Math.random() * 6), Math.floor(Math.random() * 20)),
      reviewed_at: daysAgoIso(Math.floor(Math.random() * 5)),
      reviewed_by: 'system-auto',
    });
  });

  // Comments — gives the community feed a social-media feel out of the box
  const commentTexts = [
    'This made my day 🙌', 'Love this energy!', 'Doing this too this weekend.',
    'Legend 🔥', 'So needed in our area', 'Proud of you!', 'Count me in next time.',
  ];
  communityProofIds.slice(0, 8).forEach((proofId) => {
    const numComments = 1 + Math.floor(Math.random() * 3);
    for (let i = 0; i < numComments; i++) {
      insertComment.run({
        id: randomUUID(),
        proof_id: proofId,
        user_id: pick(otherUserIds),
        text: pick(commentTexts),
        created_at: daysAgoIso(Math.floor(Math.random() * 4)),
      });
    }
    db.prepare('UPDATE proofs SET comment_count = ? WHERE id = ?').run(numComments, proofId);
  });

  // Pending proofs (need upvotes) - not yet enough community validation
  otherUserIds.slice(14, 18).forEach((userId) => {
    const questId = pick(allQuestIds);
    insertProof.run({
      id: randomUUID(),
      quest_id: questId,
      user_id: userId,
      caption: pick(captions),
      photo_placeholder: pick(['📷', '🌳', '🧹']),
      ...pickMedia(),
      gps_lat: 18.5 + Math.random() * 0.1,
      gps_lng: 73.8 + Math.random() * 0.1,
      status: 'pending',
      upvote_count: Math.floor(Math.random() * 4),
      flag_count: 0,
      comment_count: 0,
      ai_duplicate_flag: 0,
      submitted_at: daysAgoIso(0, Math.floor(Math.random() * 10)),
      reviewed_at: null,
      reviewed_by: null,
    });
  });

  // Flagged proofs - for the moderation / trust engine demo
  otherUserIds.slice(18, 22).forEach((userId, i) => {
    const questId = pick(allQuestIds);
    const flagged = randomUUID();
    insertProof.run({
      id: flagged,
      quest_id: questId,
      user_id: userId,
      caption: 'Proof submitted for review',
      photo_placeholder: '📷',
      ...pickMedia(),
      gps_lat: 18.5 + Math.random() * 0.1,
      gps_lng: 73.8 + Math.random() * 0.1,
      status: 'flagged',
      upvote_count: 1,
      flag_count: i % 2 === 0 ? 3 : 4,
      comment_count: 0,
      ai_duplicate_flag: i % 2 === 0 ? 1 : 0,
      submitted_at: daysAgoIso(1, i),
      reviewed_at: null,
      reviewed_by: null,
    });
    for (let f = 0; f < (i % 2 === 0 ? 3 : 4); f++) {
      insertFlag.run({
        id: randomUUID(),
        proof_id: flagged,
        user_id: pick(otherUserIds),
        reason: pick(['Looks like a reused photo', 'Location seems off', 'Cannot verify the deed', 'Duplicate submission']),
        created_at: daysAgoIso(1),
      });
    }
  });

  // Direct-message conversations for "You" - gives the chat inbox some content on first login
  function seedConversation(otherUserId, exchange) {
    const convoUserA = meId < otherUserId ? meId : otherUserId;
    const convoUserB = meId < otherUserId ? otherUserId : meId;
    const convoId = randomUUID();
    insertConversation.run({
      id: convoId,
      user_a_id: convoUserA,
      user_b_id: convoUserB,
      last_message_at: daysAgoIso(0, exchange.length - 1),
      created_at: daysAgoIso(3),
    });
    exchange.forEach(([senderIsMe, text], i) => {
      insertMessage.run({
        id: randomUUID(),
        conversation_id: convoId,
        sender_id: senderIsMe ? meId : otherUserId,
        text,
        created_at: daysAgoIso(0, exchange.length - i),
        read_at: senderIsMe ? null : daysAgoIso(0, exchange.length - i - 1),
      });
    });
  }

  if (otherUserIds.length >= 2) {
    seedConversation(otherUserIds[0], [
      [false, `Hey! Saw you completed a quest in ${pick(MOHALLAS)} today 🙌`],
      [true, 'Yes! Was a great turnout, you should join next time'],
      [false, "Definitely, what time does everyone usually meet?"],
    ]);
    seedConversation(otherUserIds[1], [
      [true, 'Loved your Prakriti quest post, inspired me to plant one too 🌱'],
      [false, 'That\'s awesome, let\'s coordinate a mohalla planting day!'],
    ]);
  }

  // Boss Quest — a rare, city-wide raid goal everyone contributes to
  // together. Seeded with a few days of head start (some participants
  // already joined + contributed) so it doesn't look empty on first login.
  const insertBossQuest = db.prepare(`
    INSERT INTO boss_quests (id, title, description, icon, target, current, reward_coins, status, ends_at)
    VALUES (@id, @title, @description, @icon, @target, @current, @reward_coins, 'active', @ends_at)
  `);
  const insertBossParticipant = db.prepare(`
    INSERT INTO boss_quest_participants (id, boss_quest_id, user_id, contributions, last_contributed_at, joined_at)
    VALUES (@id, @boss_quest_id, @user_id, @contributions, @last_contributed_at, @joined_at)
  `);
  const bossQuestId = randomUUID();
  const bossParticipants = otherUserIds.slice(0, 9);
  const bossContributionsTotal = bossParticipants.reduce((sum, _, i) => sum + (1 + (i % 3)), 0);
  insertBossQuest.run({
    id: bossQuestId,
    title: 'Clear 500kg of Waste This Month',
    description: 'A city-wide push to hit 500 logged cleanup deeds before the month ends. Every Swachh quest you complete chips in — join the raid!',
    icon: '🐉',
    target: 40,
    current: bossContributionsTotal,
    reward_coins: 75,
    ends_at: daysAgoIso(-18),
  });
  bossParticipants.forEach((userId, i) => {
    insertBossParticipant.run({
      id: randomUUID(),
      boss_quest_id: bossQuestId,
      user_id: userId,
      contributions: 1 + (i % 3),
      last_contributed_at: daysAgoIso(Math.floor(Math.random() * 3)).slice(0, 10),
      joined_at: daysAgoIso(6 + i),
    });
  });

  // Mark this fresh database as already on the current media pool, so
  // regenerateMediaIfStale() (called on every boot) doesn't immediately
  // re-randomize the photos/videos this seed run just picked.
  db.prepare(`INSERT INTO app_meta (key, value) VALUES ('media_pool_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(MEDIA_POOL_VERSION);

  tx('COMMIT');
  return {
    seeded: true,
    users: otherUserIds.length + 2 + CSR_ADMIN_META.length + NGO_ADMIN_META.length,
    quests: allQuestIds.length,
    companies: COMPANIES.length,
    ngos: NGOS.length,
  };
}

// One-time catch-up for databases that were already seeded before dummy
// photos/videos existed (media_type/media_data were added to the proofs
// table and the seed script after some installs had already run). Since
// seedIfEmpty() only seeds a brand-new database, anyone with pre-existing
// data would otherwise see an empty/emoji-only feed forever. Safe to call on
// every boot — it only touches rows that still have no media set.
export function backfillMissingMedia() {
  initSchema();
  const missing = db.prepare(`SELECT id FROM proofs WHERE media_type IS NULL OR media_data IS NULL`).all();
  if (missing.length === 0) return { backfilled: 0 };
  const update = db.prepare(`UPDATE proofs SET media_type = @media_type, media_data = @media_data WHERE id = @id`);
  for (const row of missing) {
    const media = pickMedia();
    update.run({ id: row.id, ...media });
  }
  return { backfilled: missing.length };
}

// The dummy media pool was fully replaced (old MDN/w3schools clips + first
// Picsum seed batch -> Google's GTV sample videos + a fresh Picsum seed
// batch). backfillMissingMedia() alone won't touch that on an existing
// install, since every proof already has *some* media set - it just needs
// to be the new set, not merely non-null. app_meta tracks whether this
// database has been upgraded yet so a restart doesn't keep re-randomizing
// every photo/video on every boot.
const MEDIA_POOL_VERSION = '2';
export function regenerateMediaIfStale() {
  initSchema();
  const row = db.prepare(`SELECT value FROM app_meta WHERE key = 'media_pool_version'`).get();
  if (row?.value === MEDIA_POOL_VERSION) return { regenerated: 0 };

  const all = db.prepare(`SELECT id FROM proofs`).all();
  const update = db.prepare(`UPDATE proofs SET media_type = @media_type, media_data = @media_data WHERE id = @id`);
  const tx = db.exec.bind(db);
  tx('BEGIN');
  for (const row of all) {
    update.run({ id: row.id, ...pickMedia() });
  }
  db.prepare(`INSERT INTO app_meta (key, value) VALUES ('media_pool_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(MEDIA_POOL_VERSION);
  tx('COMMIT');
  return { regenerated: all.length };
}

// Same idea as backfillMissingMedia, but for referral codes - covers any
// pre-existing install that started before the Invite feature (and its
// referral_code column) existed. Safe to call on every boot.
export function backfillReferralCodes() {
  initSchema();
  const missing = db.prepare(`SELECT id FROM users WHERE referral_code IS NULL`).all();
  if (missing.length === 0) return { backfilled: 0 };
  const update = db.prepare(`UPDATE users SET referral_code = @referral_code WHERE id = @id`);
  for (const row of missing) {
    update.run({ id: row.id, referral_code: genReferralCode() });
  }
  return { backfilled: missing.length };
}
