import { db } from './connection.js';

// Columns added to pre-existing tables after their first release. `CREATE
// TABLE IF NOT EXISTS` below is a no-op on a database that already has these
// tables from an older version of the app, so anyone upgrading in place
// (rather than starting from a fresh karmaquest.sqlite) needs these added by
// hand. Safe to run on every boot — each column is only added if missing.
const COLUMN_MIGRATIONS = {
  users: [
    ['is_ngo_admin', "INTEGER NOT NULL DEFAULT 0"],
    ['ngo_id', "TEXT REFERENCES ngos(id)"],
    ['last_spin_at', "TEXT"],
    ['referral_code', "TEXT"],
    ['invited_by', "TEXT REFERENCES users(id)"],
    ['last_match_at', "TEXT"],
    ['last_snake_at', "TEXT"],
    ['last_arrow_at', "TEXT"],
    ['last_ludo_at', "TEXT"],
    ['bio', "TEXT NOT NULL DEFAULT ''"],
    ['last_obstacle_clear_at', "TEXT"],
    ['institution_id', "TEXT REFERENCES institutions(id)"],
    ['skills', "TEXT NOT NULL DEFAULT ''"],
  ],
  quests: [
    ['ngo_id', "TEXT REFERENCES ngos(id)"],
    ['ngo_featured', "INTEGER NOT NULL DEFAULT 0"],
    ['estimated_minutes', "INTEGER NOT NULL DEFAULT 15"],
    ['proof_example_hint', "TEXT"],
    ['site_lat', "REAL"],
    ['site_lng', "REAL"],
    ['skill_tags', "TEXT NOT NULL DEFAULT ''"],
    ['relay_chain_id', "TEXT REFERENCES relay_chains(id)"],
    ['is_civic', "INTEGER NOT NULL DEFAULT 0"],
  ],
  proofs: [
    ['media_type', "TEXT"],
    ['media_data', "TEXT"],
    ['comment_count', "INTEGER NOT NULL DEFAULT 0"],
    ['ngo_verified', "INTEGER NOT NULL DEFAULT 0"],
    ['image_hash', "TEXT"],
    ['ai_flag_reason', "TEXT"],
    ['distance_meters', "REAL"],
    ['witness_count', "INTEGER NOT NULL DEFAULT 0"],
    ['voice_note_data', "TEXT"],
    ['ai_vision_score', "INTEGER"],
  ],
  companies: [
    // Paise matched per hour of verified volunteering by an employee — the
    // CSR "put your money where your mouth is" lever. 0 = matching off.
    ['matching_rate_paise_per_hour', "INTEGER NOT NULL DEFAULT 0"],
  ],
};

