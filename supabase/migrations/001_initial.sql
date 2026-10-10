-- Apply once using the Supabase SQL editor or CLI migrations.
-- All application data is private; the Next.js server uses a secret/service-role key.
begin;

create table public.app_config (
  id integer primary key default 1 check (id = 1),
  enabled boolean not null default true,
  schedule text not null default '0 1 * * *' check (schedule = '0 1 * * *'),
  time_zone text not null default 'Asia/Manila' check (time_zone = 'Asia/Manila'),
  max_attempts integer not null default 2 check (max_attempts between 1 and 3),
  notifications_enabled boolean not null default false
);
insert into public.app_config (id) values (1);

create table public.queued_posts (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(title) between 1 and 300),
  url text not null unique check (url ~ '^https://builder[.]aws[.]com/content/[A-Za-z0-9]+$'),
  state text not null default 'available' check (state in ('available', 'reserved', 'used')),
  created_at timestamptz not null default now()
);

create table public.daily_runs (
  id uuid primary key default gen_random_uuid(),
  local_date date not null unique,
  scheduled_at timestamptz not null,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  status text not null check (status in ('pending_review', 'no_post', 'failed', 'auth_required', 'complete')),
  attempt_count integer not null default 1 check (attempt_count between 1 and 3),
  post_id uuid references public.queued_posts(id),
  post_url text,
  post_title text,
  error_message text check (length(error_message) <= 300),
  notification_status text not null default 'disabled' check (notification_status in ('pending', 'sending', 'sent', 'failed', 'uncertain', 'disabled')),
  constraint scheduled_manila_morning check (
    scheduled_at = (local_date::text || 'T01:00:00Z')::timestamptz
  )
);

create table public.post_activities (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.daily_runs(id),
  post_url text,
  activity_type text not null check (activity_type in ('visit', 'like', 'comment')),
  status text not null default 'pending' check (status in ('pending', 'user_reported', 'already_done', 'skipped', 'failed', 'uncertain')),
  attempted_at timestamptz,
  message text check (length(message) <= 300),
  unique (run_id, activity_type)
);
create unique index unique_reported_engagement_per_post
  on public.post_activities (post_url, activity_type)
  where post_url is not null and activity_type in ('like', 'comment')
    and status in ('user_reported', 'already_done');

create table public.execution_logs (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references public.daily_runs(id),
  created_at timestamptz not null default now(),
  event text not null check (length(event) between 1 and 80),
  message text not null check (length(message) <= 2000)
);

create table public.notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.daily_runs(id),
  kind text not null check (kind in ('review', 'auth_required', 'activity_failed')),
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed', 'uncertain')),
  claimed_at timestamptz,
  finished_at timestamptz,
  message text check (length(message) <= 300),
  unique (run_id, kind)
);

create index queued_posts_available on public.queued_posts (created_at, id) where state = 'available';
create index execution_logs_recent on public.execution_logs (created_at desc);
create index post_activities_run on public.post_activities (run_id);

alter table public.app_config enable row level security;
alter table public.queued_posts enable row level security;
alter table public.daily_runs enable row level security;
alter table public.post_activities enable row level security;
alter table public.execution_logs enable row level security;
alter table public.notification_deliveries enable row level security;
revoke all on public.app_config, public.queued_posts, public.daily_runs,
  public.post_activities, public.execution_logs, public.notification_deliveries from public, anon, authenticated;
grant select, insert, update, delete on public.app_config, public.queued_posts,
  public.daily_runs, public.post_activities, public.execution_logs, public.notification_deliveries to service_role;

create function public.prepare_daily_run(p_local_date date, p_scheduled_at timestamptz, p_retry boolean default false)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_config public.app_config%rowtype;
  v_run public.daily_runs%rowtype;
  v_post public.queued_posts%rowtype;
  v_existing boolean;
