/**
 * Tier 1 relevance scoring — keyword-based, runs host-side (~1ms/offer).
 * Loads profile.json and scores each offer against it.
 */

import fs from 'fs';
import path from 'path';

import { logger } from '../logger.js';
import {
  SCORING_CONFIG,
  ALL_SEARCH_TERMS,
  EXCLUDED_TITLE_PATTERNS,
} from './config.js';
import type { RawOffer } from './types.js';

/** Domain keywords that indicate an offer is in-scope for the profile. */
const DOMAIN_KEYWORDS = [
  'maintenance applicative',
  'tma',
  'mco applicatif',
  'développement web',
  'application web',
  'site web',
  'site internet',
  'fullstack',
  'full stack',
  'full-stack',
  'backend',
  'back-end',
  'api rest',
  'api',
  'web service',
  'refonte',
  'migration',
  'modernisation',
  'e-learning',
  'plateforme',
  'portail',
  'intelligence artificielle',
  'ia',
  'machine learning',
  'devops',
  'ci/cd',
  'intégration continue',
  'chef de projet',
  'pilotage',
  'moe',
  "maîtrise d'oeuvre",
  'lead',
  'tech lead',
  'lead dev',
];

// --- Profile types ---

interface ProfileSkill {
  name: string;
  level: string;
  years?: number;
  aliases?: string[];
  frameworks?: string[];
  tools?: string[];
}

interface Profile {
  name: string;
  title: string;
  experienceYears: number;
  location: {
    city: string;
    department: string;
    region: string;
  };
  skills: ProfileSkill[];
  excludedSkills: string[];
  preferredLocations: string[];
  preferredRegions: string[];
  acceptsRemote: boolean;
  acceptsOnsite: boolean;
  prefersHybrid: boolean;
  tjm: {
    minimum: number;
    target: number;
    currency: string;
  };
  preferredDuration?: {
    minMonths: number;
    maxMonths: number;
  };
}

let cachedProfile: Profile | null = null;

/** Load the profile from disk. Caches after first load. */
export function loadProfile(profilePath?: string): Profile {
  if (cachedProfile) return cachedProfile;

  const filePath =
    profilePath || path.resolve(process.cwd(), 'data/freelance/profile.json');

  const raw = fs.readFileSync(filePath, 'utf-8');
  cachedProfile = JSON.parse(raw) as Profile;
  logger.info({ name: cachedProfile.name }, 'Profile loaded for scoring');
  return cachedProfile;
}

/** @internal - for tests only. */
export function _clearProfileCache(): void {
  cachedProfile = null;
}

// --- Alias map ---

function buildAliasSet(skills: ProfileSkill[]): Set<string> {
  const set = new Set<string>();
  for (const skill of skills) {
    set.add(skill.name.toLowerCase());
    for (const alias of skill.aliases || []) {
      set.add(alias.toLowerCase());
    }
    for (const fw of skill.frameworks || []) {
      set.add(fw.toLowerCase());
    }
    for (const tool of skill.tools || []) {
      set.add(tool.toLowerCase());
    }
  }
  return set;
}

// --- Individual scoring functions ---

function scoreSkillMatch(
  offerSkills: string[],
  profileAliases: Set<string>,
  excludedSkills: Set<string>,
): number {
  if (offerSkills.length === 0) return 0.5; // no skills listed → neutral

  let matches = 0;
  let excluded = 0;

  for (const skill of offerSkills) {
    const normalized = skill.toLowerCase().trim();
    if (profileAliases.has(normalized)) {
      matches++;
    }
    if (excludedSkills.has(normalized)) {
      excluded++;
    }
  }

  const matchRatio = matches / offerSkills.length;
  const penalty = excluded > 0 ? 0.3 : 0;

  return Math.max(0, Math.min(1, matchRatio - penalty));
}

function scoreTitle(
  title: string,
  profileAliases: Set<string>,
  excludedSkills: Set<string>,
): number {
  const words = title
    .toLowerCase()
    .split(/[\s,/\-()]+/)
    .filter((w) => w.length > 2);
  if (words.length === 0) return 0.5;

  let matches = 0;
  let excluded = 0;

  for (const word of words) {
    if (profileAliases.has(word)) matches++;
    if (excludedSkills.has(word)) excluded++;
  }

  if (excluded > 0) return 0.1;
  if (matches === 0) return 0.3; // no match but no exclusion
  return Math.min(1, 0.5 + (matches / words.length) * 0.5);
}