function migrateColumns() {
  for (const [table, columns] of Object.entries(COLUMN_MIGRATIONS)) {
    const tableExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).get(table);
    if (!tableExists) continue; // fresh DB — CREATE TABLE above already has every column
    const existingCols = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    for (const [name, definition] of columns) {
      if (!existingCols.has(name)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition};`);
      }
    }
  }
}

export function initSchema() {
  db.exec(`
    -- Tiny key/value store for one-off app-level flags (e.g. "have we
    -- already regenerated the dummy media pool onto this database").
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS companies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      logo TEXT NOT NULL DEFAULT '🏢',
      industry TEXT,
      plan TEXT NOT NULL DEFAULT 'CSR Dashboard (SaaS)',
      monthly_budget_coins INTEGER NOT NULL DEFAULT 0,
      matching_rate_paise_per_hour INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- CSR matching ledger: one row per approved deed done by an employee of
    -- a company running matching, recording the real-rupee donation their
    -- volunteering triggered. This is the artifact a CSR/compliance team
    -- needs — not just "employees did N deeds" but "here is exactly what
    -- that turned into in matched funds, per person, per deed, auditable."
    CREATE TABLE IF NOT EXISTS csr_matches (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      proof_id TEXT NOT NULL REFERENCES proofs(id),
      quest_id TEXT NOT NULL REFERENCES quests(id),
      minutes INTEGER NOT NULL,
      amount_paise INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ngos (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      logo TEXT NOT NULL DEFAULT '🤝',
      mission TEXT,
      is_premium INTEGER NOT NULL DEFAULT 0,
      verified INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Institutions: schools, colleges, corporates, and formal Housing
    -- Society (RWA) groups. Distinct from the free-text "mohalla" field
    -- (which is just a neighborhood label) — an institution has a real
    -- admin, a join code, and its own leaderboard + reporting, so a school
    -- can run an NSS-credit-hours export or a housing society can run a
    -- formal building-vs-building competition instead of the informal
    -- mohalla territory wars.
    CREATE TABLE IF NOT EXISTS institutions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'school',
      join_code TEXT NOT NULL UNIQUE,
      icon TEXT NOT NULL DEFAULT '🏫',
      admin_user_id TEXT REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT UNIQUE,
      avatar TEXT NOT NULL DEFAULT '🙂',
      mohalla TEXT NOT NULL,
      city TEXT NOT NULL DEFAULT '',
      xp INTEGER NOT NULL DEFAULT 0,
      karma_coins INTEGER NOT NULL DEFAULT 0,
      trust_score INTEGER NOT NULL DEFAULT 70,
      streak_days INTEGER NOT NULL DEFAULT 0,
      is_admin INTEGER NOT NULL DEFAULT 0,
      is_csr_admin INTEGER NOT NULL DEFAULT 0,
      is_ngo_admin INTEGER NOT NULL DEFAULT 0,
      company_id TEXT REFERENCES companies(id),
      ngo_id TEXT REFERENCES ngos(id),
      last_spin_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      letter TEXT NOT NULL,
      description TEXT NOT NULL,
      color TEXT NOT NULL,
      icon TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS quests (
      id TEXT PRIMARY KEY,
      category_id TEXT NOT NULL REFERENCES categories(id),
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      xp_reward INTEGER NOT NULL,
      coin_reward INTEGER NOT NULL,
      type TEXT NOT NULL DEFAULT 'daily',
      difficulty TEXT NOT NULL DEFAULT 'easy',
      requires_gps INTEGER NOT NULL DEFAULT 1,
      requires_photo INTEGER NOT NULL DEFAULT 1,
      location_hint TEXT,
      is_sponsored INTEGER NOT NULL DEFAULT 0,
      sponsor_name TEXT,
      company_id TEXT REFERENCES companies(id),
      ngo_id TEXT REFERENCES ngos(id),
      ngo_featured INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS proofs (
      id TEXT PRIMARY KEY,
      quest_id TEXT NOT NULL REFERENCES quests(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      caption TEXT,
      photo_placeholder TEXT NOT NULL DEFAULT '📷',
      media_type TEXT,
      media_data TEXT,
      gps_lat REAL,
      gps_lng REAL,
      status TEXT NOT NULL DEFAULT 'pending',
      upvote_count INTEGER NOT NULL DEFAULT 0,
      flag_count INTEGER NOT NULL DEFAULT 0,
      comment_count INTEGER NOT NULL DEFAULT 0,
      ai_duplicate_flag INTEGER NOT NULL DEFAULT 0,
      ngo_verified INTEGER NOT NULL DEFAULT 0,
      submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
      reviewed_at TEXT,
      reviewed_by TEXT
    );

    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY,
      proof_id TEXT NOT NULL REFERENCES proofs(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id),
      text TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      user_a_id TEXT NOT NULL REFERENCES users(id),
      user_b_id TEXT NOT NULL REFERENCES users(id),
      last_message_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_a_id, user_b_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      sender_id TEXT NOT NULL REFERENCES users(id),
      text TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      read_at TEXT
    );

    CREATE TABLE IF NOT EXISTS upvotes (
      id TEXT PRIMARY KEY,
      proof_id TEXT NOT NULL REFERENCES proofs(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(proof_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS flags (
      id TEXT PRIMARY KEY,
      proof_id TEXT NOT NULL REFERENCES proofs(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id),
      reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(proof_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS badges (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      icon TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_badges (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      badge_id TEXT NOT NULL REFERENCES badges(id),
      earned_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, badge_id)
    );

    CREATE TABLE IF NOT EXISTS redemption_options (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      coin_cost INTEGER NOT NULL,
      description TEXT NOT NULL,
      partner_name TEXT,
      icon TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
    );

    CREATE TABLE IF NOT EXISTS wallet_transactions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      direction TEXT NOT NULL,
      amount INTEGER NOT NULL,
      description TEXT NOT NULL,
      related_proof_id TEXT,
      redemption_option_id TEXT,
      status TEXT NOT NULL DEFAULT 'completed',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- "Boss Quest" — a rare, city-wide raid-style goal everyone contributes
    -- to together, with one shared progress bar (Rival Mode uses the users/
    -- proofs tables directly and needs no schema of its own).
    CREATE TABLE IF NOT EXISTS boss_quests (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      icon TEXT NOT NULL DEFAULT '🐉',
      target INTEGER NOT NULL,
      current INTEGER NOT NULL DEFAULT 0,
      reward_coins INTEGER NOT NULL DEFAULT 50,
      status TEXT NOT NULL DEFAULT 'active',
      ends_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS boss_quest_participants (
      id TEXT PRIMARY KEY,
      boss_quest_id TEXT NOT NULL REFERENCES boss_quests(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id),
      contributions INTEGER NOT NULL DEFAULT 0,
      last_contributed_at TEXT,
      joined_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(boss_quest_id, user_id)
    );

    -- Instagram-style follow graph. Directional: a row means follower_id
    -- follows following_id. No approval step (public profiles, MVP scope).
    CREATE TABLE IF NOT EXISTS follows (
      id TEXT PRIMARY KEY,
      follower_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      following_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(follower_id, following_id)
    );

    -- Campaigns bundle several related quests into one themed push ("Clean
    -- Water Week") with its own progress bar and a bonus payout for anyone
    -- who clears every quest in the set before it ends.
    CREATE TABLE IF NOT EXISTS campaigns (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      icon TEXT NOT NULL DEFAULT '🌟',
      color TEXT NOT NULL DEFAULT '#8B5CF6',
      bonus_xp INTEGER NOT NULL DEFAULT 50,
      bonus_coins INTEGER NOT NULL DEFAULT 30,
      starts_at TEXT NOT NULL DEFAULT (datetime('now')),
      ends_at TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS campaign_quests (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      quest_id TEXT NOT NULL REFERENCES quests(id) ON DELETE CASCADE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      UNIQUE(campaign_id, quest_id)
    );

    -- Tracks who has already been paid the campaign completion bonus, so it
    -- can only be claimed once per user per campaign.
    CREATE TABLE IF NOT EXISTS campaign_claims (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id),
      claimed_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(campaign_id, user_id)
    );

    -- A real, unique redemption code minted the moment a user redeems a
    -- 'voucher' type redemption option (Swiggy/Amazon/Zomato etc.) — this is
    -- the actual coupon, not just a wallet-transaction line item. Shown in
    -- the "My Vouchers" wallet tab with a copy-to-clipboard action.
    CREATE TABLE IF NOT EXISTS vouchers (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      redemption_option_id TEXT NOT NULL REFERENCES redemption_options(id),
      code TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'active',
      issued_at TEXT NOT NULL DEFAULT (datetime('now')),
      redeemed_at TEXT
    );

    -- Promo codes a user can type into the wallet for a one-time bonus coin
    -- grant (referral pushes, launch campaigns, etc.) — capped by max_uses.
    CREATE TABLE IF NOT EXISTS promo_codes (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      coin_bonus INTEGER NOT NULL,
      description TEXT,
      max_uses INTEGER,
      uses_count INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS promo_redemptions (
      id TEXT PRIMARY KEY,
      promo_code_id TEXT NOT NULL REFERENCES promo_codes(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(promo_code_id, user_id)
    );

    -- Razorpay payment orders — coin top-ups (citizen buys Karma Coins with
    -- real INR), quest sponsorships (a company funds a quest), and NGO cash
    -- donations. Runs in real Razorpay test mode once RAZORPAY_KEY_ID /
    -- RAZORPAY_KEY_SECRET env vars are set (see routes/payments.js); with no
    -- keys configured it falls back to a clearly-labeled simulated flow so
    -- the rest of the product can still be demoed end to end.
    CREATE TABLE IF NOT EXISTS payment_orders (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      type TEXT NOT NULL,
      amount_paise INTEGER NOT NULL,
      coins INTEGER,
      quest_id TEXT,
      ngo_id TEXT,
      razorpay_order_id TEXT,
      razorpay_payment_id TEXT,
      status TEXT NOT NULL DEFAULT 'created',
      simulated INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );

    -- Peer-witness co-signing: the proof owner opens their pending proof for
    -- witnessing (an "I was there / I can vouch" request), and any other
    -- user can claim the open slot and confirm it in person. A confirmed
    -- witness earns a small reward for the civic labor of verifying someone
    -- else's deed, and the proof owner gets a real trust-score bump backed
    -- by a second human, not just an algorithm — this is the actual fraud
    -- countermeasure as AI-generated fake "good deed" photos get cheaper to
    -- produce: a second real person physically confirming it happened.
    CREATE TABLE IF NOT EXISTS proof_witnesses (
      id TEXT PRIMARY KEY,
      proof_id TEXT NOT NULL REFERENCES proofs(id) ON DELETE CASCADE,
      requester_id TEXT NOT NULL REFERENCES users(id),
      witness_id TEXT REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'open',
      note TEXT,
      reward_coins INTEGER NOT NULL DEFAULT 5,
      requested_at TEXT NOT NULL DEFAULT (datetime('now')),
      confirmed_at TEXT
    );

    -- Karma Coins → UPI cashout REQUESTS. This is deliberately a request/
    -- ledger/admin-approval flow, not an automatic bank transfer: coins are
    -- deducted (held) the moment a request is filed, an admin reviews it in
    -- the moderation queue, and marks it 'paid' once the actual UPI transfer
    -- has been sent manually outside the app (same pattern any early-stage
    -- fintech MVP uses before wiring a payout API/partner bank account).
    -- Rejected requests refund the held coins.
    CREATE TABLE IF NOT EXISTS cashout_requests (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      coins INTEGER NOT NULL,
      amount_paise INTEGER NOT NULL,
      upi_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      admin_note TEXT,
      requested_at TEXT NOT NULL DEFAULT (datetime('now')),
      processed_at TEXT
    );

    -- Deed relays: a multi-person chained quest where step 2 only unlocks
    -- once step 1 is done, etc. — a relay baton, not a solo checklist.
    CREATE TABLE IF NOT EXISTS relay_chains (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      icon TEXT NOT NULL DEFAULT '🔗',
      category_id TEXT REFERENCES categories(id),
      creator_id TEXT NOT NULL REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- proof_caption/proof_media_* store each leg's evidence directly (rather
    -- than reusing the proofs table, whose quest_id is NOT NULL and whose
    -- whole schema is shaped around the AI-screen/upvote review pipeline
    -- that a lightweight, social-trust relay leg deliberately skips).
    CREATE TABLE IF NOT EXISTS relay_steps (
      id TEXT PRIMARY KEY,
      chain_id TEXT NOT NULL REFERENCES relay_chains(id) ON DELETE CASCADE,
      step_order INTEGER NOT NULL,
      task TEXT NOT NULL,
      assignee_id TEXT REFERENCES users(id),
      proof_caption TEXT,
      proof_media_type TEXT,
      proof_media_data TEXT,
      status TEXT NOT NULL DEFAULT 'locked',
      claimed_at TEXT,
      completed_at TEXT,
      UNIQUE(chain_id, step_order)
    );

    -- Collectible Karma Cards — a milestone deed can drop a random card,
    -- weighted by rarity. user_cards is the per-user collection; cards can
    -- be gifted (row's user_id changes, gifted_from records provenance).
    CREATE TABLE IF NOT EXISTS karma_cards (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      rarity TEXT NOT NULL DEFAULT 'common',
      art TEXT NOT NULL DEFAULT '🃏',
      description TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#8B5CF6'
    );

    CREATE TABLE IF NOT EXISTS user_cards (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      card_id TEXT NOT NULL REFERENCES karma_cards(id),
      obtained_at TEXT NOT NULL DEFAULT (datetime('now')),
      gifted_from TEXT REFERENCES users(id)
    );
  `);

  // Backfill columns onto tables that already existed before those columns
  // were introduced (see COLUMN_MIGRATIONS above) — must run before the
  // indexes below, several of which are built on those newer columns.
  migrateColumns();

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_proofs_quest ON proofs(quest_id);
    CREATE INDEX IF NOT EXISTS idx_proofs_user ON proofs(user_id);
    CREATE INDEX IF NOT EXISTS idx_proofs_status ON proofs(status);
    CREATE INDEX IF NOT EXISTS idx_quests_category ON quests(category_id);
    CREATE INDEX IF NOT EXISTS idx_quests_company ON quests(company_id);
    CREATE INDEX IF NOT EXISTS idx_quests_ngo ON quests(ngo_id);
    CREATE INDEX IF NOT EXISTS idx_wallet_user ON wallet_transactions(user_id);
    CREATE INDEX IF NOT EXISTS idx_users_mohalla ON users(mohalla);
    CREATE INDEX IF NOT EXISTS idx_users_company ON users(company_id);
    CREATE INDEX IF NOT EXISTS idx_users_ngo ON users(ngo_id);
    CREATE INDEX IF NOT EXISTS idx_comments_proof ON comments(proof_id);
    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_conversations_a ON conversations(user_a_id);
    CREATE INDEX IF NOT EXISTS idx_conversations_b ON conversations(user_b_id);
    CREATE INDEX IF NOT EXISTS idx_boss_participants_quest ON boss_quest_participants(boss_quest_id);
    CREATE INDEX IF NOT EXISTS idx_boss_participants_user ON boss_quest_participants(user_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code);
    CREATE INDEX IF NOT EXISTS idx_users_invited_by ON users(invited_by);
    CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_id);
    CREATE INDEX IF NOT EXISTS idx_follows_following ON follows(following_id);
    CREATE INDEX IF NOT EXISTS idx_campaign_quests_campaign ON campaign_quests(campaign_id);
    CREATE INDEX IF NOT EXISTS idx_campaign_quests_quest ON campaign_quests(quest_id);
    CREATE INDEX IF NOT EXISTS idx_campaign_claims_user ON campaign_claims(user_id);
    CREATE INDEX IF NOT EXISTS idx_vouchers_user ON vouchers(user_id);
    CREATE INDEX IF NOT EXISTS idx_payment_orders_user ON payment_orders(user_id);
    CREATE INDEX IF NOT EXISTS idx_proof_witnesses_proof ON proof_witnesses(proof_id);
    CREATE INDEX IF NOT EXISTS idx_proof_witnesses_status ON proof_witnesses(status);
    CREATE INDEX IF NOT EXISTS idx_proof_witnesses_witness ON proof_witnesses(witness_id);
    CREATE INDEX IF NOT EXISTS idx_users_institution ON users(institution_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_institutions_join_code ON institutions(join_code);
    CREATE INDEX IF NOT EXISTS idx_csr_matches_company ON csr_matches(company_id);
    CREATE INDEX IF NOT EXISTS idx_csr_matches_user ON csr_matches(user_id);
    CREATE INDEX IF NOT EXISTS idx_cashout_user ON cashout_requests(user_id);
    CREATE INDEX IF NOT EXISTS idx_cashout_status ON cashout_requests(status);
    CREATE INDEX IF NOT EXISTS idx_relay_steps_chain ON relay_steps(chain_id);
    CREATE INDEX IF NOT EXISTS idx_relay_steps_assignee ON relay_steps(assignee_id);
    CREATE INDEX IF NOT EXISTS idx_quests_relay_chain ON quests(relay_chain_id);
    CREATE INDEX IF NOT EXISTS idx_user_cards_user ON user_cards(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_cards_card ON user_cards(card_id);
  `);
}