begin
  if p_local_date is null or p_scheduled_at is null
    or p_local_date <> (now() at time zone 'Asia/Manila')::date
    or p_scheduled_at <> (p_local_date::text || 'T01:00:00Z')::timestamptz then
    raise exception 'Only today''s Manila run at the configured schedule may be prepared';
  end if;
  -- A single durable lock serializes even simultaneous first-run requests.
  select * into strict v_config from public.app_config where id = 1 for update;
  if not v_config.enabled then
    return jsonb_build_object('outcome', 'disabled', 'run', null);
  end if;
  select * into v_run from public.daily_runs where local_date = p_local_date for update;
  v_existing := found;
  if v_existing then
    if not coalesce(p_retry, false) or v_run.status <> 'no_post' then
      return jsonb_build_object('outcome', 'existing', 'run', to_jsonb(v_run));
    end if;
    if v_run.attempt_count >= v_config.max_attempts then
      return jsonb_build_object('outcome', 'retry_limit', 'run', to_jsonb(v_run));
    end if;
    update public.daily_runs set attempt_count = attempt_count + 1,
      started_at = now(), completed_at = null, error_message = null
      where id = v_run.id returning * into v_run;
  else
    insert into public.daily_runs (local_date, scheduled_at, status, notification_status)
      values (p_local_date, p_scheduled_at, 'no_post',
        case when v_config.notifications_enabled then 'pending' else 'disabled' end)
      returning * into v_run;
    insert into public.post_activities (run_id, activity_type)
      select v_run.id, t from unnest(array['visit', 'like', 'comment']) t;
    if v_config.notifications_enabled then
      insert into public.notification_deliveries (run_id, kind) values (v_run.id, 'review');
    end if;
  end if;
  select * into v_post from public.queued_posts where state = 'available'
    order by created_at, id limit 1 for update skip locked;
  if found then
    update public.queued_posts set state = 'reserved' where id = v_post.id;
    update public.daily_runs set post_id = v_post.id, post_url = v_post.url,
      post_title = v_post.title, status = 'pending_review', completed_at = null
      where id = v_run.id returning * into v_run;
    insert into public.execution_logs (run_id, event, message)
      select v_run.id, 'retry_activity_snapshot',
        jsonb_build_object('type', activity_type, 'status', status,
          'attempted_at', attempted_at, 'message', message)::text
      from public.post_activities where run_id = v_run.id and status <> 'pending';
    update public.post_activities set post_url = v_post.url,
      status = case when activity_type = 'visit' then status else 'pending' end,
      attempted_at = case when activity_type = 'visit' then attempted_at else null end,
      message = case when activity_type = 'visit' then message else null end
      where run_id = v_run.id;
  else
    update public.daily_runs set status = 'no_post', completed_at = now(),
      error_message = 'No unused post is queued. Add a post and explicitly retry within the daily limit.'
      where id = v_run.id returning * into v_run;
  end if;
  insert into public.execution_logs (run_id, event, message) values
    (v_run.id, case when v_existing then 'daily_retry' else 'daily_prepared' end,
      'Manual review status: ' || v_run.status || '. Attempt ' || v_run.attempt_count || '. No AWS actions performed.');
  return jsonb_build_object('outcome', 'created', 'run', to_jsonb(v_run));
end;
$$;

create function public.report_activity(p_run_id uuid, p_activity_type text, p_status text, p_message text default '')
returns void language plpgsql security invoker set search_path = '' as $$
declare
  v_run public.daily_runs%rowtype;
  v_activity public.post_activities%rowtype;
  v_complete boolean;