function scoreLocationMatch(
  location: string | null,
  profile: Profile,
): number {
  if (!location) return 0.5; // no location → neutral

  const loc = location.toLowerCase();

  if (
    loc.includes('remote') ||
    loc.includes('télétravail') ||
    loc.includes('full remote') ||
    loc.includes('à distance')
  ) {
    return 1.0;
  }

  if (loc.includes('hybride') || loc.includes('hybrid')) {
    return 0.9;
  }

  for (const preferred of profile.preferredLocations) {
    if (loc.includes(preferred.toLowerCase())) return 1.0;
  }

  for (const region of profile.preferredRegions) {
    if (loc.includes(region.toLowerCase())) return 0.7;
  }

  if (loc.includes('france') || loc.includes('paris')) {
    return 0.5;
  }

  return profile.acceptsOnsite ? 0.3 : 0.2;
}

function scoreTjmMatch(
  dailyRate: number | null,
  profile: Profile,
): number {
  if (!dailyRate) return 0.5; // no TJM → neutral

  if (dailyRate >= profile.tjm.target) return 1.0;
  if (dailyRate >= profile.tjm.minimum) return 0.7;
  if (dailyRate >= profile.tjm.minimum * 0.8) return 0.3;
  return 0.0;
}

function scoreFreshness(collectedAt: string): number {
  const collected = new Date(collectedAt).getTime();
  if (isNaN(collected)) return 0.5;

  const ageInDays = (Date.now() - collected) / (1000 * 60 * 60 * 24);

  if (ageInDays <= 1) return 1.0;
  if (ageInDays <= 3) return 0.8;
  if (ageInDays <= 7) return 0.6;
  if (ageInDays <= 14) return 0.4;
  if (ageInDays <= 30) return 0.2;
  return 0.1;
}

function scoreDomainRelevance(offer: RawOffer): number {
  const text = `${offer.title} ${offer.description_raw}`.toLowerCase();

  let domainHits = 0;
  for (const keyword of DOMAIN_KEYWORDS) {
    if (text.includes(keyword)) domainHits++;
  }

  if (domainHits >= 3) return 1.0;
  if (domainHits >= 2) return 0.8;
  if (domainHits >= 1) return 0.6;
  return 0.2; // no domain keyword match at all
}

function scoreExperienceMatch(offer: RawOffer, profile: Profile): number {
  const text = `${offer.title} ${offer.description_raw}`.toLowerCase();

  // Look for seniority indicators
  if (text.includes('junior') || text.includes('débutant')) return 0.3;
  if (text.includes('confirmé') || text.includes('2-5 ans')) return 0.7;
  if (
    text.includes('senior') ||
    text.includes('lead') ||
    text.includes('expert') ||
    text.includes('chef de projet') ||
    text.includes('architecte') ||
    text.includes('10 ans') ||
    text.includes('8 ans')
  ) {
    return 1.0;
  }

  // No explicit seniority → neutral (most offers)
  return 0.6;
}

/** Keywords indicating the offer is remote or in the Île-de-France region. */
const IDF_REMOTE_KEYWORDS = [
  'remote',
  'télétravail',
  'teletravail',
  'full remote',
  'à distance',
  'a distance',
  'hybride',
  'hybrid',
  'île-de-france',
  'ile-de-france',
  'idf',
  'paris',
  "val-d'oise",
  "val d'oise",
  'yvelines',
  'essonne',
  'hauts-de-seine',
  'seine-saint-denis',
  'val-de-marne',
  'seine-et-marne',
  'cergy',
  'pontoise',
  'saint-ouen',
  'versailles',
  'boulogne',
  'nanterre',
  'vincennes',
  'montreuil',
  'ivry',
  'créteil',
  'creteil',
  'bobigny',
  'argenteuil',
  'melun',
  // Département codes
  '75',
  '77',
  '78',
  '91',
  '92',
  '93',
  '94',
  '95',
];

