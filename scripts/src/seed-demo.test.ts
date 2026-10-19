import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSeedSql } from './seed-demo.ts';
import {
  describeTarget,
  MIN_OFFICE_PASSWORD_LENGTH,
  parseSeedArgs,
  refuseTarget,
  STAGING_PROJECT_REF,
} from './seed-target.ts';

const SEED_FILE = join(import.meta.dirname, '..', '..', 'supabase', 'seed.sql');

describe('pnpm seed:demo', () => {
  it('regenerates the committed supabase/seed.sql byte for byte (Fri Oct 9 default)', () => {
    expect(readFileSync(SEED_FILE, 'utf8') === buildSeedSql()).toBe(true);
  });

  it('reads its flags', () => {
    expect(parseSeedArgs([])).toEqual({ apply: false, stdout: false, allowStaging: false });
    expect(parseSeedArgs(['--', '--date', 'today', '--apply'])).toMatchObject({
      apply: true,
      date: 'today',
    });
    expect(parseSeedArgs(['--date=2026-10-16', '--link-base=https://field.example'])).toMatchObject(
      {
        date: '2026-10-16',
        linkBase: 'https://field.example',
      },
    );
    expect(() => parseSeedArgs(['--date', 'tomorrow'])).toThrow(/today" or YYYY-MM-DD/);
    expect(() => parseSeedArgs(['--date'])).toThrow(/needs a value/);
    expect(() => parseSeedArgs(['--force'])).toThrow(/unknown argument/);
    expect(() => parseSeedArgs(['--link-base', 'go.talkolog.com'])).toThrow(/http/);
  });
});

describe('the apply target', () => {
  const local = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
  const staging = `postgresql://postgres.${STAGING_PROJECT_REF}:secret@aws-0-eu-central-1.pooler.supabase.com:5432/postgres`;
  // What every apply also needs: the field app's URL and its own office password.
  const ok = { linkBase: 'https://field-preview.example', officePassword: 'x'.repeat(16) };

  it('needs a postgres connection string', () => {
    expect(refuseTarget({ dbUrl: '', allowStaging: false, ...ok })).toMatch(
      /SUPABASE_DB_URL is not set/,
    );
    expect(
      refuseTarget({ dbUrl: 'https://example.supabase.co', allowStaging: false, ...ok }),
    ).toMatch(/not a postgres/);
    expect(refuseTarget({ dbUrl: local, allowStaging: false, ...ok })).toBeNull();
  });

  it('refuses the staging project unless --allow-staging is given', () => {
    expect(refuseTarget({ dbUrl: staging, allowStaging: false, ...ok })).toMatch(/staging project/);
    expect(
      refuseTarget({
        dbUrl: `postgresql://postgres:x@db.${STAGING_PROJECT_REF}.supabase.co:5432/postgres`,
        allowStaging: false,
        ...ok,
      }),
    ).toMatch(/staging project/);
    expect(
      refuseTarget({
        dbUrl: local,
        supabaseUrl: `https://${STAGING_PROJECT_REF}.supabase.co`,
        allowStaging: false,
        ...ok,
      }),
    ).toMatch(/staging project/);
    expect(refuseTarget({ dbUrl: staging, allowStaging: true, ...ok })).toBeNull();
  });

  it('needs the field app URL for the seeded links (--link-base or FIELD_APP_URL)', () => {
    const base = { dbUrl: local, allowStaging: false, officePassword: ok.officePassword };
    expect(refuseTarget(base)).toMatch(/--link-base or set FIELD_APP_URL/);
    expect(refuseTarget({ ...base, linkBase: '  ' })).toMatch(/--link-base or set FIELD_APP_URL/);
    expect(refuseTarget({ ...base, linkBase: 'field.example' })).toMatch(/http\(s\) URL/);
    expect(refuseTarget({ ...base, linkBase: 'http://localhost:5174' })).toBeNull();
  });

  it('needs its own office password, never the committed one', () => {
    const base = { dbUrl: local, allowStaging: false, linkBase: ok.linkBase };
    expect(refuseTarget(base)).toMatch(/DEMO_OFFICE_PASSWORD is not set/);
    expect(refuseTarget({ ...base, officePassword: 'sitelog-demo' })).toMatch(/must not be/);
    expect(
      refuseTarget({ ...base, officePassword: 'y'.repeat(MIN_OFFICE_PASSWORD_LENGTH - 1) }),
    ).toMatch(/too short/);
    expect(
      refuseTarget({ ...base, officePassword: 'y'.repeat(MIN_OFFICE_PASSWORD_LENGTH) }),
    ).toBeNull();
  });

  it("writes only the hash of the apply's office password, not seed.sql's password", () => {
    // What OFFICE_PASSWORD_HASH_SQL returns: the password itself never enters the script, whose
    // text a server may log (a failing statement, or every DDL-bearing one).
    const hash = '$2a$06$e21uF2kPqgSJku7DR8MMdOsyheuCAKDeJ3iFnId3W3u.HQkbujmn2';
    const apply = buildSeedSql({ officePasswordHash: hash, globalRows: false });
    expect(apply).not.toContain('sitelog-demo');
    expect(apply).toContain(`'authenticated', '${hash}', now()`);
    expect(apply).not.toContain('crypt(');
    expect(apply).toContain(
      'on conflict (id) do update set encrypted_password = excluded.encrypted_password;',
    );
    expect(() =>
      buildSeedSql({ officePasswordHash: 'correct horse battery staple', globalRows: false }),
    ).toThrow(/bcrypt hash, never the password/);
    // seed.sql (local stacks) keeps its password and leaves an existing user alone.
    const local = buildSeedSql();
    expect(local).toContain("crypt('sitelog-demo', gen_salt('bf'))");
    expect(local).not.toContain('do update set encrypted_password');
  });

  it('prints the target without the password', () => {
    expect(describeTarget(local)).toBe('postgres@127.0.0.1:54322/postgres');
    const printed = describeTarget(staging);
    expect(printed).toBe(
      `postgres.${STAGING_PROJECT_REF}@aws-0-eu-central-1.pooler.supabase.com:5432/postgres (Supabase project ${STAGING_PROJECT_REF})`,
    );
    expect(printed).not.toContain('secret');
    expect(
      describeTarget('postgresql://postgres:pw@db.abcdefghijklmnopqrst.supabase.co:5432/postgres'),
    ).toContain('(Supabase project abcdefghijklmnopqrst)');
  });
});
