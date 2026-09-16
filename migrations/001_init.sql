-- Stage 1 schema: accounts, transactions, balances, sync runs, users.
-- Targets PostgreSQL 18 on Render. gen_random_uuid() is built in since 13, so
-- no extension is needed.

create table users (
  id             uuid primary key default gen_random_uuid(),
  email          text not null unique,
  password_hash  text not null,
  created_at     timestamptz not null default now()
);

-- Accounts come from Redbark, or are created by hand later (an ING personal
-- loan that open banking does not expose, for example). Role and is_liquid are
-- set through the UI and never hardcoded, so account numbers stay out of the
-- source.
create table accounts (
  id                     uuid primary key default gen_random_uuid(),
  source                 text not null default 'redbark' check (source in ('redbark', 'manual')),
  redbark_connection_id  text,
  redbark_account_id     text unique,
  bank                   text not null,
  name                   text not null,
  masked_number          text,
  -- What the bank calls it, for example transaction or loan.
  type                   text,
  -- What it means to us. Null until someone sets it in the UI.
  role                   text check (role in (
                           'joint_everyday', 'personal_everyday',
                           'personal_savings', 'mortgage', 'other'
                         )),
  is_liquid              boolean not null default false,
  currency               text not null default 'aud',
  -- Redbark's view of the account, for example available.
  status                 text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  -- A redbark account must carry its redbark id, a manual one must not.
  constraint accounts_source_ids check (
    (source = 'redbark' and redbark_account_id is not null)
    or (source = 'manual' and redbark_account_id is null)
  )
);

create index accounts_role_idx on accounts (role);

create table transactions (
  id                   uuid primary key default gen_random_uuid(),
  account_id           uuid not null references accounts (id) on delete cascade,
  redbark_txn_id       text not null,
  status               text not null check (status in ('pending', 'posted')),
  txn_date             date not null,
  posted_date          date,
  description          text not null default '',
  -- Negative is money out. On a loan account the sign inverts in meaning: a
  -- repayment arrives positive because it reduces the debt, and interest
  -- charged is negative. That is what makes a mortgage repayment pair up as
  -- equal and opposite against the ING side.
  amount               numeric(12,2) not null,
  -- Extra provider fields. They cost nothing to keep and they carry the hints
  -- that transfer matching relies on.
  direction            text,
  reference            text,
  extended_description text,
  merchant_name        text,
  provider_category    text,
  raw                  jsonb not null,
  is_transfer          boolean not null default false,
  transfer_pair_id     uuid references transactions (id) on delete set null,
  transfer_confidence  text check (transfer_confidence in ('auto', 'confirmed', 'rejected')),
  -- Stage 2 will add the categories table. The column exists now so the join
  -- can be added without touching this table again.
  category_id          uuid,
  first_seen_at        timestamptz not null default now(),
  last_seen_at         timestamptz not null default now(),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint transactions_account_redbark_id_key unique (account_id, redbark_txn_id)
);

create index transactions_account_date_idx on transactions (account_id, txn_date desc);
create index transactions_date_idx on transactions (txn_date desc);
create index transactions_status_idx on transactions (status);
-- Transfer detection scans unpaired rows by amount and date.
create index transactions_unpaired_idx on transactions (amount, txn_date)
  where transfer_pair_id is null;

-- One balance snapshot per account per day, upserted through the day.
create table balances (
  id                uuid primary key default gen_random_uuid(),
  account_id        uuid not null references accounts (id) on delete cascade,
  balance_date      date not null,
  balance           numeric(12,2),
  available_balance numeric(12,2),
  -- When the bank actually observed it, and whether Redbark considers that
  -- reading fresh, stale or unavailable.
  observed_at       timestamptz,
  freshness         text,
  captured_at       timestamptz not null default now(),
  constraint balances_account_date_key unique (account_id, balance_date)
);

-- Rejecting a transfer is about the pair, not the rows. A transaction wrongly
-- offered against one counterpart must still be pairable with the right one,
-- so the rejection is stored per pair. Rows are held in a stable order so a
-- pair is recorded once whichever way round it is offered.
create table transfer_rejections (
  txn_low_id   uuid not null references transactions (id) on delete cascade,
  txn_high_id  uuid not null references transactions (id) on delete cascade,
  rejected_at  timestamptz not null default now(),
  primary key (txn_low_id, txn_high_id),
  constraint transfer_rejections_ordered check (txn_low_id < txn_high_id)
);

create table sync_runs (
  id                 uuid primary key default gen_random_uuid(),
  started_at         timestamptz not null default now(),
  finished_at        timestamptz,
  status             text not null default 'running' check (status in ('running', 'success', 'partial', 'failed')),
  accounts_synced    integer not null default 0,
  txns_inserted      integer not null default 0,
  txns_updated       integer not null default 0,
  pending_resolved   integer not null default 0,
  pending_expired    integer not null default 0,
  transfers_detected integer not null default 0,
  error_message      text
);

create index sync_runs_started_idx on sync_runs (started_at desc);
