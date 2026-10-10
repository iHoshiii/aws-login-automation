-- Automatic execution is separate from the original manual review records.
-- The lease token coordinates workers; it is never an AWS credential.
begin;

alter table public.app_config add column auto_mode boolean not null default true;

create table public.automation_runs (
  id uuid primary key default gen_random_uuid(),
  local_date date not null unique,
  scheduled_at timestamptz not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running'
    check (status in ('running', 'verified', 'no_post', 'auth_required', 'failed', 'uncertain')),
  post_url text check (post_url ~ '^https://builder[.]aws[.]com/content/[A-Za-z0-9]+$'),
  post_title text check (length(post_title) between 1 and 300),
  account_profile_url text check (length(account_profile_url) <= 1000 and account_profile_url ~ '^https://builder[.]aws[.]com/[^?#[:space:]]+$'),
  error_message text check (length(error_message) <= 300),
  attempts integer not null default 1 check (attempts between 1 and 3),
  lease_token uuid not null default gen_random_uuid(),
  lease_until timestamptz not null default now() + interval '240 seconds',
  constraint automation_scheduled_manila_morning check (
    scheduled_at = (local_date::text || 'T01:00:00Z')::timestamptz
  )
);

create table public.automation_actions (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.automation_runs(id),
  activity_type text not null check (activity_type in ('visit', 'like', 'comment')),
  phase text not null default 'started' check (phase in ('started', 'verified', 'failed', 'uncertain', 'skipped')),
  attempted_at timestamptz not null default now(),
  verified_at timestamptz,
  post_url text not null check (post_url ~ '^https://builder[.]aws[.]com/content/[A-Za-z0-9]+$'),
  message text check (length(message) <= 300),
  unique (run_id, activity_type),
  constraint automation_action_verification_time check ((phase = 'verified') = (verified_at is not null))
);
create unique index unique_verified_automation_engagement
  on public.automation_actions (post_url, activity_type)
  where activity_type in ('like', 'comment') and phase = 'verified';
create index automation_actions_run on public.automation_actions (run_id);

create table public.automation_logs (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.automation_runs(id),
  created_at timestamptz not null default now(),
  event text not null check (length(event) between 1 and 80),
  message text not null check (length(message) <= 2000)
);
create index automation_logs_recent on public.automation_logs (created_at desc);

create table public.automation_notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.automation_runs(id),
  kind text not null check (kind in ('result', 'auth_required', 'failure')),
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed', 'uncertain')),
  claimed_at timestamptz,
  finished_at timestamptz,
  message text check (length(message) <= 300),
  unique (run_id, kind)
);

alter table public.automation_runs enable row level security;
alter table public.automation_actions enable row level security;
alter table public.automation_logs enable row level security;
alter table public.automation_notification_deliveries enable row level security;
revoke all on public.automation_runs, public.automation_actions, public.automation_logs,
  public.automation_notification_deliveries from public, anon, authenticated;
grant select, insert, update, delete on public.automation_runs, public.automation_actions,
  public.automation_logs, public.automation_notification_deliveries to service_role;

