-- SpellDuel migration: hides the secret word from students and the public.
-- Run ONCE in Supabase -> SQL Editor on a database that already has the old schema, BEFORE deploying the new app files.
create table match_secrets (
  match_id uuid primary key references matches on delete cascade,
  contest_id uuid not null references contests on delete cascade,
  attempt int not null default 1,
  word text not null, definition text not null, example text,
  created_at timestamptz default now()
);
create table contest_keys (
  contest_id uuid primary key references contests on delete cascade,
  projector_pin text not null default upper(substr(md5(random()::text || clock_timestamp()::text), 1, 8))
);
insert into match_secrets (match_id, contest_id, attempt, word, definition, example)
  select id, contest_id, attempt, word, coalesce(definition, ''), example from matches where word is not null;
insert into contest_keys (contest_id) select id from contests;
alter table matches add column word_len int, add column revealed_word text;
update matches set word_len = length(word), revealed_word = case when status = 'done' then word end where word is not null;
alter table matches drop column word, drop column definition, drop column example;
alter table match_secrets enable row level security;
alter table contest_keys enable row level security;
create policy "owner manages secrets" on match_secrets for all using (owns(contest_id)) with check (owns(contest_id));
create policy "duelists read live secret" on match_secrets for select using (
  exists (select 1 from matches m where m.id = match_id and m.status = 'live' and (is_me(m.p1) or is_me(m.p2))));
create policy "owner manages keys" on contest_keys for all using (owns(contest_id)) with check (owns(contest_id));
create function projector_words(p_code text, p_pin text)
returns table(match_id uuid, attempt int, word text, definition text, example text)
language sql stable security definer set search_path = public as
$$ select s.match_id, s.attempt, s.word, s.definition, s.example
   from contests c
   join contest_keys k on k.contest_id = c.id
   join matches m on m.contest_id = c.id and m.status = 'live'
   join match_secrets s on s.match_id = m.id
   where c.code = upper(p_code) and k.projector_pin = upper(p_pin) $$;
grant execute on function projector_words(text, text) to anon, authenticated;
alter publication supabase_realtime add table match_secrets;
