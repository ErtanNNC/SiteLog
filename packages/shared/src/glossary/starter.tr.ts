import type { StarterTerm } from './starter.ts';

/**
 * The Turkish starter glossary (spec §19 Q238, W4-08; listed in spec §18.3 for the native-speaker
 * read, Q63): site words a Turkish site manager says → how a Turkish daily report writes them.
 * Written by SiteLog from the spec's own Turkish (§18.2's "döküm", "TBM / tool box") and common
 * Turkish site vocabulary (concrete, reinforcement, earthworks, finishes, İSG). No company, crew or
 * area names: those are the org's own. A new org whose report language is Turkish starts with
 * these as `built_in` (`seed_starter_glossary()`, 20261017000410_starter_glossary.sql, which must
 * hold the same rows: supabase/db-tests/src/starter-glossary.test.ts).
 */
export const STARTER_GLOSSARY_TR: readonly StarterTerm[] = [
  // Concrete and reinforcement
  { heard: 'döküm', official: 'Beton dökümü', kind: 'term' },
  { heard: 'grobeton', official: 'Grobeton (zayıf beton)', kind: 'term' },
  { heard: 'kür', official: 'Beton kürü', kind: 'term' },
  { heard: 'vibre', official: 'Beton vibrasyonu', kind: 'term' },
  { heard: 'pompa', official: 'Beton pompası', kind: 'term' },
  { heard: 'mikser', official: 'Transmikser', kind: 'term' },
  { heard: 'paspayı', official: 'Beton paspayı', kind: 'term' },
  { heard: 'filiz', official: 'Filiz donatısı', kind: 'term' },
  { heard: 'demir işleri', official: 'Donatı işleri', kind: 'term' },
  { heard: 'perde', official: 'Betonarme perde duvar', kind: 'term' },
  // Earthworks and machines
  { heard: 'hafriyat', official: 'Hafriyat (kazı) işleri', kind: 'term' },
  { heard: 'dolgu', official: 'Dolgu işleri', kind: 'term' },
  { heard: 'beko', official: 'Kazıcı yükleyici (beko loder)', kind: 'term' },
  // Finishes
  { heard: 'şap', official: 'Şap uygulaması', kind: 'term' },
  { heard: 'sıva', official: 'Sıva işleri', kind: 'term' },
  { heard: 'alçı', official: 'Alçı sıva', kind: 'term' },
  { heard: 'fayans', official: 'Fayans kaplama', kind: 'term' },
  { heard: 'izolasyon', official: 'Yalıtım işleri', kind: 'term' },
  { heard: 'mantolama', official: 'Dış cephe ısı yalıtımı (mantolama)', kind: 'term' },
  // Safety (İSG)
  { heard: 'TBM', official: 'İş güvenliği bilgilendirmesi', kind: 'term' },
  { heard: 'tool box', official: 'İş güvenliği bilgilendirmesi', kind: 'term' },
  { heard: 'İSG', official: 'İş sağlığı ve güvenliği', kind: 'term' },
  { heard: 'KKD', official: 'Kişisel koruyucu donanım', kind: 'term' },
  { heard: 'ramak kala', official: 'Ramak kala olay', kind: 'term' },
  // People and records
  { heard: 'taşeron', official: 'Alt yüklenici', kind: 'term' },
  { heard: 'puantaj', official: 'Puantaj (personel devam kaydı)', kind: 'term' },
  { heard: 'fazla mesai', official: 'Fazla mesai', kind: 'term' },
  // Units
  { heard: 'küp', official: 'm³', kind: 'unit' },
  { heard: 'metreküp', official: 'm³', kind: 'unit' },
];
