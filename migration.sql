-- SpellDuel migration: hides the secret word from students and the public.
-- Run ONCE in Supabase -> SQL Editor on a database that already has the old schema, BEFORE deploying the new app files.
create table match_secrets (
  match_id uuid primary key references matches on delete cascade,
  contest_id uuid not null references contests on delete cascade,
  attempt int not null default 1,
  word text not null, definition text not null, example text,
  created_at timestamptz default now()
);
insert into match_secrets (match_id, contest_id, attempt, word, definition, example)
  select id, contest_id, attempt, word, coalesce(definition, ''), example from matches where word is not null;
alter table matches add column word_len int, add column revealed_word text;
update matches set word_len = length(word), revealed_word = case when status = 'done' then word end where word is not null;
alter table matches drop column word, drop column definition, drop column example;
alter table match_secrets enable row level security;
create policy "owner manages secrets" on match_secrets for all using (owns(contest_id)) with check (owns(contest_id));
create policy "duelists read live secret" on match_secrets for select using (
  exists (select 1 from matches m where m.id = match_id and m.status = 'live' and (is_me(m.p1) or is_me(m.p2))));
alter publication supabase_realtime add table match_secrets;

-- Projector PIN removed: safe to run even if you applied an earlier version of this migration.
drop function if exists projector_words(text, text);
drop table if exists contest_keys;
