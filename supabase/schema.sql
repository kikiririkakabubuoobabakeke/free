-- 日記アプリの同期先。Supabase の SQL Editor に貼り付けて1回実行する。
-- 何度実行しても同じ結果になるように書いてある。

-- 端末内のどの表の行も、この1つの表に (種類, id, 中身のJSON) として置く。
create sequence if not exists public.records_seq;

create table if not exists public.records (
  user_id    uuid    not null default auth.uid() references auth.users (id) on delete cascade,
  kind       text    not null,
  id         text    not null,
  data       jsonb   not null,
  updated_at bigint  not null,              -- 端末で最後に変更した時刻(ミリ秒)
  deleted    boolean not null default false,
  seq        bigint  not null default nextval('public.records_seq'),
  primary key (user_id, kind, id)
);

create index if not exists records_user_seq on public.records (user_id, seq);

-- 書き込みのたびに通し番号を振り直す。端末は「前回受け取った番号より後」だけを取りに来る。
-- すでにある行より古い変更が後から届いた場合は、その書き込みを捨てる。
create or replace function public.records_before_write()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' and new.updated_at < old.updated_at then
    return null;
  end if;
  new.seq := nextval('public.records_seq');
  return new;
end;
$$;

drop trigger if exists records_before_write on public.records;
create trigger records_before_write
  before insert or update on public.records
  for each row execute function public.records_before_write();

-- 自分の行だけ読み書きできる。
alter table public.records enable row level security;

drop policy if exists "own records" on public.records;
create policy "own records" on public.records
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

grant usage on sequence public.records_seq to authenticated;

-- 未ログインでも表への問い合わせ自体はできるようにする（行は上の決まりで1件も見えない）。
-- プロジェクトを止めないための定期的な問い合わせ（.github/workflows/keepalive.yml）が使う。
grant select on public.records to anon;

-- 写真の置き場。非公開で、"ユーザーID/写真ID" というパスに置く。
insert into storage.buckets (id, name, public)
values ('attachments', 'attachments', false)
on conflict (id) do nothing;

drop policy if exists "own attachments" on storage.objects;
create policy "own attachments" on storage.objects
  for all to authenticated
  using (bucket_id = 'attachments' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'attachments' and (storage.foldername(name))[1] = (select auth.uid())::text);