begin
  if p_activity_type not in ('visit', 'like', 'comment') or p_status not in
    ('user_reported', 'already_done', 'skipped', 'failed', 'uncertain')
    or p_activity_type is null or p_status is null or length(coalesce(p_message, '')) > 300 then
    raise exception 'Invalid manual activity report';
  end if;
  select * into strict v_run from public.daily_runs where id = p_run_id for update;
  if v_run.local_date <> (now() at time zone 'Asia/Manila')::date then
    raise exception 'Historic runs cannot receive new daily activity';
  end if;
  select * into strict v_activity from public.post_activities
    where run_id = p_run_id and activity_type = p_activity_type for update;
  if v_activity.status in ('user_reported', 'already_done', 'uncertain') then
    if v_activity.status = p_status then return; end if;
    raise exception 'A completed or uncertain activity cannot be replayed or downgraded';
  end if;
  if p_activity_type in ('like', 'comment') and v_run.post_id is null
    and p_status in ('user_reported', 'already_done', 'uncertain') then
    raise exception 'An assigned post is required for engagement reports';
  end if;
  update public.post_activities set status = p_status, attempted_at = now(),
    message = nullif(coalesce(p_message, ''), '') where id = v_activity.id;
  if p_activity_type in ('like', 'comment') and p_status in ('user_reported', 'already_done', 'uncertain') then
    update public.queued_posts set state = 'used' where id = v_run.post_id;
  end if;
  select bool_and(status = 'user_reported') into v_complete
    from public.post_activities where run_id = p_run_id;
  update public.daily_runs set
    status = case when v_run.status = 'auth_required' then 'auth_required'
      when v_complete then 'complete' when post_id is null then 'no_post' else 'pending_review' end,
    completed_at = case when v_run.status = 'auth_required' then null
      when v_complete or post_id is null then now() else null end,
    error_message = case when v_run.status = 'auth_required' then v_run.error_message
      when p_status = 'failed' then 'A manually reported activity failed.' else null end
    where id = p_run_id;
  insert into public.execution_logs (run_id, event, message) values
    (p_run_id, 'manual_activity_report', p_activity_type || ': ' || p_status || '. User report only; AWS outcome is not independently verified.');
end;
$$;

create function public.report_authentication(p_run_id uuid, p_status text)
returns void language plpgsql security invoker set search_path = '' as $$
declare
  v_run public.daily_runs%rowtype;
  v_complete boolean;
begin
  if p_status is null or p_status not in ('auth_required', 'confirmed') then
    raise exception 'Invalid authentication report';
  end if;
  select * into strict v_run from public.daily_runs where id = p_run_id for update;
  if v_run.local_date <> (now() at time zone 'Asia/Manila')::date then
    raise exception 'Historic authentication cannot be reported as current';
  end if;
  if v_run.status = 'complete' then
    raise exception 'A completed run cannot be changed';
  end if;
  select bool_and(status = 'user_reported') into v_complete
    from public.post_activities where run_id = p_run_id;
  update public.daily_runs set
    status = case when p_status = 'auth_required' then 'auth_required'
      when v_complete then 'complete' when post_id is null then 'no_post' else 'pending_review' end,
    error_message = case when p_status = 'auth_required' then 'Sign in to AWS in your browser and confirm access manually.' else null end,
    completed_at = case when p_status = 'confirmed' and (v_complete or post_id is null) then now() else null end
    where id = p_run_id;
  insert into public.execution_logs (run_id, event, message) values
    (p_run_id, 'manual_authentication_report', p_status || '. AWS session is not inspected by this application.');
end;
$$;

create function public.replace_post(p_run_id uuid)
returns void language plpgsql security invoker set search_path = '' as $$
declare
  v_run public.daily_runs%rowtype;
  v_post public.queued_posts%rowtype;
begin
  select * into strict v_run from public.daily_runs where id = p_run_id for update;
  if v_run.local_date <> (now() at time zone 'Asia/Manila')::date or v_run.post_id is null then
    raise exception 'Only today''s assigned candidate can be replaced';
  end if;
  if exists (select 1 from public.post_activities where run_id = p_run_id
    and activity_type in ('like', 'comment') and status in ('user_reported', 'uncertain')) then
    raise exception 'Resolve completed or uncertain engagement manually; replacement is blocked';
  end if;
  select * into v_post from public.queued_posts where state = 'available'
    order by created_at, id limit 1 for update skip locked;
  if not found then raise exception 'No unused replacement post is queued'; end if;
  insert into public.execution_logs (run_id, event, message)
    select p_run_id, 'replaced_activity_snapshot',
      jsonb_build_object('type', activity_type, 'post_url', post_url, 'status', status,
        'attempted_at', attempted_at, 'message', message)::text
    from public.post_activities where run_id = p_run_id and activity_type in ('like', 'comment');
  update public.queued_posts set state = 'used' where id = v_run.post_id;
  update public.queued_posts set state = 'reserved' where id = v_post.id;
  update public.daily_runs set post_id = v_post.id, post_url = v_post.url,
    post_title = v_post.title,
    status = case when v_run.status = 'auth_required' then 'auth_required' else 'pending_review' end,
    error_message = case when v_run.status = 'auth_required' then v_run.error_message else null end,
    completed_at = null
    where id = p_run_id;
  update public.post_activities set post_url = v_post.url,
    status = case when activity_type = 'visit' then status else 'pending' end,
    attempted_at = case when activity_type = 'visit' then attempted_at else null end,
    message = case when activity_type = 'visit' then message else null end where run_id = p_run_id;
  insert into public.execution_logs (run_id, event, message) values
    (p_run_id, 'post_replaced', 'Previous candidate permanently consumed. New candidate queued for manual review.');
