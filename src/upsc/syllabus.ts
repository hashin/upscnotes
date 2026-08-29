/**
 * Condensed UPSC Civil Services (Mains) syllabus tree, used for the tag picker and the
 * seeded folder structure. Codes are stable strings so notes keep their tags across edits.
 */

export interface SyllabusNode {
  code: string;
  label: string;
  children?: SyllabusNode[];
}

export const SECTIONS: SyllabusNode[] = [
  {
    code: 'GS1',
    label: 'GS Paper I — Heritage, History, Geography, Society',
    children: [
      { code: 'GS1/Culture', label: 'Indian Culture — art, architecture, literature' },
      { code: 'GS1/ModernHistory', label: 'Modern Indian History (1750s–1947)' },
      { code: 'GS1/FreedomStruggle', label: 'The Freedom Struggle' },
      { code: 'GS1/PostIndependence', label: 'Post-independence consolidation' },
      { code: 'GS1/WorldHistory', label: 'World History (18th c. onwards)' },
      { code: 'GS1/Society', label: 'Indian Society — diversity, women, population' },
      { code: 'GS1/Urbanisation', label: 'Urbanisation — problems and remedies' },
      { code: 'GS1/Globalization', label: 'Effects of globalization on society' },
      { code: 'GS1/SocialEmpowerment', label: 'Social empowerment, communalism, secularism' },
      { code: 'GS1/PhysicalGeography', label: 'World physical geography' },
      { code: 'GS1/ResourceGeography', label: 'Distribution of natural resources' },
      { code: 'GS1/GeoPhenomena', label: 'Geophysical phenomena — quakes, cyclones' },
    ],
  },
  {
    code: 'GS2',
    label: 'GS Paper II — Polity, Governance, IR',
    children: [
      { code: 'GS2/Constitution', label: 'Constitution — features, amendments, basic structure' },
      { code: 'GS2/FederalStructure', label: 'Federalism — devolution, local government' },
      { code: 'GS2/SeparationOfPowers', label: 'Separation of powers, dispute redressal' },
      { code: 'GS2/Parliament', label: 'Parliament and State legislatures' },
      { code: 'GS2/Executive', label: 'Executive and Judiciary — structure, functioning' },
      { code: 'GS2/ConstitutionalBodies', label: 'Constitutional and statutory bodies' },
      { code: 'GS2/Governance', label: 'Governance, transparency, e-governance, RTI' },
      { code: 'GS2/Welfare', label: 'Welfare schemes and vulnerable sections' },
      { code: 'GS2/HealthEducation', label: 'Health, education, human resources' },
      { code: 'GS2/Poverty', label: 'Poverty and hunger' },
      { code: 'GS2/IR-Neighbours', label: 'India and its neighbourhood' },
      { code: 'GS2/IR-Groupings', label: 'Bilateral, regional and global groupings' },
      { code: 'GS2/IR-Diaspora', label: 'Indian diaspora' },
      { code: 'GS2/IR-Institutions', label: 'International institutions — UN, WTO, etc.' },
    ],
  },
  {
    code: 'GS3',
    label: 'GS Paper III — Economy, Environment, Sci-Tech, Security',
    children: [
      { code: 'GS3/Economy', label: 'Indian economy — planning, growth, employment' },
      { code: 'GS3/Budgeting', label: 'Government budgeting' },
      { code: 'GS3/Agriculture', label: 'Agriculture — cropping, irrigation, MSP, storage' },
      { code: 'GS3/FoodProcessing', label: 'Food processing and supply chain' },
      { code: 'GS3/LandReforms', label: 'Land reforms' },
      { code: 'GS3/Infrastructure', label: 'Infrastructure — energy, ports, roads, railways' },
      { code: 'GS3/Investment', label: 'Investment models' },
      { code: 'GS3/SciTech', label: 'Science and technology — developments, indigenisation' },
      { code: 'GS3/IPR', label: 'Awareness in IT, space, biotech, IPR' },
      { code: 'GS3/Environment', label: 'Environment — conservation, pollution, EIA' },
      { code: 'GS3/DisasterManagement', label: 'Disaster and disaster management' },
      { code: 'GS3/InternalSecurity', label: 'Internal security — extremism, borders, cyber' },
      { code: 'GS3/SecurityForces', label: 'Security forces and agencies, money laundering' },
    ],
  },
  {
    code: 'GS4',
    label: 'GS Paper IV — Ethics, Integrity, Aptitude',
    children: [
      { code: 'GS4/EthicsEssence', label: 'Ethics — essence, determinants, consequences' },
      { code: 'GS4/Attitude', label: 'Attitude — content, structure, persuasion' },
      { code: 'GS4/Aptitude', label: 'Aptitude and foundational values for civil service' },
      { code: 'GS4/EmotionalIntelligence', label: 'Emotional intelligence' },
      { code: 'GS4/Thinkers', label: 'Contributions of moral thinkers and philosophers' },
      { code: 'GS4/PublicAdminEthics', label: 'Public/civil service values and ethics in governance' },
      { code: 'GS4/Probity', label: 'Probity in governance — RTI, codes, challenges' },
      { code: 'GS4/CaseStudies', label: 'Case studies' },
    ],
  },
  {
    code: 'Essay',
    label: 'Essay Paper',
    children: [
      { code: 'Essay/Philosophical', label: 'Philosophical / abstract themes' },
      { code: 'Essay/SocioEconomic', label: 'Socio-economic themes' },
      { code: 'Essay/PolityGovernance', label: 'Polity and governance themes' },
      { code: 'Essay/SciTechEnv', label: 'Science, technology, environment themes' },
      { code: 'Essay/Quotes', label: 'Quotes, anecdotes, examples bank' },
    ],
  },
  {
    code: 'CurrentAffairs',
    label: 'Current Affairs',
    children: [
      { code: 'CurrentAffairs/Polity', label: 'Polity and governance' },
      { code: 'CurrentAffairs/Economy', label: 'Economy' },
      { code: 'CurrentAffairs/IR', label: 'International relations' },
      { code: 'CurrentAffairs/EnvSciTech', label: 'Environment, science and technology' },
      { code: 'CurrentAffairs/Reports', label: 'Reports, indices, schemes' },
    ],
  },
  {
    code: 'Prelims',
    label: 'Prelims',
    children: [
      { code: 'Prelims/Facts', label: 'Fact and revision cards' },
      { code: 'Prelims/CSAT', label: 'CSAT' },
      { code: 'Prelims/PYQ', label: 'Previous year questions' },
    ],
  },
  {
    code: 'Optional',
    label: 'Optional Subject',
    children: [
      { code: 'Optional/Paper1', label: 'Optional — Paper I' },
      { code: 'Optional/Paper2', label: 'Optional — Paper II' },
      { code: 'Optional/AnswerBank', label: 'Optional — model answers and diagrams' },
    ],
  },
];

const flat: SyllabusNode[] = [];
for (const s of SECTIONS) {
  flat.push({ code: s.code, label: s.label });
  for (const c of s.children ?? []) flat.push(c);
}
export const SYLLABUS_FLAT = flat;

export function syllabusLabel(code: string): string {
  return flat.find((n) => n.code === code)?.label ?? code;
}