/**
 * Returns true if the offer location is explicitly set and contains no
 * IDF or remote keywords → hard-reject (not in scope).
 * If location is absent or empty, returns false (neutral → don't reject).
 */
function isLocationExcluded(location: string | null): boolean {
  if (!location || location.trim() === '' || location === '—') return false;

  const loc = location.toLowerCase();
  for (const kw of IDF_REMOTE_KEYWORDS) {
    if (loc.includes(kw)) return false;
  }

  // Location is set but matches no IDF/remote keyword → out of scope
  return true;
}

/**
 * Hard-reject an offer before scoring if its title matches any
 * EXCLUDED_TITLE_PATTERNS, if any excluded skill appears in the title,
 * or if the location is explicitly outside IDF/remote.
 * Returns true → score 0, offer filtered out.
 */
function isHardExcluded(
  offer: RawOffer,
  excludedSkills: Set<string>,
): boolean {
  const title = offer.title.toLowerCase();

  for (const pattern of EXCLUDED_TITLE_PATTERNS) {
    if (title.includes(pattern)) return true;
  }

  for (const skill of excludedSkills) {
    if (title.includes(skill)) return true;
  }

  if (isLocationExcluded(offer.location)) {
    logger.debug(
      { title: offer.title, location: offer.location },
      'Offer hard-rejected by location',
    );
    return true;
  }

  return false;
}

// --- Main scoring function ---

export interface ScoringResult {
  score: number;
  breakdown: {
    skillMatch: number;
    domainRelevance: number;
    experienceMatch: number;
    locationMatch: number;
    tjmMatch: number;
    freshnessBonus: number;
  };
}

export function scoreOffer(
  offer: RawOffer,
  profile?: Profile,
): ScoringResult {
  const p = profile || loadProfile();
  const profileAliases = buildAliasSet(p.skills);
  const excludedSkills = new Set(p.excludedSkills.map((s) => s.toLowerCase()));

  if (isHardExcluded(offer, excludedSkills)) {
    logger.debug(
      { title: offer.title },
      'Offer hard-rejected by title pattern',
    );
    return {
      score: 0,
      breakdown: {
        skillMatch: 0,
        domainRelevance: 0,
        experienceMatch: 0,
        locationMatch: 0,
        tjmMatch: 0,
        freshnessBonus: 0,
      },
    };
  }

  const weights = SCORING_CONFIG.TIER1_WEIGHTS;

  const allSkills = [...offer.skills_required, ...offer.skills_optional];

  const rawSkillMatch = scoreSkillMatch(
    allSkills,
    profileAliases,
    excludedSkills,
  );
  const titleMatch = scoreTitle(offer.title, profileAliases, excludedSkills);
  const domain = scoreDomainRelevance(offer);

  const breakdown = {
    skillMatch: rawSkillMatch,
    domainRelevance: domain,
    experienceMatch: scoreExperienceMatch(offer, p),
    locationMatch: scoreLocationMatch(offer.location, p),
    tjmMatch: scoreTjmMatch(offer.daily_rate, p),
    freshnessBonus: scoreFreshness(offer.collected_at),
  };

  // For offers without explicit tech skills (e.g. BOAMP),
  // use best of: skill list match, title keywords, or domain relevance.
  const effectiveSkillMatch = Math.max(rawSkillMatch, titleMatch, domain);

  const score =
    effectiveSkillMatch * weights.skillMatch +
    breakdown.experienceMatch * weights.experienceMatch +
    breakdown.locationMatch * weights.locationMatch +
    breakdown.tjmMatch * weights.tjmMatch +
    breakdown.freshnessBonus * weights.freshnessBonus;

  return {
    score: Math.round(score * 100) / 100,
    breakdown,
  };
}

/** Score a batch of offers and return them sorted by score descending. */
export function scoreNewOffers(
  offers: RawOffer[],
): Array<{ offer: RawOffer; score: number }> {
  const profile = loadProfile();
  const results: Array<{ offer: RawOffer; score: number }> = [];

  for (const offer of offers) {
    const { score } = scoreOffer(offer, profile);
    results.push({ offer, score });
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}