end;
$$;

create function public.claim_notification(p_run_id uuid, p_kind text default 'review')
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_config public.app_config%rowtype;
  v_run public.daily_runs%rowtype;
  v_delivery public.notification_deliveries%rowtype;
begin
  if p_kind is null or p_kind not in ('review', 'auth_required', 'activity_failed') then
    raise exception 'Invalid notification kind';
  end if;
  -- Match prepare_daily_run lock order to avoid config/run lock inversion.
  select * into strict v_config from public.app_config where id = 1 for update;
  select * into strict v_run from public.daily_runs where id = p_run_id for update;
  if v_run.local_date <> (now() at time zone 'Asia/Manila')::date then return null; end if;
  if not v_config.notifications_enabled then
    if p_kind = 'review' and v_run.notification_status = 'pending' then
      update public.daily_runs set notification_status = 'disabled' where id = p_run_id;
    end if;
    return null;
  end if;
  insert into public.notification_deliveries (run_id, kind) values (p_run_id, p_kind)
    on conflict (run_id, kind) do nothing;
  update public.notification_deliveries set status = 'sending', claimed_at = now()
    where run_id = p_run_id and kind = p_kind and status = 'pending' returning * into v_delivery;
  if not found then return null; end if;
  if p_kind = 'review' then
    update public.daily_runs set notification_status = 'sending' where id = p_run_id returning * into v_run;
  end if;
  insert into public.execution_logs (run_id, event, message) values
    (p_run_id, 'notification_claimed', p_kind || ': sending. A repeated invocation must not resend.');
  return to_jsonb(v_run);
end;
$$;

create function public.finish_notification(p_run_id uuid, p_status text, p_message text, p_kind text default 'review')
returns void language plpgsql security invoker set search_path = '' as $$
declare
  v_delivery public.notification_deliveries%rowtype;
begin
  if p_kind is null or p_kind not in ('review', 'auth_required', 'activity_failed')
    or p_status is null or p_status not in ('sent', 'failed', 'uncertain')
    or length(coalesce(p_message, '')) > 300 then raise exception 'Invalid notification result'; end if;
  perform 1 from public.daily_runs where id = p_run_id for update;
  select * into strict v_delivery from public.notification_deliveries
    where run_id = p_run_id and kind = p_kind for update;
  if v_delivery.status = p_status then return; end if;
  if v_delivery.status <> 'sending' then raise exception 'Notification was not claimed or already settled'; end if;
  update public.notification_deliveries set status = p_status, finished_at = now(),
    message = nullif(coalesce(p_message, ''), '') where id = v_delivery.id;
  if p_kind = 'review' then
    update public.daily_runs set notification_status = p_status where id = p_run_id;
  end if;
  insert into public.execution_logs (run_id, event, message) values
    (p_run_id, 'notification_result', p_kind || ': ' || p_status || '. ' || coalesce(p_message, ''));
end;
$$;

-- PostgreSQL grants function execution to PUBLIC by default. Deny browser roles.
revoke all on function public.prepare_daily_run(date, timestamptz, boolean),
  public.report_activity(uuid, text, text, text), public.report_authentication(uuid, text),
  public.replace_post(uuid), public.claim_notification(uuid, text),
  public.finish_notification(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.prepare_daily_run(date, timestamptz, boolean),
  public.report_activity(uuid, text, text, text), public.report_authentication(uuid, text),
  public.replace_post(uuid), public.claim_notification(uuid, text),
  public.finish_notification(uuid, text, text, text) to service_role;

commit;
