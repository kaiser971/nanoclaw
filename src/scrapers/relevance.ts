/**
 * Tier 1 relevance scoring — keyword-based, runs host-side (~1ms/offer).
 * Loads profile.json and scores each offer against it.
 */

import fs from 'fs';
import path from 'path';

import { logger } from '../logger.js';
import { SCORING_CONFIG, ALL_SEARCH_TERMS } from './config.js';
import type { ScrapedOffer } from './types.js';

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
  location: string | undefined,
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
  tjmMin: number | undefined,
  tjmMax: number | undefined,
  profile: Profile,
): number {
  if (!tjmMin && !tjmMax) return 0.5; // no TJM → neutral

  const offerTjm = tjmMax || tjmMin || 0;

  if (offerTjm >= profile.tjm.target) return 1.0;
  if (offerTjm >= profile.tjm.minimum) return 0.7;
  if (offerTjm >= profile.tjm.minimum * 0.8) return 0.3;
  return 0.0;
}

function scoreFreshness(datePublished: string | undefined): number {
  if (!datePublished) return 0.5;

  const published = new Date(datePublished).getTime();
  if (isNaN(published)) return 0.5;

  const ageInDays = (Date.now() - published) / (1000 * 60 * 60 * 24);

  if (ageInDays <= 1) return 1.0;
  if (ageInDays <= 3) return 0.8;
  if (ageInDays <= 7) return 0.6;
  if (ageInDays <= 14) return 0.4;
  if (ageInDays <= 30) return 0.2;
  return 0.1;
}

function scoreDomainRelevance(offer: ScrapedOffer): number {
  const text = `${offer.title} ${offer.description || ''}`.toLowerCase();

  let domainHits = 0;
  for (const keyword of DOMAIN_KEYWORDS) {
    if (text.includes(keyword)) domainHits++;
  }

  if (domainHits >= 3) return 1.0;
  if (domainHits >= 2) return 0.8;
  if (domainHits >= 1) return 0.6;
  return 0.2; // no domain keyword match at all
}

function scoreExperienceMatch(offer: ScrapedOffer, profile: Profile): number {
  const text = `${offer.title} ${offer.description || ''}`.toLowerCase();

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
  offer: ScrapedOffer,
  profile?: Profile,
): ScoringResult {
  const p = profile || loadProfile();
  const profileAliases = buildAliasSet(p.skills);
  const excludedSkills = new Set(p.excludedSkills.map((s) => s.toLowerCase()));

  const weights = SCORING_CONFIG.TIER1_WEIGHTS;

  const rawSkillMatch = scoreSkillMatch(
    offer.skills || [],
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
    tjmMatch: scoreTjmMatch(offer.tjmMin, offer.tjmMax, p),
    freshnessBonus: scoreFreshness(offer.datePublished),
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

/** Score all new offers in the DB and update their relevance_score. */
export function scoreNewOffers(
  offers: ScrapedOffer[],
): Array<{ offer: ScrapedOffer; score: number }> {
  const profile = loadProfile();
  const results: Array<{ offer: ScrapedOffer; score: number }> = [];

  for (const offer of offers) {
    const { score } = scoreOffer(offer, profile);
    results.push({ offer, score });
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}
