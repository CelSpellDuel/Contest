-- SpellDuel schema. Run once in Supabase → SQL Editor.

create table contests (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null,
  code text not null unique,
  capacity int not null default 16,
  security_mode text not null default 'strict',   -- strict | warning
  status text not null default 'lobby',           -- lobby | live | finished
  created_at timestamptz default now()
);
create table contestants (
  id uuid primary key default gen_random_uuid(),
  contest_id uuid not null references contests on delete cascade,
  user_id uuid not null default auth.uid(),
  name text not null,
  student_no text,
  wins int not null default 0,
  losses int not null default 0,
  status text not null default 'active',          -- active | eliminated | disqualified | champion
  created_at timestamptz default now(),
  unique (contest_id, user_id)
);
create table words (
  id uuid primary key default gen_random_uuid(),
  contest_id uuid not null references contests on delete cascade,
  word text not null, definition text not null, example text not null,
  used boolean not null default false,
  created_at timestamptz default now()
);
create table matches (
  id uuid primary key default gen_random_uuid(),
  contest_id uuid not null references contests on delete cascade,
  round int not null,
  p1 uuid references contestants on delete cascade,
  p2 uuid references contestants on delete cascade,   -- null = bye
  status text not null default 'pending',             -- pending | live | done
  word_len int, revealed_word text,                   -- the secret word itself is in match_secrets
  attempt int not null default 1,
  winner uuid,
  finished_at timestamptz,
  created_at timestamptz default now()
);
create table answers (
  id uuid primary key default gen_random_uuid(),
  contest_id uuid not null references contests on delete cascade,
  match_id uuid not null references matches on delete cascade,
  contestant_id uuid not null references contestants on delete cascade,
  attempt int not null,
  answer text not null,
  created_at timestamptz default now(),
  unique (match_id, contestant_id, attempt)
);
create table security_events (
  id uuid primary key default gen_random_uuid(),
  contest_id uuid not null references contests on delete cascade,
  contestant_id uuid not null references contestants on delete cascade,
  reason text not null,
  severity text not null default 'dq',                -- warning | dq
  created_at timestamptz default now()
);

-- Helpers
create function is_teacher() returns boolean language sql stable as
$$ select auth.uid() is not null and coalesce((auth.jwt()->>'is_anonymous')::boolean, false) = false $$;
create function owns(cid uuid) returns boolean language sql stable security definer set search_path = public as
$$ select exists (select 1 from contests where id = cid and owner_id = auth.uid()) $$;
create function is_me(pid uuid) returns boolean language sql stable security definer set search_path = public as
$$ select exists (select 1 from contestants where id = pid and user_id = auth.uid()) $$;

alter table contests enable row level security;
alter table contestants enable row level security;
alter table words enable row level security;
alter table matches enable row level security;
alter table answers enable row level security;
alter table security_events enable row level security;

-- contests: anyone can look one up (needed for join code + projector); only the teacher writes
create policy "read contests" on contests for select using (true);
create policy "teacher creates" on contests for insert with check (is_teacher() and owner_id = auth.uid());
create policy "owner edits" on contests for update using (owner_id = auth.uid());
create policy "owner deletes" on contests for delete using (owner_id = auth.uid());

-- contestants: students join their own row while the lobby is open and not full
create policy "read contestants" on contestants for select using (true);
create policy "student joins" on contestants for insert with check (
  user_id = auth.uid() and exists (
    select 1 from contests c where c.id = contest_id and c.status = 'lobby'
      and (select count(*) from contestants x where x.contest_id = c.id) < c.capacity));
create policy "owner manages contestants" on contestants for all using (owns(contest_id)) with check (owns(contest_id));

-- words: teacher only (students receive the current word through the live match row)
create policy "owner manages words" on words for all using (owns(contest_id)) with check (owns(contest_id));

-- matches: public read (projector/students), teacher writes
create policy "read matches" on matches for select using (true);
create policy "owner manages matches" on matches for all using (owns(contest_id)) with check (owns(contest_id));

-- answers: students write only their own answer to a live match; teacher reads all
create policy "student answers" on answers for insert with check (
  is_me(contestant_id) and exists (select 1 from matches m where m.id = match_id and m.status = 'live'));
create policy "read answers" on answers for select using (owns(contest_id) or is_me(contestant_id));
create policy "owner manages answers" on answers for all using (owns(contest_id)) with check (owns(contest_id));

-- security events
create policy "student reports" on security_events for insert with check (is_me(contestant_id));
create policy "owner reads events" on security_events for all using (owns(contest_id)) with check (owns(contest_id));

-- Secret word data: only the teacher, the two duelists of a live match, and a projector that knows the PIN can read it.
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

-- Realtime
alter publication supabase_realtime add table contests, contestants, matches, answers, security_events, match_secrets;
