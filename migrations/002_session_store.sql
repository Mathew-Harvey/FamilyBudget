-- Session table for connect-pg-simple. This is the library's own schema, kept
-- here as a migration so the database is built by one mechanism rather than
-- letting the library create tables at boot.
create table "session" (
  "sid"    varchar not null collate "default",
  "sess"   json not null,
  "expire" timestamp(6) not null
);

alter table "session"
  add constraint "session_pkey" primary key ("sid") not deferrable initially immediate;

create index "IDX_session_expire" on "session" ("expire");