create function public.claim_automation_run(p_local_date date, p_scheduled_at timestamptz,
  p_retry boolean default false, p_account_profile_url text default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_config public.app_config%rowtype;
  v_run public.automation_runs%rowtype;
  v_existing boolean;
begin
  if p_local_date is null or p_scheduled_at is null
    or p_local_date <> (now() at time zone 'Asia/Manila')::date
    or p_scheduled_at <> (p_local_date::text || 'T01:00:00Z')::timestamptz then
    raise exception 'Only today''s Manila run at the configured schedule may be claimed';
  end if;
  -- All worker transitions use config -> run lock order, including pause checks.
  select * into strict v_config from public.app_config where id = 1 for update;
  if not v_config.enabled or not v_config.auto_mode then
    return jsonb_build_object('outcome', 'disabled', 'run', null, 'token', null);
  end if;
  select * into v_run from public.automation_runs where local_date = p_local_date for update;
  v_existing := found;
  if v_existing then
    if v_run.status = 'running' and v_run.lease_until > now() then
      return jsonb_build_object('outcome', 'existing', 'run', to_jsonb(v_run) - 'lease_token', 'token', null);
    end if;
    if v_run.status = 'running' and (
      exists (select 1 from public.automation_actions where run_id = v_run.id and phase in ('started', 'uncertain'))
      or exists (select 1 from public.automation_actions where run_id = v_run.id and activity_type in ('like', 'comment'))
    ) then
      update public.automation_actions set phase = 'uncertain', message = 'Worker expired after activity claim; automatic replay is blocked.'
        where run_id = v_run.id and phase = 'started';
      update public.automation_runs set status = 'uncertain', finished_at = now(),
        error_message = 'Worker lease expired after an activity claim. Check the post before any further engagement.'
        where id = v_run.id returning * into v_run;
      insert into public.automation_logs (run_id, event, message) values
        (v_run.id, 'lease_expired_uncertain', 'An expired activity claim cannot be repeated.');
      return jsonb_build_object('outcome', 'existing', 'run', to_jsonb(v_run) - 'lease_token', 'token', null);
    end if;
    if v_run.status <> 'running' and (
      v_run.status not in ('no_post', 'failed', 'auth_required') or not coalesce(p_retry, false)
      or exists (select 1 from public.automation_actions where run_id = v_run.id
        and (activity_type in ('like', 'comment') or phase in ('started', 'uncertain')))
    ) then
      return jsonb_build_object('outcome', 'existing', 'run', to_jsonb(v_run) - 'lease_token', 'token', null);
    end if;
    if v_run.attempts >= v_config.max_attempts then
      if v_run.status = 'running' then
        update public.automation_runs set status = 'failed', finished_at = now(), lease_until = now(),
          error_message = 'Worker expired before engagement and the daily retry limit is exhausted.'
          where id = v_run.id returning * into v_run;
        insert into public.automation_logs (run_id, event, message) values
          (v_run.id, 'automation_retry_limit', 'Expired worker settled as failed; no further daily worker attempts remain.');
      end if;
      return jsonb_build_object('outcome', 'retry_limit', 'run', to_jsonb(v_run) - 'lease_token', 'token', null);
    end if;
    -- A scheduler duplicate must never silently renew even a safe expired
    -- worker. The administrator explicitly requests every later attempt.
    if v_run.status = 'running' and not coalesce(p_retry, false) then
      return jsonb_build_object('outcome', 'existing', 'run', to_jsonb(v_run) - 'lease_token', 'token', null);
    end if;
    if v_run.account_profile_url is not null and p_account_profile_url is distinct from v_run.account_profile_url then
      raise exception 'A retry must use the same account profile';
    end if;
    insert into public.automation_logs (run_id, event, message)
      select v_run.id, 'retry_visit_snapshot',
        jsonb_build_object('phase', phase, 'post_url', post_url, 'message', message)::text
      from public.automation_actions where run_id = v_run.id and activity_type = 'visit'
        and phase in ('failed', 'skipped');
    delete from public.automation_actions where run_id = v_run.id and activity_type = 'visit'
      and phase in ('failed', 'skipped');
    update public.automation_runs set status = 'running', started_at = now(), finished_at = null,
      error_message = null, attempts = attempts + 1, lease_token = gen_random_uuid(),
      account_profile_url = coalesce(account_profile_url, p_account_profile_url),
      lease_until = now() + interval '240 seconds' where id = v_run.id returning * into v_run;
  else
    insert into public.automation_runs (local_date, scheduled_at, account_profile_url)
      values (p_local_date, p_scheduled_at, p_account_profile_url) returning * into v_run;
  end if;
  insert into public.automation_logs (run_id, event, message) values
    (v_run.id, case when v_existing then 'automation_reclaimed' else 'automation_claimed' end,
      'Automatic worker claimed attempt ' || v_run.attempts || '.');
  return jsonb_build_object('outcome', 'claimed', 'run', to_jsonb(v_run) - 'lease_token', 'token', v_run.lease_token);
end;
$$;

create function public.assign_automation_post(p_run_id uuid, p_token uuid, p_url text, p_title text)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare
  v_config public.app_config%rowtype;
  v_run public.automation_runs%rowtype;
begin
  if p_url is null or p_url !~ '^https://builder[.]aws[.]com/content/[A-Za-z0-9]+$'
    or p_title is null or length(p_title) not between 1 and 300 then
    raise exception 'Invalid automatic post';
  end if;
  select * into strict v_config from public.app_config where id = 1 for update;
  select * into strict v_run from public.automation_runs where id = p_run_id for update;
  if not v_config.enabled or not v_config.auto_mode or v_run.status <> 'running'
    or v_run.lease_token is distinct from p_token or v_run.lease_until <= now()
    or v_run.local_date <> (now() at time zone 'Asia/Manila')::date then return false; end if;
  if exists (select 1 from public.automation_actions where run_id = p_run_id) then
    -- A previously verified visit is reusable only for the exact same candidate.
    return v_run.post_url = p_url and not exists (select 1 from public.automation_actions where run_id = p_run_id
      and (activity_type <> 'visit' or phase <> 'verified'));
  end if;
  if exists (select 1 from public.automation_actions where post_url = p_url
    and activity_type in ('like', 'comment') and phase in ('started', 'verified', 'uncertain'))
    or exists (select 1 from public.automation_runs where id <> p_run_id and post_url = p_url
      and (status in ('verified', 'uncertain') or (status = 'running' and lease_until > now())))
    or exists (select 1 from public.queued_posts where url = p_url and state in ('reserved', 'used'))
    or exists (select 1 from public.post_activities where post_url = p_url
      and activity_type in ('like', 'comment') and status in ('user_reported', 'already_done', 'uncertain')) then
    return false;
  end if;
  update public.automation_runs set post_url = p_url, post_title = p_title where id = p_run_id;
  insert into public.automation_logs (run_id, event, message) values
    (p_run_id, 'post_selected', 'Selected ' || p_url || '.');
  return true;
end;
$$;

create function public.begin_automation_action(p_run_id uuid, p_token uuid, p_activity_type text)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare
  v_config public.app_config%rowtype;
  v_run public.automation_runs%rowtype;
begin
  if p_activity_type is null or p_activity_type not in ('visit', 'like', 'comment') then
    raise exception 'Invalid automatic activity';
  end if;
  select * into strict v_config from public.app_config where id = 1 for update;
  select * into strict v_run from public.automation_runs where id = p_run_id for update;
  if not v_config.enabled or not v_config.auto_mode or v_run.status <> 'running'
    or v_run.lease_token is distinct from p_token or v_run.lease_until <= now()
    or v_run.local_date <> (now() at time zone 'Asia/Manila')::date or v_run.post_url is null then return false; end if;
  if exists (select 1 from public.automation_actions where run_id = p_run_id and activity_type = p_activity_type)
    or exists (select 1 from public.automation_actions where run_id = p_run_id and phase in ('started', 'uncertain')) then
    return false;
  end if;
  if p_activity_type in ('like', 'comment') and not exists (
    select 1 from public.automation_actions where run_id = p_run_id and activity_type = 'visit' and phase = 'verified'
  ) then return false; end if;
  if p_activity_type = 'comment' and not exists (
    select 1 from public.automation_actions where run_id = p_run_id and activity_type = 'like' and phase = 'verified'
  ) then return false; end if;
  if p_activity_type in ('like', 'comment') and (
    exists (select 1 from public.automation_actions where run_id <> p_run_id and post_url = v_run.post_url
      and activity_type in ('like', 'comment') and phase in ('started', 'verified', 'uncertain'))
    or exists (select 1 from public.queued_posts where url = v_run.post_url and
      (state = 'reserved' or (state = 'used' and not exists (
        select 1 from public.automation_actions where run_id = p_run_id
          and activity_type = 'like' and phase = 'verified'
      ))))
    or exists (select 1 from public.post_activities where post_url = v_run.post_url
      and activity_type in ('like', 'comment') and status in ('user_reported', 'already_done', 'uncertain'))
  ) then return false; end if;
  -- This transaction must commit before the worker performs the external action.
  insert into public.automation_actions (run_id, activity_type, post_url)
    values (p_run_id, p_activity_type, v_run.post_url);
  if p_activity_type in ('like', 'comment') then
    -- The shared config lock prevents manual preparation from reserving this
    -- candidate after the first automatic engagement claim has committed.
    update public.queued_posts set state = 'used' where url = v_run.post_url and state = 'available';
  end if;
  insert into public.automation_logs (run_id, event, message) values
    (p_run_id, 'action_started', p_activity_type || ': durable claim recorded before the browser action.');
  return true;
end;
$$;

create function public.assert_automation_action_ready(p_run_id uuid, p_token uuid, p_activity_type text)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare
  v_config public.app_config%rowtype;
  v_run public.automation_runs%rowtype;
begin
  if p_activity_type is null or p_activity_type not in ('visit', 'like', 'comment') then
    raise exception 'Invalid automatic activity';
  end if;
  select * into strict v_config from public.app_config where id = 1 for update;
  select * into strict v_run from public.automation_runs where id = p_run_id for update;
  if not v_config.enabled or not v_config.auto_mode or v_run.status <> 'running'
    or v_run.lease_token is distinct from p_token or v_run.lease_until <= now()
    or v_run.local_date <> (now() at time zone 'Asia/Manila')::date or v_run.post_url is null then return false; end if;
  -- Navigation and comment inspection can take time after a durable claim. The
  -- browser calls this again immediately before an actual external submission.
  return exists (select 1 from public.automation_actions where run_id = p_run_id
    and activity_type = p_activity_type and phase = 'started' and post_url = v_run.post_url);
end;
$$;

create function public.finish_automation_action(p_run_id uuid, p_token uuid, p_activity_type text, p_phase text, p_message text default '')
returns void language plpgsql security invoker set search_path = '' as $$
declare
  v_run public.automation_runs%rowtype;
  v_action public.automation_actions%rowtype;
begin
  if p_activity_type is null or p_activity_type not in ('visit', 'like', 'comment')
    or p_phase is null or p_phase not in ('verified', 'failed', 'uncertain', 'skipped')
    or length(coalesce(p_message, '')) > 300 then raise exception 'Invalid automatic activity result'; end if;
  perform 1 from public.app_config where id = 1 for update;
  select * into strict v_run from public.automation_runs where id = p_run_id for update;
  if v_run.lease_token is distinct from p_token or v_run.status <> 'running'
    or (v_run.lease_until <= now() and p_phase <> 'uncertain') then
    raise exception 'Worker lease is stale';
  end if;
  select * into strict v_action from public.automation_actions
    where run_id = p_run_id and activity_type = p_activity_type for update;
  if v_action.phase = p_phase then return; end if;
  if v_action.phase <> 'started' then raise exception 'A settled activity cannot be replayed or changed'; end if;
  update public.automation_actions set phase = p_phase,
    verified_at = case when p_phase = 'verified' then now() else null end,
    message = nullif(coalesce(p_message, ''), '') where id = v_action.id;
  insert into public.automation_logs (run_id, event, message) values
    (p_run_id, 'action_result', p_activity_type || ': ' || p_phase || '. ' || coalesce(p_message, ''));
end;
$$;

create function public.finish_automation_run(p_run_id uuid, p_token uuid, p_status text, p_message text default '')
returns void language plpgsql security invoker set search_path = '' as $$
declare
  v_run public.automation_runs%rowtype;
begin
  if p_status is null or p_status not in ('verified', 'no_post', 'auth_required', 'failed', 'uncertain')
    or length(coalesce(p_message, '')) > 300 then raise exception 'Invalid automatic run result'; end if;
  perform 1 from public.app_config where id = 1 for update;
  select * into strict v_run from public.automation_runs where id = p_run_id for update;
  if v_run.lease_token is distinct from p_token then raise exception 'Worker lease is stale'; end if;
  if v_run.status = p_status then return; end if;
  if v_run.status <> 'running' or (v_run.lease_until <= now() and p_status <> 'uncertain') then
    raise exception 'Worker lease is stale';
  end if;
  if p_status = 'verified' and (select count(*) from public.automation_actions
    where run_id = p_run_id and phase = 'verified') <> 3 then
    raise exception 'All three activities require observed verification';
  end if;
  if p_status <> 'uncertain' and exists (
    select 1 from public.automation_actions where run_id = p_run_id and phase in ('started', 'uncertain')
  ) then raise exception 'An unresolved activity requires an uncertain run'; end if;
  if p_status = 'no_post' and (v_run.post_url is not null or exists (
    select 1 from public.automation_actions where run_id = p_run_id
  )) then raise exception 'An assigned post cannot be recorded as no post'; end if;
  if p_status = 'uncertain' then
    update public.automation_actions set phase = 'uncertain', message = 'Run ended before the activity was verified.'
      where run_id = p_run_id and phase = 'started';
  end if;
  update public.automation_runs set status = p_status, finished_at = now(), lease_until = now(),
    error_message = case when p_status = 'verified' then null else nullif(coalesce(p_message, ''), '') end
    where id = p_run_id;
  insert into public.automation_logs (run_id, event, message) values
    (p_run_id, 'automation_result', p_status || '. ' || coalesce(p_message, ''));
end;
$$;

create function public.append_automation_log(p_run_id uuid, p_token uuid, p_event text, p_message text)
returns void language plpgsql security invoker set search_path = '' as $$
declare
  v_run public.automation_runs%rowtype;
begin
  if p_event is null or length(p_event) not between 1 and 80 or p_message is null or length(p_message) > 2000 then
    raise exception 'Invalid automatic log';
  end if;
  perform 1 from public.app_config where id = 1 for update;
  select * into strict v_run from public.automation_runs where id = p_run_id for update;
  if v_run.lease_token is distinct from p_token or v_run.status <> 'running' or v_run.lease_until <= now() then
    raise exception 'Worker lease is stale';
  end if;
  insert into public.automation_logs (run_id, event, message) values (p_run_id, p_event, p_message);
end;
$$;

create function public.claim_automation_notification(p_run_id uuid, p_kind text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_config public.app_config%rowtype;
  v_run public.automation_runs%rowtype;
  v_delivery public.automation_notification_deliveries%rowtype;
begin
  if p_kind is null or p_kind not in ('result', 'auth_required', 'failure') then
    raise exception 'Invalid automatic notification kind';
  end if;
  select * into strict v_config from public.app_config where id = 1 for update;
  select * into strict v_run from public.automation_runs where id = p_run_id for update;
  if not v_config.notifications_enabled or v_run.status = 'running'
    or v_run.local_date <> (now() at time zone 'Asia/Manila')::date then return null; end if;
  insert into public.automation_notification_deliveries (run_id, kind) values (p_run_id, p_kind)
    on conflict (run_id, kind) do nothing;
  update public.automation_notification_deliveries set status = 'sending', claimed_at = now()
    where run_id = p_run_id and kind = p_kind and status = 'pending' returning * into v_delivery;
  if not found then return null; end if;
  insert into public.automation_logs (run_id, event, message) values
    (p_run_id, 'notification_claimed', p_kind || ': sending. Repeated invocations cannot resend.');
  return to_jsonb(v_run) - 'lease_token';
end;
$$;

create function public.finish_automation_notification(p_run_id uuid, p_kind text, p_status text, p_message text default '')
returns void language plpgsql security invoker set search_path = '' as $$
declare
  v_delivery public.automation_notification_deliveries%rowtype;
begin
  if p_kind is null or p_kind not in ('result', 'auth_required', 'failure')
    or p_status is null or p_status not in ('sent', 'failed', 'uncertain')
    or length(coalesce(p_message, '')) > 300 then raise exception 'Invalid automatic notification result'; end if;
  perform 1 from public.app_config where id = 1 for update;
  perform 1 from public.automation_runs where id = p_run_id for update;
  select * into strict v_delivery from public.automation_notification_deliveries
    where run_id = p_run_id and kind = p_kind for update;
  if v_delivery.status = p_status then return; end if;
  if v_delivery.status <> 'sending' then raise exception 'Notification is unclaimed or already settled'; end if;
  update public.automation_notification_deliveries set status = p_status, finished_at = now(),
    message = nullif(coalesce(p_message, ''), '') where id = v_delivery.id;
  insert into public.automation_logs (run_id, event, message) values
    (p_run_id, 'notification_result', p_kind || ': ' || p_status || '. ' || coalesce(p_message, ''));
end;
$$;

revoke all on function public.claim_automation_run(date, timestamptz, boolean, text),
  public.assign_automation_post(uuid, uuid, text, text), public.begin_automation_action(uuid, uuid, text),
  public.assert_automation_action_ready(uuid, uuid, text),
  public.finish_automation_action(uuid, uuid, text, text, text), public.finish_automation_run(uuid, uuid, text, text),
  public.append_automation_log(uuid, uuid, text, text), public.claim_automation_notification(uuid, text),
  public.finish_automation_notification(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.claim_automation_run(date, timestamptz, boolean, text),
  public.assign_automation_post(uuid, uuid, text, text), public.begin_automation_action(uuid, uuid, text),
  public.assert_automation_action_ready(uuid, uuid, text),
  public.finish_automation_action(uuid, uuid, text, text, text), public.finish_automation_run(uuid, uuid, text, text),
  public.append_automation_log(uuid, uuid, text, text), public.claim_automation_notification(uuid, text),
  public.finish_automation_notification(uuid, text, text, text) to service_role;

commit;
