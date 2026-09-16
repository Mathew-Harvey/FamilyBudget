-- Identifying merchants is its own kind of analysis.
alter table analyses drop constraint if exists analyses_kind_check;
alter table analyses
  add constraint analyses_kind_check check (kind in (
    'periodic', 'on_demand', 'question', 'expense_plan', 'afford', 'merchants'
  ));
